"""Finix domain models extracted from backend/accounting_extended.py."""
import io
import uuid
import pandas as pd
from datetime import date, datetime, timezone
from typing import Optional, List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from pydantic import BaseModel, Field, ConfigDict

from backend.dependencies import db, get_current_user
from backend.models import User
from backend.accounting_core import get_default_account_id

router = APIRouter(tags=["Accounting Extended"])

class OpeningBalanceLine(BaseModel):
    account_id: str
    debit: float = 0.0
    credit: float = 0.0

class OpeningBalanceRequest(BaseModel):
    company_id: str = ""
    fy: str          # e.g. "2024-25"
    date: str        # YYYY-MM-DD, typically April 1 of FY start
    lines: List[OpeningBalanceLine]


@router.get("/opening-balances")
async def get_opening_balances(
    company_id: str = Query(""),
    fy: str = Query(None),
    current_user: User = Depends(get_current_user),
):
    if not _can_reports(current_user):
        raise HTTPException(403, "Access denied.")
    q: dict = {"company_id": company_id}
    if fy:
        q["fy"] = fy
    rows = await db.opening_balances.find(q, {"_id": 0}).to_list(2000)

    # Enrich with account names
    acct_ids = list({r["account_id"] for r in rows})
    accounts = await db.chart_of_accounts.find({"id": {"$in": acct_ids}}, {"_id": 0}).to_list(2000)
    acct_map = {a["id"]: a for a in accounts}
    for r in rows:
        a = acct_map.get(r["account_id"], {})
        r["account_code"] = a.get("code", "")
        r["account_name"] = a.get("name", "")
    return {"opening_balances": rows}


@router.post("/opening-balances")
async def set_opening_balances(
    req: OpeningBalanceRequest,
    current_user: User = Depends(get_current_user),
):
    if not _can_manage(current_user):
        raise HTTPException(403, "Access denied.")

    total_dr = _round2(sum(l.debit for l in req.lines))
    total_cr = _round2(sum(l.credit for l in req.lines))
    if abs(total_dr - total_cr) > 0.05:
        raise HTTPException(400, f"Opening balances must be balanced. Debit {total_dr} ≠ Credit {total_cr}")

    saved = []
    for line in req.lines:
        if line.debit == 0 and line.credit == 0:
            continue
        doc = {
            "id": str(uuid.uuid4()),
            "company_id": req.company_id,
            "fy": req.fy,
            "account_id": line.account_id,
            "debit": _round2(line.debit),
            "credit": _round2(line.credit),
            "date": req.date,
            "created_by": str(current_user.id),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await db.opening_balances.update_one(
            {"company_id": req.company_id, "fy": req.fy, "account_id": line.account_id},
            {"$set": doc},
            upsert=True,
        )
        saved.append(doc)

    # Post as a journal entry (source=opening_balance, idempotent per fy)
    ik = f"ob_{req.company_id}_{req.fy}"
    existing = await db.journal_entries.find_one({"idempotency_key": ik})
    if not existing:
        entry_id = str(uuid.uuid4())
        now_iso = datetime.now(timezone.utc).isoformat()
        await db.journal_entries.insert_one({
            "id": entry_id, "company_id": req.company_id, "fy": req.fy,
            "entry_date": req.date, "narration": f"Opening balances for FY {req.fy}",
            "source": "opening_balance", "idempotency_key": ik,
            "posted_by": str(current_user.id), "created_at": now_iso,
        })
        for line in req.lines:
            if line.debit == 0 and line.credit == 0:
                continue
            await db.journal_lines.insert_one({
                "id": str(uuid.uuid4()), "entry_id": entry_id,
                "company_id": req.company_id, "account_id": line.account_id,
                "debit": _round2(line.debit), "credit": _round2(line.credit),
                "entry_date": req.date, "memo": f"OB {req.fy}",
                "created_at": now_iso,
            })

    await _audit(req.company_id, str(current_user.id), "set_opening_balances", "opening_balances", req.fy, {"fy": req.fy, "lines": len(saved)})
    return {"saved": len(saved), "fy": req.fy}


# ─────────────────────────────────────────────────────────────────────────────
# Bank Reconciliation
# ─────────────────────────────────────────────────────────────────────────────

def _sniff_delimited_table(file_bytes: bytes) -> Optional["pd.DataFrame"]:
    """Many Indian bank exports (SBI, HDFC, ICICI...) label a plain tab- or
    comma-delimited text file with a `.xls` extension, and prefix the real
    transaction table with a dozen+ lines of account-info banner. This
    can't be read by pd.read_excel (it isn't a real Excel file), so we
    decode it as text, find the header row by looking for the line that
    contains both a date-like column and an amount-like column, and parse
    from there.
    """
    for encoding in ('utf-8', 'utf-8-sig', 'latin-1'):
        try:
            text = file_bytes.decode(encoding)
            break
        except Exception:
            text = None
    if text is None:
        return None

    lines = text.splitlines()
    header_idx = None
    delimiter = None
    for i, line in enumerate(lines):
        low = line.lower()
        has_date = any(k in low for k in ('date', 'txn date', 'value date'))
        has_amount = any(k in low for k in ('debit', 'credit', 'withdrawal', 'deposit'))
        if has_date and has_amount:
            header_idx = i
            delimiter = '\t' if line.count('\t') >= line.count(',') else ','
            break
    if header_idx is None:
        return None

    try:
        return pd.read_csv(
            io.StringIO(text), sep=delimiter, skiprows=header_idx,
            dtype=str, engine='python', on_bad_lines='skip',
        )
    except Exception:
        return None


def _parse_bank_statement(file_bytes: bytes, filename: str) -> List[dict]:
    """Parse CSV / Excel bank statement into list of {date, narration, debit, credit, balance}."""
    fname = filename.lower()
    rows = []

    try:
        if fname.endswith(('.xlsx', '.xls')):
            try:
                df = pd.read_excel(io.BytesIO(file_bytes), dtype=str)
            except Exception:
                # Not a real Excel file — likely a delimited text export
                # mislabeled with an .xls extension. Fall back to sniffing.
                df = _sniff_delimited_table(file_bytes)
                if df is None:
                    return []
        elif fname.endswith('.csv'):
            df = pd.read_csv(io.BytesIO(file_bytes), dtype=str, encoding='utf-8', on_bad_lines='skip')
        elif fname.endswith('.pdf'):
            # For PDF, attempt text extraction and basic CSV parsing
            try:
                import pdfplumber
                text_rows = []
                with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
                    for page in pdf.pages:
                        for row in (page.extract_table() or []):
                            if row:
                                text_rows.append([str(c or '').strip() for c in row])
                if len(text_rows) > 1:
                    df = pd.DataFrame(text_rows[1:], columns=text_rows[0])
                else:
                    return []
            except Exception:
                return []
        else:
            # Try CSV as fallback
            df = pd.read_csv(io.BytesIO(file_bytes), dtype=str, encoding='utf-8', on_bad_lines='skip')

        df.columns = [str(c).strip().lower().replace(' ', '_') for c in df.columns]

        # Map common column name variants. Short abbreviations ('cr', 'dr')
        # must match a whole underscore-delimited token, not just appear as
        # a substring — otherwise e.g. "description" (which contains "cr")
        # gets mistaken for the credit column and every credit amount
        # silently parses as 0.
        def _col_matches(col: str, keywords: List[str]) -> bool:
            tokens = col.split('_')
            for k in keywords:
                if len(k.rstrip('.')) <= 3:
                    if k.rstrip('.') in tokens:
                        return True
                elif k in col:
                    return True
            return False

        col_map = {}
        for col in df.columns:
            if _col_matches(col, ['date', 'txn_date', 'value_date', 'posting']):
                col_map.setdefault('date', col)
            if _col_matches(col, ['narration', 'description', 'particulars', 'remarks', 'details']):
                col_map.setdefault('narration', col)
            if _col_matches(col, ['debit', 'withdrawal', 'dr', 'dr.']):
                col_map.setdefault('debit', col)
            if _col_matches(col, ['credit', 'deposit', 'cr', 'cr.']):
                col_map.setdefault('credit', col)
            if _col_matches(col, ['balance', 'closing', 'running']):
                col_map.setdefault('balance', col)

        for _, row in df.iterrows():
            raw_date = str(row.get(col_map.get('date', ''), '')).strip()
            if not raw_date or raw_date.lower() in ('nan', 'none', ''):
                continue
            # Parse date flexibly
            parsed_date = None
            for fmt in ('%d/%m/%Y', '%d-%m-%Y', '%Y-%m-%d', '%d %b %Y', '%d-%b-%Y', '%m/%d/%Y'):
                try:
                    parsed_date = datetime.strptime(raw_date, fmt).strftime('%Y-%m-%d')
                    break
                except Exception:
                    pass
            if not parsed_date:
                continue

            def _num(v):
                try:
                    s = str(v).replace(',', '').replace('(', '-').replace(')', '').strip()
                    return float(s) if s and s not in ('nan', 'none', '') else 0.0
                except Exception:
                    return 0.0

            rows.append({
                "id": str(uuid.uuid4()),
                "statement_date": parsed_date,
                "narration": str(row.get(col_map.get('narration', ''), '')).strip()[:500],
                "debit":   _num(row.get(col_map.get('debit', ''), 0)),
                "credit":  _num(row.get(col_map.get('credit', ''), 0)),
                "balance": _num(row.get(col_map.get('balance', ''), 0)),
                "matched": False,
                "matched_entry_id": None,
            })
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning(f"[bank_recon] parse error: {e}")

    return rows


@router.post("/bank-reconciliation/upload")
async def upload_bank_statement(
    bank_account_id: str = Form(...),
    company_id: str = Form(""),
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    if not _can_manage(current_user):
        raise HTTPException(403, "Access denied.")

    contents = await file.read()
    rows = _parse_bank_statement(contents, file.filename or "statement.csv")
    if not rows:
        raise HTTPException(400, "Could not parse bank statement. Ensure it is CSV or Excel with date/narration/debit/credit columns.")

    now_iso = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": str(uuid.uuid4()),
        "bank_account_id": bank_account_id,
        "company_id": company_id,
        "filename": file.filename,
        "uploaded_by": str(current_user.id),
        "uploaded_at": now_iso,
        "rows": rows,
        "total_rows": len(rows),
        "matched_rows": 0,
    }
    await db.bank_reconciliation.insert_one({"_id": doc["id"], **doc})
    await _audit(company_id, str(current_user.id), "upload_bank_statement", "bank_reconciliation", doc["id"], {"filename": file.filename, "rows": len(rows)})
    return {"statement_id": doc["id"], "total_rows": len(rows), "filename": file.filename}


@router.get("/bank-reconciliation/{bank_account_id}")
async def get_reconciliation(
    bank_account_id: str,
    company_id: str = Query(""),
    current_user: User = Depends(get_current_user),
):
    if not _can_reports(current_user):
        raise HTTPException(403, "Access denied.")

    statements = await db.bank_reconciliation.find(
        {"bank_account_id": bank_account_id},
        {"_id": 0}
    ).sort("uploaded_at", -1).to_list(20)

    # Also fetch journal lines for cash/bank accounts for auto-suggestion
    # Find cash/bank account linked to this bank account
    bank_acct = await db.bank_accounts.find_one({"id": bank_account_id}, {"_id": 0})
    ledger_account_id = bank_acct.get("ledger_account_id") if bank_acct else None

    unmatched_journal = []
    if ledger_account_id:
        # Recent unmatched journal lines for this bank account
        uj = await db.journal_lines.find(
            {"company_id": company_id, "account_id": ledger_account_id, "reconciled": {"$ne": True}},
            {"_id": 0}
        ).sort("entry_date", -1).limit(500).to_list(500)
        unmatched_journal = uj

    return {
        "bank_account_id": bank_account_id,
        "statements": statements,
        "unmatched_journal_lines": unmatched_journal,
    }

class MatchRequest(BaseModel):
    statement_id: str
    row_id: str
    entry_id: str
    line_id: str = ""

@router.post("/bank-reconciliation/{bank_account_id}/match")
async def match_reconciliation(
    bank_account_id: str,
    req: MatchRequest,
    current_user: User = Depends(get_current_user),
):
    if not _can_manage(current_user):
        raise HTTPException(403, "Access denied.")

    # Mark row as matched in statement
    await db.bank_reconciliation.update_one(
        {"id": req.statement_id, "rows.id": req.row_id},
        {"$set": {"rows.$.matched": True, "rows.$.matched_entry_id": req.entry_id}},
    )
    # Optionally mark journal line as reconciled
    if req.line_id:
        await db.journal_lines.update_one(
            {"id": req.line_id},
            {"$set": {"reconciled": True, "reconciled_statement_id": req.statement_id}},
        )
    await _audit("", str(current_user.id), "match_reconciliation", "bank_reconciliation", req.statement_id, {"row_id": req.row_id})
    return {"matched": True}


@router.post("/bank-reconciliation/{bank_account_id}/unmatch")
async def unmatch_reconciliation(
    bank_account_id: str,
    req: MatchRequest,
    current_user: User = Depends(get_current_user),
):
    if not _can_manage(current_user):
        raise HTTPException(403, "Access denied.")

    await db.bank_reconciliation.update_one(
        {"id": req.statement_id, "rows.id": req.row_id},
        {"$set": {"rows.$.matched": False, "rows.$.matched_entry_id": None}},
    )
    if req.line_id:
        await db.journal_lines.update_one(
            {"id": req.line_id},
            {"$set": {"reconciled": False, "reconciled_statement_id": None}},
        )
    return {"unmatched": True}


# ─────────────────────────────────────────────────────────────────────────────
# Depreciation
# ─────────────────────────────────────────────────────────────────────────────

class FixedAssetRequest(BaseModel):
    company_id: str = ""
    name: str
    purchase_date: str
    cost: float
    salvage_value: float = 0.0
    useful_life_years: int = 5
    method: str = "straight_line"   # straight_line | declining_balance | wdv
    asset_account_id: str = ""      # COA account for the fixed asset
    depreciation_account_id: str = ""  # COA account for depreciation expense


@router.post("/depreciation/asset")
async def add_fixed_asset(
    req: FixedAssetRequest,
    current_user: User = Depends(get_current_user),
):
    if not _can_manage(current_user):
        raise HTTPException(403, "Access denied.")
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": req.company_id,
        "name": req.name,
        "purchase_date": req.purchase_date,
        "cost": _round2(req.cost),
        "salvage_value": _round2(req.salvage_value),
        "useful_life_years": req.useful_life_years,
        "method": req.method,
        "asset_account_id": req.asset_account_id,
        "depreciation_account_id": req.depreciation_account_id,
        "accumulated_depreciation": 0.0,
        "book_value": _round2(req.cost),
        "status": "active",
        "created_by": str(current_user.id),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.fixed_assets.insert_one({"_id": doc["id"], **doc})
    await _audit(req.company_id, str(current_user.id), "add_fixed_asset", "fixed_assets", doc["id"], {"name": req.name, "cost": req.cost})
    return doc


@router.get("/depreciation/schedule")
async def depreciation_schedule(
    company_id: str = Query(""),
    current_user: User = Depends(get_current_user),
):
    if not _can_reports(current_user):
        raise HTTPException(403, "Access denied.")
    assets = await db.fixed_assets.find({"company_id": company_id}, {"_id": 0}).to_list(500)
    result = []
    for asset in assets:
        cost = float(asset.get("cost", 0))
        salvage = float(asset.get("salvage_value", 0))
        life = int(asset.get("useful_life_years", 5))
        method = asset.get("method", "straight_line")
        dep_base = cost - salvage
        annual_dep = 0.0
        if method == "straight_line" and life > 0:
            annual_dep = _round2(dep_base / life)
        elif method in ("declining_balance", "wdv") and life > 0:
            rate = 1 - (salvage / cost) ** (1 / life) if cost > 0 else 0
            annual_dep = _round2(float(asset.get("book_value", cost)) * rate)

        schedule_rows = []
        bv = cost
        for yr in range(1, life + 1):
            if method == "straight_line":
                dep = min(annual_dep, bv - salvage)
            else:
                dep = _round2(bv * (1 - (salvage / cost) ** (1 / life)) if cost > 0 else 0)
                dep = min(dep, bv - salvage)
            dep = max(dep, 0)
            bv = _round2(bv - dep)
            schedule_rows.append({"year": yr, "depreciation": dep, "closing_book_value": bv})

        result.append({
            "id": asset.get("id"),
            "name": asset.get("name"),
            "purchase_date": asset.get("purchase_date"),
            "cost": cost,
            "salvage_value": salvage,
            "useful_life_years": life,
            "method": method,
            "accumulated_depreciation": float(asset.get("accumulated_depreciation", 0)),
            "book_value": float(asset.get("book_value", cost)),
            "status": asset.get("status", "active"),
            "schedule": schedule_rows,
        })
    return {"assets": result}


@router.post("/depreciation/run")
async def run_depreciation(
    company_id: str = Form(""),
    period_end: str = Form(...),   # YYYY-MM-DD
    fy: str = Form(None),
    current_user: User = Depends(get_current_user),
):
    """Run depreciation for all active fixed assets up to period_end. Posts journal entries."""
    if not _can_manage(current_user):
        raise HTTPException(403, "Access denied.")
    assets = await db.fixed_assets.find({"company_id": company_id, "status": "active"}, {"_id": 0}).to_list(500)
    posted = []
    now_iso = datetime.now(timezone.utc).isoformat()

    for asset in assets:
        # Calculate depreciation for this period (monthly pro-rated)
        try:
            purchase = date.fromisoformat(asset["purchase_date"])
            period = date.fromisoformat(period_end)
            months_elapsed = (period.year - purchase.year) * 12 + (period.month - purchase.month)
            life_months = int(asset.get("useful_life_years", 5)) * 12
            if months_elapsed <= 0 or months_elapsed > life_months:
                continue
        except Exception:
            continue

        dep_base = float(asset["cost"]) - float(asset.get("salvage_value", 0))
        monthly_dep = _round2(dep_base / (int(asset.get("useful_life_years", 5)) * 12))
        if monthly_dep <= 0:
            continue

        # Idempotent: skip if already run for this period
        ik = f"dep_{asset['id']}_{period_end}"
        existing = await db.journal_entries.find_one({"idempotency_key": ik})
        if existing:
            continue

        entry_id = str(uuid.uuid4())
        await db.journal_entries.insert_one({
            "id": entry_id, "company_id": company_id,
            "entry_date": period_end, "fy": fy,
            "narration": f"Depreciation — {asset['name']} for {period_end[:7]}",
            "source": "depreciation", "idempotency_key": ik,
            "posted_by": str(current_user.id), "created_at": now_iso,
        })
        # asset.depreciation_account_id / asset_account_id are expected to
        # already be real chart_of_accounts ids when explicitly set on the
        # asset; the fallback must resolve the default code ("5500" / "1300")
        # to its real id the same way — posting the literal code string as
        # account_id makes the entry invisible to Trial Balance/Balance
        # Sheet/P&L, since reports join on chart_of_accounts.id, not code.
        dep_acct = asset.get("depreciation_account_id") or await get_default_account_id(company_id, "5500")
        asset_acct = asset.get("asset_account_id") or await get_default_account_id(company_id, "1300")
        if not dep_acct or not asset_acct:
            continue
        for line_acct, dr, cr in [(dep_acct, monthly_dep, 0), (asset_acct, 0, monthly_dep)]:
            await db.journal_lines.insert_one({
                "id": str(uuid.uuid4()), "entry_id": entry_id, "company_id": company_id,
                "account_id": line_acct, "debit": dr, "credit": cr,
                "entry_date": period_end, "memo": f"Dep {asset['name']}",
                "created_at": now_iso,
            })

        # Update asset book value
        new_bv = _round2(float(asset.get("book_value", asset["cost"])) - monthly_dep)
        new_accum = _round2(float(asset.get("accumulated_depreciation", 0)) + monthly_dep)
        await db.fixed_assets.update_one(
            {"id": asset["id"]},
            {"$set": {"book_value": new_bv, "accumulated_depreciation": new_accum}},
        )
        posted.append({"asset": asset["name"], "depreciation": monthly_dep, "entry_id": entry_id})

    await _audit(company_id, str(current_user.id), "run_depreciation", "depreciation", period_end, {"posted": len(posted)})
    return {"period_end": period_end, "posted": len(posted), "entries": posted}


# ─────────────────────────────────────────────────────────────────────────────
# TDS / TCS
# ─────────────────────────────────────────────────────────────────────────────

class TDSTCSEntry(BaseModel):
    company_id: str = ""
    entry_date: str
    party_name: str
    party_pan: str = ""
    section: str    # e.g. "194C", "194J", "1%TCS"
    base_amount: float
    tds_rate: float   # percent e.g. 10 for 10%
    tds_amount: float
    payment_type: str = "tds"  # tds | tcs
    status: str = "deducted"   # deducted | deposited
    challan_no: str = ""


@router.post("/tds-tcs/entry")
async def record_tds_tcs(
    req: TDSTCSEntry,
    current_user: User = Depends(get_current_user),
):
    if not _can_post(current_user):
        raise HTTPException(403, "Access denied.")
    doc = {
        "id": str(uuid.uuid4()),
        **req.model_dump(),
        "tds_amount": _round2(req.tds_amount),
        "base_amount": _round2(req.base_amount),
        "created_by": str(current_user.id),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.tds_tcs_entries.insert_one({"_id": doc["id"], **doc})

    # Post journal entry: Dr. Party A/c, Cr. TDS Payable
    entry_id = str(uuid.uuid4())
    now_iso = doc["created_at"]
    await db.journal_entries.insert_one({
        "id": entry_id, "company_id": req.company_id,
        "entry_date": req.entry_date,
        "narration": f"{'TDS' if req.payment_type == 'tds' else 'TCS'} u/s {req.section} on {req.party_name} — ₹{req.tds_amount:,.2f}",
        "source": "tds_tcs", "posted_by": str(current_user.id), "created_at": now_iso,
    })
    # TDS Payable account = "2200", Accounts Payable = "2000". Resolve to the
    # real chart_of_accounts id (not the literal code) — journal_lines.account_id
    # must match chart_of_accounts.id or these lines silently vanish from
    # Trial Balance / Balance Sheet / P&L, since every report looks entries up
    # by real account id, never by code.
    tds_payable_id = await get_default_account_id(req.company_id, "2200")
    payable_id = await get_default_account_id(req.company_id, "2000")
    for acct, dr, cr in [(tds_payable_id, 0, req.tds_amount), (payable_id, req.tds_amount, 0)]:
        if not acct:
            continue
        await db.journal_lines.insert_one({
            "id": str(uuid.uuid4()), "entry_id": entry_id,
            "company_id": req.company_id, "account_id": acct,
            "debit": _round2(dr), "credit": _round2(cr),
            "entry_date": req.entry_date, "memo": f"{req.section} {req.party_name}",
            "created_at": now_iso,
        })

    return {"id": doc["id"], "entry_id": entry_id}


@router.get("/tds-tcs")
async def get_tds_tcs(
    company_id: str = Query(""),
    from_date: str = Query(None),
    to_date: str = Query(None),
    fy: str = Query(None),
    payment_type: str = Query(None),
    current_user: User = Depends(get_current_user),
):
    if not _can_reports(current_user):
        raise HTTPException(403, "Access denied.")
    fd, td = from_date, to_date
    if not fd or not td:
        fd, td = _fy_dates(fy)

    q: dict = {"company_id": company_id, "entry_date": {"$gte": fd, "$lte": td}}
    if payment_type:
        q["payment_type"] = payment_type

    entries = await db.tds_tcs_entries.find(q, {"_id": 0}).sort("entry_date", 1).to_list(5000)

    tds_total = _round2(sum(e.get("tds_amount", 0) for e in entries if e.get("payment_type") == "tds"))
    tcs_total = _round2(sum(e.get("tds_amount", 0) for e in entries if e.get("payment_type") == "tcs"))
    deposited = _round2(sum(e.get("tds_amount", 0) for e in entries if e.get("status") == "deposited"))
    pending   = _round2(sum(e.get("tds_amount", 0) for e in entries if e.get("status") == "deducted"))

    return {
        "from_date": fd, "to_date": td,
        "summary": {"tds_total": tds_total, "tcs_total": tcs_total, "deposited": deposited, "pending_deposit": pending},
        "entries": entries,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Audit Trail
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/audit-trail")
async def audit_trail(
    company_id: str = Query(""),
    from_date: str = Query(None),
    to_date: str = Query(None),
    entity: str = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, le=200),
    current_user: User = Depends(get_current_user),
):
    if not _can_reports(current_user):
        raise HTTPException(403, "Access denied.")
    q: dict = {"company_id": company_id}
    if from_date:
        q.setdefault("created_at", {})["$gte"] = from_date
    if to_date:
        q.setdefault("created_at", {})["$lte"] = to_date + "T23:59:59"
    if entity:
        q["entity"] = entity

    total = await db.accounting_audit_trail.count_documents(q)
    skip = (page - 1) * page_size
    rows = await db.accounting_audit_trail.find(q, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    return {"total": total, "page": page, "page_size": page_size, "rows": rows}


# ─────────────────────────────────────────────────────────────────────────────
# Bulk Import — async background processing
# ─────────────────────────────────────────────────────────────────────────────

class BulkJournalLine(BaseModel):
    account_id: str
    debit: float = 0.0
    credit: float = 0.0
    memo: str = ""

class BulkJournalEntry(BaseModel):
    entry_date: str
    narration: str
    ref_no: str = ""
    source: str = "bulk_import"
    lines: List[BulkJournalLine]
    idempotency_key: str = ""

class BulkImportRequest(BaseModel):
    company_id: str = ""
    fy: str = ""
    entries: List[BulkJournalEntry]


async def _run_bulk_import(job_id: str, company_id: str, fy: str, entries: list, posted_by: str):
    """Background task: process bulk journal entries one by one, idempotent."""
    total = len(entries)
    done = skipped = errors = 0
    now_iso = datetime.now(timezone.utc).isoformat()

    for e in entries:
        try:
            # Validate balance
            dr = _round2(sum(l.get("debit", 0) for l in e["lines"]))
            cr = _round2(sum(l.get("credit", 0) for l in e["lines"]))
            if abs(dr - cr) > 0.05:
                errors += 1
                continue

            # Idempotency check
            ik = e.get("idempotency_key") or f"bulk_{company_id}_{e['entry_date']}_{e['narration'][:30]}"
            existing = await db.journal_entries.find_one({"idempotency_key": ik})
            if existing:
                skipped += 1
                continue

            entry_id = str(uuid.uuid4())
            await db.journal_entries.insert_one({
                "id": entry_id, "company_id": company_id, "fy": fy,
                "entry_date": e["entry_date"], "narration": e["narration"],
                "ref_no": e.get("ref_no", ""), "source": e.get("source", "bulk_import"),
                "idempotency_key": ik, "posted_by": posted_by,
                "created_at": now_iso,
            })
            for line in e["lines"]:
                if line.get("debit", 0) == 0 and line.get("credit", 0) == 0:
                    continue
                await db.journal_lines.insert_one({
                    "id": str(uuid.uuid4()), "entry_id": entry_id, "company_id": company_id,
                    "account_id": line["account_id"],
                    "debit": _round2(line.get("debit", 0)),
                    "credit": _round2(line.get("credit", 0)),
                    "entry_date": e["entry_date"], "memo": line.get("memo", ""),
                    "created_at": now_iso,
                })
            done += 1
        except Exception as ex:
            errors += 1
            import logging
            logging.getLogger(__name__).warning(f"[bulk_import] {job_id} error: {ex}")

    await db.bulk_import_jobs.update_one(
        {"job_id": job_id},
        {"$set": {"status": "done", "done": done, "skipped": skipped, "errors": errors, "finished_at": datetime.now(timezone.utc).isoformat()}},
    )

