"""Focused compatibility routes for Finix invoice numbering and Excel backup import.

These routes intentionally sit in front of the legacy invoicing router. They fix
only the invoice-number/backup path and leave the existing invoice CRUD and UI
untouched.
"""

import csv
import os
import re
import tempfile
import uuid
from datetime import date, datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from backend.dependencies import db, get_current_user
from backend.invoicing import _next_invoice_no

router = APIRouter(tags=["Invoicing Compatibility"])


def _text(value) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _money(value, default=0.0) -> float:
    if value is None or _text(value) == "":
        return default
    try:
        raw = _text(value).replace(",", "").replace("₹", "").replace("Rs.", "").replace("Rs", "").replace("INR", "")
        return round(float(raw.strip()), 2)
    except Exception:
        return default


def _date(value, default=None) -> str:
    raw = _text(value)
    if not raw:
        return default or date.today().isoformat()
    if " " in raw:
        raw = raw.split(" ", 1)[0]
    for fmt in (
        "%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%d-%m-%y",
        "%m/%d/%Y", "%m-%d-%Y", "%d %b %Y", "%d %B %Y",
    ):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except Exception:
            pass
    return default or date.today().isoformat()


def _norm(value) -> str:
    return re.sub(r"[^a-z0-9]", "", _text(value).lower())


def _header_map(headers):
    return {_norm(h): i for i, h in enumerate(headers) if _text(h)}


def _find_index(hmap, *names):
    wanted = [_norm(x) for x in names]
    for wanted_key in wanted:
        if wanted_key in hmap:
            return hmap[wanted_key]
    for key, idx in hmap.items():
        if any(wanted_key and (wanted_key in key or key in wanted_key) for wanted_key in wanted):
            return idx
    return -1


def _cell(row, idx):
    return _text(row[idx]) if idx >= 0 and idx < len(row) else ""


def _load_rows(path: str, filename: str):
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext == "csv":
        with open(path, "r", encoding="utf-8-sig", newline="") as fh:
            return list(csv.reader(fh))
    try:
        import openpyxl
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        ws = wb.active
        return [list(row) for row in ws.iter_rows(values_only=True)]
    except Exception as exc:
        raise HTTPException(400, f"Unable to read Excel backup: {exc}")


async def _accessible_company(user, company_id: str):
    from backend.invoicing import _master_company_rows
    companies = await _master_company_rows(user)
    if company_id:
        return next((c for c in companies if str(c.get("id")) == str(company_id)), None)
    if len(companies) == 1:
        return companies[0]
    bound = getattr(user, "company_id", None)
    if bound:
        return next((c for c in companies if str(c.get("id")) == str(bound)), None)
    return None


async def _company_from_excel(user, company_fields: dict, requested_company_id: str = ""):
    company = await _accessible_company(user, requested_company_id)
    company_name = _text(company_fields.get("name"))
    company_gstin = _text(company_fields.get("gstin")).upper()

    if company:
        return company
    if not company_name and not company_gstin:
        raise HTTPException(400, "Select the company to import this Excel backup into.")

    # Only search within the tenant-aware database scope.
    clauses = []
    if company_name:
        clauses.append({"name": {"$regex": f"^{re.escape(company_name)}$", "$options": "i"}})
    if company_gstin:
        clauses.append({"gstin": company_gstin})
    existing = await db.companies.find_one({"$or": clauses}, {"_id": 0}) if clauses else None
    if existing:
        return existing

    # Create a missing company only when the workbook actually carries a company identity.
    now = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": str(uuid.uuid4()),
        "name": company_name or company_gstin,
        "gstin": company_gstin,
        "pan": _text(company_fields.get("pan")),
        "address": _text(company_fields.get("address")),
        "city": _text(company_fields.get("city")),
        "state": _text(company_fields.get("state")),
        "pincode": _text(company_fields.get("pincode")),
        "phone": _text(company_fields.get("phone")),
        "email": _text(company_fields.get("email")),
        "created_by": user.id,
        "created_at": now,
        "updated_at": now,
        "status": "active",
        "imported_from": "excel_backup",
    }
    await db.companies.insert_one(doc)
    return {k: v for k, v in doc.items() if k != "_id"}


def _parse_excel(path: str, filename: str) -> dict:
    rows = _load_rows(path, filename)
    if not rows:
        raise HTTPException(400, "The Excel backup is empty.")

    # Find the first useful header row instead of assuming row 1.
    header_pos = -1
    header = []
    for i, row in enumerate(rows[:20]):
        text = " ".join(_norm(x) for x in row)
        if any(k in text for k in ("invoiceno", "invoice", "client", "customer", "party")):
            header_pos = i
            header = list(row)
            break
    if header_pos < 0:
        raise HTTPException(400, "Could not identify the invoice header row in the Excel backup.")

    hmap = _header_map(header)
    idx = {
        "company": _find_index(hmap, "Company Name", "Company", "Firm Name", "Firm"),
        "company_gstin": _find_index(hmap, "Company GSTIN", "Firm GSTIN", "GSTIN", "GST No"),
        "company_pan": _find_index(hmap, "Company PAN", "Firm PAN", "PAN"),
        "company_address": _find_index(hmap, "Company Address", "Firm Address", "Address"),
        "company_city": _find_index(hmap, "Company City", "City"),
        "company_state": _find_index(hmap, "Company State", "State"),
        "company_pincode": _find_index(hmap, "Company Pincode", "Firm Pincode", "Pincode", "PIN"),
        "company_phone": _find_index(hmap, "Company Phone", "Firm Phone", "Phone"),
        "company_email": _find_index(hmap, "Company Email", "Firm Email", "Email"),
        "client": _find_index(hmap, "Client", "Client Name", "Customer", "Customer Name", "Party Name", "Party"),
        "client_gstin": _find_index(hmap, "Client GSTIN", "Customer GSTIN", "Party GSTIN", "GSTIN No"),
        "client_phone": _find_index(hmap, "Client Phone", "Customer Phone", "Mobile", "Phone"),
        "client_email": _find_index(hmap, "Client Email", "Customer Email", "E-Mail", "Email"),
        "client_address": _find_index(hmap, "Client Address", "Customer Address", "Billing Address"),
        "client_state": _find_index(hmap, "Client State", "Customer State", "Place of Supply"),
        "invoice_no": _find_index(hmap, "Invoice No", "Invoice Number", "Bill No", "Bill Number", "Inv No"),
        "date": _find_index(hmap, "Invoice Date", "Bill Date", "Date"),
        "due_date": _find_index(hmap, "Due Date", "Payment Due"),
        "taxable": _find_index(hmap, "Taxable", "Taxable Value", "Taxable Amount", "Basic Amount"),
        "gst": _find_index(hmap, "GST", "Total GST", "GST Amount", "Tax"),
        "cgst": _find_index(hmap, "CGST", "Central Tax"),
        "sgst": _find_index(hmap, "SGST", "State Tax"),
        "igst": _find_index(hmap, "IGST", "Integrated Tax"),
        "total": _find_index(hmap, "Total", "Grand Total", "Invoice Total", "Invoice Value", "Total Amount"),
        "paid": _find_index(hmap, "Paid", "Amount Paid", "Received", "Collections"),
        "balance": _find_index(hmap, "Balance", "Amount Due", "Outstanding", "Due"),
        "status": _find_index(hmap, "Status", "Payment Status"),
        "notes": _find_index(hmap, "Notes", "Remarks", "Narration", "Description"),
    }

    company_fields = {}
    for key, field in (("name", "company"), ("gstin", "company_gstin"), ("pan", "company_pan"),
                       ("address", "company_address"), ("city", "company_city"), ("state", "company_state"),
                       ("pincode", "company_pincode"), ("phone", "company_phone"), ("email", "company_email")):
        value = _cell(rows[header_pos + 1], idx[field]) if header_pos + 1 < len(rows) else ""
        if value:
            company_fields[key] = value

    invoices = []
    clients = {}
    for row in rows[header_pos + 1:]:
        if not any(_text(v) for v in row):
            continue
        client_name = _cell(row, idx["client"])
        invoice_no = _cell(row, idx["invoice_no"])
        if not client_name and not invoice_no:
            continue

        taxable = _money(_cell(row, idx["taxable"]))
        cgst = _money(_cell(row, idx["cgst"]))
        sgst = _money(_cell(row, idx["sgst"]))
        igst = _money(_cell(row, idx["igst"]))
        gst = _money(_cell(row, idx["gst"]))
        if not gst:
            gst = round(cgst + sgst + igst, 2)
        total = _money(_cell(row, idx["total"]))
        if not total:
            total = round(taxable + gst, 2)
        paid = _money(_cell(row, idx["paid"]))
        balance_raw = _cell(row, idx["balance"])
        balance = _money(balance_raw, round(total - paid, 2))
        if not balance_raw:
            balance = round(total - paid, 2)

        gst_rate = round(gst / taxable * 100, 2) if taxable else 0.0
        interstate = igst > 0
        if not (cgst or sgst or igst) and gst and taxable:
            if interstate:
                igst = gst
            else:
                cgst = round(gst / 2, 2)
                sgst = round(gst - cgst, 2)

        status = _text(_cell(row, idx["status"])) or ("paid" if balance <= 0 else "partially_paid" if paid > 0 else "draft")
        status = status.lower().replace(" ", "_")
        if status in {"outstanding", "due"}:
            status = "draft"

        client = {
            "full_name": client_name,
            "phone_number": _cell(row, idx["client_phone"]),
            "email": _cell(row, idx["client_email"]),
            "name_gstin_number": _cell(row, idx["client_gstin"]),
            "address": _cell(row, idx["client_address"]),
            "name_state": _cell(row, idx["client_state"]),
        }
        if client_name:
            clients[_norm(client_name)] = client

        invoices.append({
            "invoice_type": "tax_invoice",
            "invoice_no": invoice_no,
            "invoice_date": _date(_cell(row, idx["date"])),
            "due_date": _date(_cell(row, idx["due_date"]), _date(_cell(row, idx["date"]))),
            "client_name": client_name,
            "client_email": client["email"],
            "client_phone": client["phone_number"],
            "client_gstin": client["name_gstin_number"],
            "client_address": client["address"],
            "client_state": client["name_state"],
            "is_interstate": interstate,
            "items": [{
                "description": _cell(row, idx["notes"]) or f"Sale - {invoice_no or 'Imported Invoice'}",
                "hsn_sac": "",
                "quantity": 1,
                "unit": "service",
                "unit_price": taxable,
                "discount_pct": 0,
                "taxable_value": taxable,
                "gst_rate": gst_rate,
                "cgst_rate": 0 if interstate else (gst_rate / 2),
                "sgst_rate": 0 if interstate else (gst_rate / 2),
                "igst_rate": gst_rate if interstate else 0,
                "cgst_amount": cgst,
                "sgst_amount": sgst,
                "igst_amount": igst,
                "total_amount": total,
            }],
            "subtotal": taxable,
            "total_discount": 0,
            "total_taxable": taxable,
            "total_cgst": cgst,
            "total_sgst": sgst,
            "total_igst": igst,
            "total_gst": gst,
            "grand_total": total,
            "amount_paid": paid,
            "amount_due": balance,
            "status": status,
            "payment_terms": "Imported from Excel",
            "notes": _cell(row, idx["notes"]),
        })

    return {
        "source": "excel",
        "source_label": f"Excel Backup ({filename})",
        "company": company_fields,
        "firms": [company_fields] if company_fields else [],
        "clients": list(clients.values()),
        "items": [],
        "invoices": invoices,
        "payments": [],
        "stats": {
            "firms": 1 if company_fields else 0,
            "clients": len(clients),
            "items": 0,
            "invoices": len(invoices),
            "payments": 0,
        },
    }


@router.get("/invoices/next-number")
async def get_next_invoice_number_compat(
    company_id: str = Query(...),
    invoice_type: str = Query("tax_invoice"),
    prefix: Optional[str] = Query(None),
    separator: str = Query("/"),
    include_fy: bool = Query(True),
    fy_format: str = Query("short"),
    include_month: bool = Query(False),
    number_padding: int = Query(3, ge=1, le=10),
    current_user=Depends(get_current_user),
):
    """Generate a number only inside the company the current user can access."""
    company = await _accessible_company(current_user, company_id)
    if not company:
        raise HTTPException(403, "You do not have access to the selected company.")

    # Sales is the actual Finix page entitlement. Keep legacy can_manage_invoices
    # compatibility, but do not require an unrelated module permission merely to
    # pre-fetch the next number for an invoice the user can create.
    from backend.dependencies import _commercial_permission_allows, _get_perm
    if getattr(current_user, "role", None) != "admin":
        allowed = _commercial_permission_allows(current_user, "can_manage_invoices")
        allowed = allowed and bool(_get_perm(current_user, "can_manage_invoices", False))
        if not allowed:
            raise HTTPException(403, "Invoice numbering permission is not enabled for this user.")

    return {
        "invoice_no": await _next_invoice_no(
            prefix=prefix or "INV",
            company_id=company_id,
            separator=separator,
            include_fy=include_fy,
            fy_format=fy_format,
            include_month=include_month,
            number_padding=number_padding,
            invoice_type=invoice_type,
        )
    }


@router.post("/invoices/parse-backup")
async def parse_backup_file_compat(
    file: UploadFile = File(...),
    company_id: Optional[str] = Query(None),
    current_user=Depends(get_current_user),
):
    """Parse the commercial Excel backup without inventing invoice numbers."""
    filename = file.filename or "unknown"
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in {"xlsx", "xls", "csv"}:
        # Leave the existing VYP/XML/JSON readers untouched.
        from backend.invoicing import parse_backup_file
        return await parse_backup_file(file=file, current_user=current_user)

    content = await file.read()
    suffix = "." + ext
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        tmp.write(content)
        tmp.close()
        result = _parse_excel(tmp.name, filename)
        company = await _company_from_excel(current_user, result.get("company") or {}, company_id or "")
        result["company"] = company
        result["company_id"] = company.get("id") if company else None
        return result
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass


class ImportBackupCompat(BaseModel):
    company_id: str
    source: str = "excel"
    invoices: list[dict] = Field(default_factory=list)
    clients: list[dict] = Field(default_factory=list)
    items: list[dict] = Field(default_factory=list)
    payments: list[dict] = Field(default_factory=list)
    skip_duplicates: bool = True


@router.post("/invoices/import-backup")
async def import_backup_compat(data: ImportBackupCompat, current_user=Depends(get_current_user)):
    """Import Excel backup data while preserving its invoice numbers and balances."""
    company = await _accessible_company(current_user, data.company_id)
    if not company:
        raise HTTPException(403, "You do not have access to the selected company.")

    from pymongo import UpdateOne

    now = datetime.now(timezone.utc).isoformat()
    result = {
        "invoices_imported": 0,
        "invoices_skipped": 0,
        "clients_imported": 0,
        "clients_updated": 0,
        "items_imported": 0,
        "payments_imported": 0,
        "errors": [],
    }

    # Tenant-aware lookup. Match by GSTIN/email/phone/name before creating a client.
    existing = await db.clients.find({}, {"_id": 0}).to_list(100000)
    by_name = {_norm(c.get("company_name") or c.get("name")): c for c in existing if _norm(c.get("company_name") or c.get("name"))}
    by_gstin = {_norm(c.get("client_gstin") or c.get("gstin")): c for c in existing if _norm(c.get("client_gstin") or c.get("gstin"))}
    by_email = {_norm(c.get("email")): c for c in existing if _norm(c.get("email"))}
    by_phone = {_norm(c.get("phone")): c for c in existing if _norm(c.get("phone"))}
    client_ids = {}
    new_clients = []

    for raw in data.clients:
        name = _text(raw.get("full_name") or raw.get("client_name") or raw.get("company_name") or raw.get("name"))
        if not name:
            continue
        gstin = _text(raw.get("name_gstin_number") or raw.get("client_gstin") or raw.get("gstin")).upper()
        email = _text(raw.get("email"))
        phone = _text(raw.get("phone_number") or raw.get("phone") or raw.get("mobile"))
        ex = by_gstin.get(_norm(gstin)) if gstin else None
        ex = ex or by_email.get(_norm(email)) if email else ex
        ex = ex or by_phone.get(_norm(phone)) if phone else ex
        ex = ex or by_name.get(_norm(name))
        if ex:
            client_ids[name] = ex["id"]
            update = {}
            for target, value in {
                "phone": phone,
                "email": email,
                "address": _text(raw.get("address")),
                "client_gstin": gstin,
                "state": _text(raw.get("name_state") or raw.get("state")),
            }.items():
                if value and not _text(ex.get(target)):
                    update[target] = value
            if update:
                update["updated_at"] = now
                await db.clients.update_one({"id": ex["id"]}, {"$set": update})
                result["clients_updated"] += 1
            continue
        cid = str(uuid.uuid4())
        doc = {
            "id": cid,
            "company_name": name,
            "phone": phone,
            "email": email,
            "address": _text(raw.get("address")),
            "client_gstin": gstin,
            "state": _text(raw.get("name_state") or raw.get("state")),
            "client_type": "other",
            "status": "active",
            "created_by": current_user.id,
            "created_at": now,
            "updated_at": now,
            "imported_from": data.source,
        }
        new_clients.append(doc)
        client_ids[name] = cid
        by_name[_norm(name)] = doc

    if new_clients:
        await db.clients.insert_many(new_clients, ordered=False)
        result["clients_imported"] = len(new_clients)

    existing_numbers = {
        _text(d.get("invoice_no"))
        for d in await db.invoices.find({"company_id": data.company_id}, {"_id": 0, "invoice_no": 1}).to_list(200000)
        if _text(d.get("invoice_no"))
    }

    new_invoices = []
    for inv in data.invoices:
        inv_no = _text(inv.get("invoice_no"))
        if inv_no and inv_no in existing_numbers:
            if data.skip_duplicates:
                result["invoices_skipped"] += 1
                continue
        if not inv_no:
            # Blank Excel number: generate the real next sequence. Never use IMP-xxxx.
            inv_no = await _next_invoice_no(
                prefix="INV", company_id=data.company_id, separator="/",
                include_fy=True, fy_format="short", include_month=False,
                number_padding=3, invoice_type=inv.get("invoice_type", "tax_invoice"),
            )
        existing_numbers.add(inv_no)

        total = _money(inv.get("grand_total"))
        paid = _money(inv.get("amount_paid"))
        due = _money(inv.get("amount_due"), round(total - paid, 2))
        if not _text(inv.get("amount_due")):
            due = round(total - paid, 2)
        if due < 0 and abs(due) < 0.01:
            due = 0.0

        client_name = _text(inv.get("client_name"))
        doc = {
            "id": str(uuid.uuid4()),
            "company_id": data.company_id,
            "client_id": client_ids.get(client_name),
            "invoice_no": inv_no,
            "invoice_type": inv.get("invoice_type", "tax_invoice"),
            "invoice_date": _date(inv.get("invoice_date")),
            "due_date": _date(inv.get("due_date"), _date(inv.get("invoice_date"))),
            "client_name": client_name,
            "client_email": _text(inv.get("client_email")),
            "client_phone": _text(inv.get("client_phone")),
            "client_gstin": _text(inv.get("client_gstin")).upper(),
            "client_address": _text(inv.get("client_address")),
            "client_state": _text(inv.get("client_state")),
            "is_interstate": bool(inv.get("is_interstate")),
            "items": inv.get("items") or [],
            "subtotal": _money(inv.get("subtotal")),
            "total_discount": _money(inv.get("total_discount")),
            "total_taxable": _money(inv.get("total_taxable")),
            "total_cgst": _money(inv.get("total_cgst")),
            "total_sgst": _money(inv.get("total_sgst")),
            "total_igst": _money(inv.get("total_igst")),
            "total_gst": _money(inv.get("total_gst")),
            "grand_total": total,
            "amount_paid": paid,
            "amount_due": due,
            "status": _text(inv.get("status")) or ("paid" if due <= 0 else "partially_paid" if paid > 0 else "draft"),
            "payment_terms": _text(inv.get("payment_terms")) or "Imported from Excel",
            "notes": _text(inv.get("notes")),
            "reference_no": _text(inv.get("reference_no")),
            "supply_state": _text(inv.get("client_state")),
            "discount_amount": 0.0,
            "shipping_charges": 0.0,
            "other_charges": 0.0,
            "terms_conditions": "",
            "is_recurring": False,
            "recurrence_pattern": "monthly",
            "recurrence_end": None,
            "next_invoice_date": None,
            "invoice_template": "prestige",
            "invoice_theme": "classic_blue",
            "invoice_custom_color": "#0D3B66",
            "pdf_drive_link": "",
            "imported_from": data.source,
            "created_by": current_user.id,
            "created_at": now,
            "updated_at": now,
        }
        new_invoices.append(doc)

    if new_invoices:
        await db.invoices.insert_many(new_invoices, ordered=False)
        result["invoices_imported"] = len(new_invoices)

    return result
