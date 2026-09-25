"""
ROC Forms Dump — historical MCA filing archive, extraction, provenance and
company-state reconciliation.

This module is intentionally separate from the existing ROC filing uploader.
The dump is an evidence/archive layer: it never treats a newly uploaded form
as the current truth without recording the source, confidence and conflicts.
Unknown MCA forms are retained and classified generically instead of rejected.
"""

import base64
import hashlib
import io
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from docx import Document as DocxDocument
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt

from backend.dependencies import db, check_module_permission
from backend.models import User

logger = logging.getLogger("roc_forms_dump")

router = APIRouter(tags=["roc-forms-dump"])

VIEW = check_module_permission("roc_sphere", "view")
CREATE = check_module_permission("roc_sphere", "create")
EDIT = check_module_permission("roc_sphere", "edit")

COMPANIES = db.roc_companies
DUMP = db.roc_form_dump
CHUNKS = db.roc_form_dump_chunks
DOCS = db.roc_documents

ALLOWED_EXT = (".pdf", ".xlsx", ".xlsm", ".xls", ".csv")
CHUNK_SIZE = 512 * 1024
MAX_BATCH = 200 * 1024 * 1024
MAX_TEXT_STORE = 150_000


def _now():
    return datetime.now(timezone.utc)


def _uid():
    return str(uuid.uuid4())


def _who(user):
    return getattr(user, "full_name", None) or getattr(user, "username", None) or "—"


def _safe_name(value):
    return re.sub(r"[^A-Za-z0-9_-]+", "_", str(value or "")).strip("_") or "ROC_Dump"


def _clean_text(text):
    return re.sub(r"[ \t\r]+", " ", str(text or "")).strip()


def _sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def _extract_pdf_text(raw):
    parts = []
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(raw)) as pdf:
            page_count = len(pdf.pages)
            for page in pdf.pages:
                parts.append(page.extract_text(x_tolerance=1, y_tolerance=3) or "")
        return "\n".join(parts), page_count
    except Exception as exc:
        logger.warning("ROC dump PDF extraction failed: %s", exc)
        return "", 0


def _extract_workbook_text(filename, raw):
    try:
        import openpyxl
        wb = openpyxl.load_workbook(
            io.BytesIO(raw),
            read_only=True,
            data_only=True,
            keep_vba=str(filename).lower().endswith(".xlsm"),
        )
        lines = []
        for ws in wb.worksheets:
            lines.append(f"[SHEET: {ws.title}]")
            for row in ws.iter_rows(values_only=True):
                values = [_clean_text(v) for v in row if v is not None]
                if values:
                    lines.append(" | ".join(values))
        wb.close()
        return "\n".join(lines), 0
    except Exception as exc:
        logger.warning("ROC dump workbook extraction failed: %s", exc)
        return "", 0


def _extract_text(filename, raw):
    name = str(filename or "").lower()
    if name.endswith(".pdf"):
        return _extract_pdf_text(raw)
    if name.endswith((".xlsx", ".xlsm", ".xls")):
        return _extract_workbook_text(name, raw)
    try:
        return raw.decode("utf-8", errors="replace"), 0
    except Exception:
        return "", 0


def _form_number(filename, text):
    hay = f"{filename}\n{text[:12000]}"
    patterns = (
        r"\bFORM\s*(?:NO\.?\s*)?([A-Z]{1,8})\s*[-/]?\s*(\d{1,3})\b",
        r"\bE[- ]?FORM\s*(?:NO\.?\s*)?([A-Z]{1,8})\s*[-/]?\s*(\d{1,3})\b",
        r"\b([A-Z]{1,8})\s*[-/]\s*(\d{1,3})\b",
        r"\b([A-Z]{1,8})(\d{1,3})\b",
    )
    for pattern in patterns:
        match = re.search(pattern, hay, re.I)
        if match:
            prefix = match.group(1).upper()
            number = int(match.group(2))
            return f"{prefix}-{number}", prefix, number
    # Numeric form references are retained too (useful for old MCA forms).
    match = re.search(r"\bFORM\s*(?:NO\.?\s*)?(\d{1,3})\b", hay, re.I)
    if match:
        number = int(match.group(1))
        return f"FORM-{number}", "FORM", number
    return "UNKNOWN", "UNKNOWN", None


def _classify(form, text):
    hay = f"{form}\n{text[:18000]}".lower()
    if re.search(r"\b(sh[- ]?4|securities transfer form|transferor.*transferee)", hay):
        return "share_transfer"
    if re.search(r"\bdir[- ]?12\b|appointment.*director|cessation.*director|change.*designation", hay):
        return "director_change"
    if re.search(r"\bdir[- ]?11\b|notice of resignation", hay):
        return "director_resignation"
    if re.search(r"\bpas[- ]?3\b|return of allotment|intimation of allotment", hay):
        return "share_allotment"
    if re.search(r"\b(aoc[- ]?4|aoc[- ]?4xbrl)\b|balance sheet|statement of profit", hay):
        return "financial"
    if re.search(r"\bmgt[- ]?(7a?|6)\b|annual return|register of members", hay):
        return "annual_return"
    if re.search(r"\bdpt[- ]?3\b|amount of outstanding loan|non.?deposit|deposits", hay):
        return "loan_deposit"
    if re.search(r"\bchg[- ]?\d+\b|charge holder|creation of charge|modification of charge|satisfaction of charge", hay):
        return "charge"
    if re.search(r"\badt[- ]?1\b|appointment of auditor|statutory auditor", hay):
        return "auditor"
    if re.search(r"\binc[- ]?22\b|registered office", hay):
        return "registered_office"
    if re.search(r"\bmgt[- ]?14\b|resolution.*registrar", hay):
        return "resolution"
    if re.search(r"\b(dir[- ]?3|dir[- ]?3\s*kyc)\b", hay):
        return "director_kyc"
    if re.search(r"\bspice|inc[- ]?7|inc[- ]?20|inc[- ]?32|inc[- ]?33|inc[- ]?34\b|certificate of incorporation", hay):
        return "incorporation"
    return "other"


def _find(patterns, text, flags=re.I | re.S):
    for pattern in patterns:
        match = re.search(pattern, text or "", flags)
        if match:
            value = match.group(1) if match.lastindex else match.group(0)
            value = _clean_text(value)
            if value:
                return value
    return None


def _number(value):
    if value is None:
        return None
    cleaned = re.sub(r"[^0-9.\-]", "", str(value).replace(",", ""))
    try:
        return float(cleaned)
    except Exception:
        return None


def _date_candidates(text):
    candidates = []
    for match in re.finditer(r"\b([0-3]?\d)[/-]([01]?\d)[/-]((?:19|20)\d{2})\b", text or ""):
        try:
            day, month, year = int(match.group(1)), int(match.group(2)), int(match.group(3))
            if 1 <= month <= 12 and 1 <= day <= 31:
                candidates.append(f"{year:04d}-{month:02d}-{day:02d}")
        except Exception:
            pass
    return list(dict.fromkeys(candidates))


def _extract_company(text):
    cin = _find([r"\b([LU][0-9A-Z]{20})\b", r"Corporate Identity Number\s*[:\-]?\s*([A-Z0-9]{21})"], text)
    name = _find([
        r"Name of (?:the )?(?:company|entity)\s*[:\-]?\s*([^\n]{3,160})",
        r"Company Name\s*[:\-]?\s*([^\n]{3,160})",
        r"Name of the company\s*([^\n]{3,160})",
    ], text)
    address = _find([
        r"registered office(?: address)?\s*[:\-]?\s*([^\n]{10,300})",
        r"address of the registered office[^\n]*\n([^\n]{10,300})",
    ], text)
    return {"cin": cin, "company_name": name, "registered_office_address": address}


def _extract_people(text):
    people = []
    # DIN/name pairs are deliberately conservative.
    for match in re.finditer(r"\b(\d{8})\b.{0,180}?([A-Z][A-Za-z .,'&()-]{2,100})", text or "", re.S):
        din, name = match.group(1), _clean_text(match.group(2))
        if re.search(r"number|date|meeting|director identification", name, re.I):
            continue
        if any(p["din"] == din for p in people):
            continue
        people.append({"name": name.strip(" -:"), "din": din})
        if len(people) >= 100:
            break
    return people


def _extract_share_transfer(text):
    transferor = _find([
        r"Transferor(?:\(s\))?[^\n:]*[:\-]\s*([^\n]{2,160})",
        r"Name of the Transferor[^\n]*\n\s*([^\n]{2,160})",
    ], text)
    transferee = _find([
        r"Transferee(?:\(s\))?[^\n:]*[:\-]\s*([^\n]{2,160})",
        r"Name of the Transferee[^\n]*\n\s*([^\n]{2,160})",
    ], text)
    shares = _find([
        r"No\. of securities being transferred[^\d]*([\d,]+(?:\.\d+)?)",
        r"Number of securities transferred[^\d]*([\d,]+(?:\.\d+)?)",
    ], text)
    consideration = _find([r"Consideration(?: received)?[^\d]*([\d,]+(?:\.\d+)?)"], text)
    certificate = _find([r"Certificate Nos?\.?[^\d]*([A-Za-z0-9, /-]+)"], text)
    distinctive_from = _find([r"Distinctive number.*?From[^\d]*([\d]+)"], text)
    distinctive_to = _find([r"Distinctive number.*?To[^\d]*([\d]+)"], text)
    transfer_date = _find([
        r"Date of execution[^\d]*([0-3]?\d/[01]?\d/\d{4})",
        r"Date of transfer[^\d]*([0-3]?\d/[01]?\d/\d{4})",
    ], text)
    return {
        "transferor_name": transferor,
        "transferee_name": transferee,
        "number_of_shares": _number(shares),
        "consideration": _number(consideration) or 0,
        "share_certificate_no": certificate,
        "distinctive_from": distinctive_from,
        "distinctive_to": distinctive_to,
        "transfer_date": transfer_date,
        "class_of_shares": _find([r"Kind/ Class of securities\s*[:\-]?\s*([^\n]{2,80})"], text) or "Equity",
    }


def _extract_financial(text):
    fields = {}
    patterns = {
        "net_worth": [r"Net worth(?: of the company)?[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "turnover": [r"Turnover[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "total_income": [r"Total income[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "total_expenses": [r"Total expenses[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "profit_before_tax": [r"Profit before tax[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "profit_after_tax": [r"Profit(?:/| /)?\s*\(Loss\).*?(?:after tax|for the period)[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "share_capital": [r"Share capital[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "reserves_and_surplus": [r"Reserves?(?: and| &) surplus[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "balance_sheet_total": [r"(?:Total assets|Balance Sheet Total)[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
    }
    for key, pats in patterns.items():
        value = _find(pats, text)
        number = _number(value)
        if number is not None:
            fields[key] = number
    return fields


def _extract_loans(text):
    fields = {}
    for key, patterns in {
        "outstanding_loans": [r"(?:outstanding loan|loan outstanding|outstanding money|borrowings)[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "deposits_outstanding": [r"deposits? outstanding[^\d-]*(-?[\d,]+(?:\.\d+)?)"],
        "charges_count": [r"Number of charges[^\d]*([\d,]+)"],
    }.items():
        value = _find(patterns, text)
        number = _number(value)
        if number is not None:
            fields[key] = number
    lender = _find([r"(?:name of charge holder|charge holder|lender)\s*[:\-]?\s*([^\n]{3,160})"], text)
    if lender:
        fields["lender"] = lender
    return fields


def _extract_auditor(text):
    return {
        "name": _find([r"Name of (?:the )?Auditor(?:\s+or Auditor's Firm)?\s*[:\-]?\s*([^\n]{2,160})"], text),
        "firm_reg_no": _find([r"(?:Firm Registration Number|registration number of auditor.?s firm)\s*[:\-]?\s*([A-Z0-9-]+)"], text),
        "membership_no": _find([r"Membership Number(?: of Auditor)?\s*[:\-]?\s*(\d+)"], text),
    }


def _extract_metadata(form, text):
    dates = _date_candidates(text[:30000])
    srn = _find([r"(?:SRN|Service Request Number)\s*[:\-]?\s*([A-Z0-9]+)"], text)
    filing_date = _find([r"(?:eForm )?filing date\s*[:\-]?\s*([0-3]?\d/[01]?\d/\d{4})"], text)
    fy = _find([
        r"(?:financial year|F\.Y\.?|FY)\s*(?:from)?\s*[:\-]?\s*(20\d{2}\s*[-/]\s*(?:20)?\d{2})",
        r"\b(20\d{2}\s*[-/]\s*(?:20)?\d{2})\b",
    ], text[:12000])
    return {
        "srn": srn,
        "filing_date": filing_date,
        "financial_year": fy,
        "event_dates": dates[:50],
    }


def _events_for(form_type, form_number, extracted, metadata):
    events = []
    event_date = (metadata.get("event_dates") or [None])[0]
    if form_type in {"director_change", "director_resignation"}:
        for person in extracted.get("directors") or []:
            action = "resignation_or_cessation" if form_type == "director_resignation" else "director_change"
            events.append({
                "event_type": "director",
                "action": action,
                "event_date": event_date,
                "person": person,
            })
    if form_type == "share_transfer" and extracted.get("share_transfer"):
        transfer = extracted["share_transfer"]
        if transfer.get("transferor_name") and transfer.get("transferee_name") and (transfer.get("number_of_shares") or 0) > 0:
            events.append({
                "event_type": "share_transfer",
                "event_date": transfer.get("transfer_date") or event_date,
                "transfer": transfer,
                "register_eligible": True,
            })
    if form_type == "share_allotment":
        events.append({
            "event_type": "share_allotment",
            "event_date": event_date,
            "data": extracted.get("financial") or {},
        })
    if form_type == "loan_deposit":
        events.append({"event_type": "loan_or_deposit", "event_date": event_date, "data": extracted.get("loans") or {}})
    if form_type == "charge":
        events.append({"event_type": "charge", "event_date": event_date, "data": extracted.get("loans") or {}})
    if form_type == "financial":
        events.append({"event_type": "financial", "event_date": event_date, "data": extracted.get("financial") or {}})
    if form_type == "auditor":
        events.append({"event_type": "auditor", "event_date": event_date, "data": extracted.get("auditor") or {}})
    if form_type == "registered_office":
        address = extracted.get("company", {}).get("registered_office_address")
        if address:
            events.append({"event_type": "registered_office", "event_date": event_date, "data": {"address": address}})
    if form_type == "incorporation":
        events.append({"event_type": "incorporation", "event_date": event_date, "data": extracted.get("company") or {}})
    return events


def _confidence(extracted, text, form_type):
    score = 0.35
    if text.strip():
        score += 0.20
    if extracted.get("company", {}).get("cin"):
        score += 0.15
    if extracted.get("metadata", {}).get("srn"):
        score += 0.10
    if form_type != "other":
        score += 0.10
    if extracted.get("events"):
        score += 0.10
    return min(score, 0.99)


def _dedupe_key(event):
    return hashlib.sha256(json.dumps(event, sort_keys=True, default=str).encode()).hexdigest()


def _summary_sections(company, filings, events):
    directors = [e for e in events if e.get("event_type") == "director"]
    transfers = [e for e in events if e.get("event_type") == "share_transfer"]
    financials = [e for e in events if e.get("event_type") == "financial"]
    loans = [e for e in events if e.get("event_type") in {"loan_or_deposit", "charge"}]
    auditors = [e for e in events if e.get("event_type") == "auditor"]
    offices = [e for e in events if e.get("event_type") == "registered_office"]
    incorporation = [e for e in events if e.get("event_type") == "incorporation"]
    return {
        "company": {
            "name": company.get("company_name"),
            "cin": company.get("cin"),
            "date_of_incorporation": company.get("date_of_incorporation"),
            "registered_office_address": company.get("registered_office_address"),
            "category": company.get("category"),
            "paid_up_capital": company.get("paid_up_capital"),
            "authorized_capital": company.get("authorized_capital"),
        },
        "incorporation_history": incorporation,
        "directors_and_kmp_history": directors,
        "share_transfer_history": transfers,
        "financial_history": financials,
        "loans_and_charges_history": loans,
        "auditor_history": auditors,
        "registered_office_history": offices,
        "filing_inventory": [
            {
                "id": f.get("id"),
                "filename": f.get("filename"),
                "form_number": f.get("form_number"),
                "classification": f.get("classification"),
                "srn": f.get("metadata", {}).get("srn"),
                "financial_year": f.get("metadata", {}).get("financial_year"),
                "filing_date": f.get("metadata", {}).get("filing_date"),
                "status": f.get("status"),
                "confidence": f.get("confidence"),
            }
            for f in filings
        ],
        "review_items": [
            {
                "filename": f.get("filename"),
                "status": f.get("status"),
                "warnings": f.get("warnings") or [],
                "errors": f.get("errors") or [],
            }
            for f in filings if f.get("status") != "SUCCESS"
        ],
    }


def _build_summary_doc(company, summary, prepared_by):
    doc = DocxDocument()
    sec = doc.sections[0]
    sec.top_margin = Pt(36)
    sec.bottom_margin = Pt(36)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(str(company.get("company_name") or "Company").upper())
    run.bold = True
    run.font.size = Pt(16)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.add_run(f"CIN/LLPIN: {company.get('cin') or '—'}")
    doc.add_paragraph("COMPANY SUMMARY — GENERATED FROM ROC FORMS DUMP").runs[0].bold = True

    def section(title, rows):
        doc.add_heading(title, level=2)
        if isinstance(rows, dict):
            for key, value in rows.items():
                doc.add_paragraph(f"{key.replace('_', ' ').title()}: {value}")
        elif isinstance(rows, list):
            for item in rows:
                doc.add_paragraph(json.dumps(item, ensure_ascii=False, default=str))
        else:
            doc.add_paragraph(str(rows or "—"))

    section("1. Company Master", summary["company"])
    section("2. Incorporation History", summary["incorporation_history"])
    section("3. Directors / KMP History", summary["directors_and_kmp_history"])
    section("4. Share Transfer History", summary["share_transfer_history"])
    section("5. Financial / Net Worth History", summary["financial_history"])
    section("6. Loans / Charges History", summary["loans_and_charges_history"])
    section("7. Auditor History", summary["auditor_history"])
    section("8. Registered Office History", summary["registered_office_history"])
    section("9. ROC Forms Inventory", summary["filing_inventory"])
    section("10. Review / Exceptions", summary["review_items"])
    doc.add_paragraph(
        "This document is an evidence-based working summary generated from uploaded ROC forms. "
        "Values with low extraction confidence or unresolved conflicts remain review items and are not "
        "silently treated as verified statutory truth."
    )
    doc.add_paragraph(f"Prepared by: {prepared_by} (Taskosphere ROC Sphere)")
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


async def _store_chunks(filing_id, raw):
    await CHUNKS.delete_many({"filing_id": filing_id})
    for index in range(0, len(raw), CHUNK_SIZE):
        chunk = raw[index:index + CHUNK_SIZE]
        await CHUNKS.insert_one({
            "filing_id": filing_id,
            "seq": index // CHUNK_SIZE,
            "data_b64": base64.b64encode(chunk).decode("ascii"),
        })


async def _load_chunks(filing_id):
    cursor = CHUNKS.find({"filing_id": filing_id}).sort("seq", 1)
    parts = []
    async for row in cursor:
        parts.append(base64.b64decode(row["data_b64"]))
    return b"".join(parts)


async def _rebuild(company_id, prepared_by):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    filings = [x async for x in DUMP.find({"company_id": company_id}).sort("metadata.filing_date", 1)]
    events = []
    for filing in filings:
        for event in filing.get("events") or []:
            item = dict(event)
            item["filing_id"] = filing.get("id")
            item["form_number"] = filing.get("form_number")
            item["source_filename"] = filing.get("filename")
            events.append(item)

    # Deduplicate events while preserving chronological order.
    unique = {}
    for event in events:
        unique.setdefault(_dedupe_key(event), event)
    events = sorted(unique.values(), key=lambda x: (str(x.get("event_date") or "9999"), str(x.get("form_number") or "")))

    # Only high-evidence SH-4 transfer events are copied into the working
    # Share Transfer Register. This avoids treating a person's appearance in
    # MGT/AOC material as a transfer.
    existing = list(company.get("share_transfers") or [])
    for event in events:
        if event.get("event_type") != "share_transfer" or not event.get("register_eligible"):
            continue
        transfer = dict(event.get("transfer") or {})
        transfer["source_filing_id"] = event.get("filing_id")
        transfer["source_form_number"] = event.get("form_number")
        transfer["source_filename"] = event.get("source_filename")
        transfer["source"] = "ROC Forms Dump / SH-4"
        signature = _dedupe_key({
            "transferor_name": transfer.get("transferor_name"),
            "transferee_name": transfer.get("transferee_name"),
            "transfer_date": transfer.get("transfer_date"),
            "number_of_shares": transfer.get("number_of_shares"),
            "certificate": transfer.get("share_certificate_no"),
        })
        if not any(x.get("roc_dump_signature") == signature for x in existing):
            transfer["roc_dump_signature"] = signature
            transfer["verification_status"] = "Source SH-4 extracted — verify execution and registration"
            existing.append(transfer)

    summary = _summary_sections(company, filings, events)
    summary_doc = _build_summary_doc(company, summary, prepared_by)
    now = _now()

    # Replace the generated Company Summary document, retaining other vault docs.
    await DOCS.delete_many({"company_id": company_id, "doc_type": "company_summary"})
    summary_doc_record = {
        "id": _uid(),
        "company_id": company_id,
        "doc_type": "company_summary",
        "filename": f"Company_Summary_{_safe_name(company.get('company_name'))}.docx",
        "generated_at": now,
        "generated_by": prepared_by,
        "content_b64": base64.b64encode(summary_doc).decode("ascii"),
        "source": "ROC Forms Dump",
        "dump_generated_at": now,
    }
    await DOCS.insert_one(summary_doc_record)

    await COMPANIES.update_one(
        {"id": company_id},
        {"$set": {
            "share_transfers": existing,
            "roc_dump_last_rebuilt_at": now,
            "roc_dump_event_count": len(events),
            "updated_at": now,
        }},
    )
    return summary, events, summary_doc_record


@router.post("/companies/{company_id}/roc-dump/upload")
async def upload_roc_dump(
    company_id: str,
    files: List[UploadFile] = File(...),
    current_user: User = Depends(CREATE),
):
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    if not files:
        raise HTTPException(400, "Select at least one ROC form")

    total = 0
    results = []
    now = _now()

    for uploaded in files:
        filename = uploaded.filename or "roc-form"
        if not filename.lower().endswith(ALLOWED_EXT):
            results.append({"filename": filename, "status": "FAILED", "error": "Unsupported file type"})
            continue
        raw = await uploaded.read()
        total += len(raw)
        if total > MAX_BATCH:
            results.append({"filename": filename, "status": "FAILED", "error": "Batch exceeds 200 MB"})
            continue
        if not raw:
            results.append({"filename": filename, "status": "FAILED", "error": "Empty file"})
            continue

        digest = _sha256(raw)
        duplicate = await DUMP.find_one({"company_id": company_id, "sha256": digest})
        if duplicate:
            results.append({
                "filename": filename,
                "status": "DUPLICATE",
                "filing_id": duplicate.get("id"),
                "form_number": duplicate.get("form_number"),
            })
            continue

        filing_id = _uid()
        text, page_count = _extract_text(filename, raw)
        form_number, prefix, number = _form_number(filename, text)
        classification = _classify(form_number, text)
        metadata = _extract_metadata(form_number, text)
        company_extract = _extract_company(text)
        extracted = {"company": company_extract, "metadata": metadata}

        if classification in {"director_change", "director_resignation", "annual_return", "director_kyc"}:
            people = _extract_people(text)
            if people:
                extracted["directors"] = people
        if classification == "share_transfer":
            extracted["share_transfer"] = _extract_share_transfer(text)
        if classification in {"financial", "share_allotment"}:
            extracted["financial"] = _extract_financial(text)
        if classification in {"loan_deposit", "charge"}:
            extracted["loans"] = _extract_loans(text)
        if classification == "auditor":
            extracted["auditor"] = _extract_auditor(text)

        # Keep all source text for auditability, but cap the inline copy so a
        # single Mongo document never grows without bound.
        raw_text_hash = _sha256(text.encode("utf-8", errors="ignore")) if text else None
        warnings = []
        errors = []
        if not text.strip():
            warnings.append("No machine-readable text was extracted. This may be a scanned/image-only or password-protected file; manual/OCR review is required.")
        if form_number == "UNKNOWN":
            warnings.append("Form number could not be classified; the complete file is retained as UNKNOWN for manual review.")
        if classification == "other":
            warnings.append("No specialized parser matched this form. Generic metadata and source text were retained.")
        if text and not extracted.get("company", {}).get("cin"):
            warnings.append("CIN/LLPIN was not confidently identified.")
        status = "SUCCESS" if text.strip() and form_number != "UNKNOWN" else "NEEDS_REVIEW"
        confidence = _confidence(extracted, text, classification)

        events = _events_for(classification, form_number, extracted, metadata)
        filing = {
            "id": filing_id,
            "company_id": company_id,
            "filename": filename,
            "original_filename": filename,
            "sha256": digest,
            "size_bytes": len(raw),
            "page_count": page_count,
            "form_number": form_number,
            "form_prefix": prefix,
            "form_numeric": number,
            "classification": classification,
            "metadata": metadata,
            "extracted": extracted,
            "raw_text": text[:MAX_TEXT_STORE],
            "raw_text_truncated": len(text) > MAX_TEXT_STORE,
            "raw_text_sha256": raw_text_hash,
            "events": events,
            "status": status,
            "confidence": confidence,
            "warnings": warnings,
            "errors": errors,
            "uploaded_at": now,
            "uploaded_by": _who(current_user),
            "review": {"status": "PENDING" if status != "SUCCESS" else "NOT_REQUIRED"},
        }
        await DUMP.insert_one(filing)
        await _store_chunks(filing_id, raw)
        results.append({
            "filename": filename,
            "filing_id": filing_id,
            "form_number": form_number,
            "classification": classification,
            "status": status,
            "confidence": confidence,
            "warnings": warnings,
            "event_count": len(events),
        })

    summary, events, summary_doc = await _rebuild(company_id, _who(current_user))
    return {
        "company_id": company_id,
        "processed": len([r for r in results if r.get("filing_id")]),
        "results": results,
        "event_count": len(events),
        "summary_document_id": summary_doc["id"],
        "summary": summary,
        "message": "ROC Forms Dump processed. Minimize the window safely; processing is server-side and the archive remains persistent.",
    }


@router.get("/companies/{company_id}/roc-dump")
async def list_roc_dump(company_id: str, current_user: User = Depends(VIEW)):
    if not await COMPANIES.find_one({"id": company_id}, {"id": 1}):
        raise HTTPException(404, "Company not found")
    filings = [x async for x in DUMP.find({"company_id": company_id}).sort("uploaded_at", -1)]
    for item in filings:
        item.pop("_id", None)
        item.pop("raw_text", None)
    return {"count": len(filings), "items": filings}


@router.get("/companies/{company_id}/roc-dump/{filing_id}")
async def get_roc_dump_filing(company_id: str, filing_id: str, current_user: User = Depends(VIEW)):
    filing = await DUMP.find_one({"id": filing_id, "company_id": company_id})
    if not filing:
        raise HTTPException(404, "ROC dump filing not found")
    filing.pop("_id", None)
    return filing


@router.get("/companies/{company_id}/roc-dump/{filing_id}/download")
async def download_roc_dump_filing(company_id: str, filing_id: str, current_user: User = Depends(VIEW)):
    filing = await DUMP.find_one({"id": filing_id, "company_id": company_id})
    if not filing:
        raise HTTPException(404, "ROC dump filing not found")
    raw = await _load_chunks(filing_id)
    if not raw:
        raise HTTPException(410, "Stored ROC form content is unavailable")
    filename = filing.get("filename") or "ROC_Form"
    media = "application/pdf" if filename.lower().endswith(".pdf") else "application/octet-stream"
    return Response(
        content=raw,
        media_type=media,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )


@router.post("/companies/{company_id}/roc-dump/{filing_id}/review")
async def review_roc_dump_filing(
    company_id: str,
    filing_id: str,
    review_status: str = Form(...),
    note: str = Form(""),
    current_user: User = Depends(EDIT),
):
    if review_status not in {"VERIFIED", "REVIEWED", "REJECTED", "NEEDS_REVIEW"}:
        raise HTTPException(400, "Invalid review status")
    result = await DUMP.update_one(
        {"id": filing_id, "company_id": company_id},
        {"$set": {
            "review": {"status": review_status, "note": note, "reviewed_at": _now(), "reviewed_by": _who(current_user)}
        }},
    )
    if not result.modified_count:
        raise HTTPException(404, "ROC dump filing not found")
    return {"updated": True, "review_status": review_status}


@router.post("/companies/{company_id}/roc-dump/rebuild-summary")
async def rebuild_roc_dump_summary(company_id: str, current_user: User = Depends(EDIT)):
    summary, events, doc = await _rebuild(company_id, _who(current_user))
    return {"summary": summary, "event_count": len(events), "summary_document_id": doc["id"]}


@router.get("/companies/{company_id}/roc-dump/summary")
async def roc_dump_summary(company_id: str, current_user: User = Depends(VIEW)):
    filings = [x async for x in DUMP.find({"company_id": company_id}).sort("metadata.filing_date", 1)]
    company = await COMPANIES.find_one({"id": company_id})
    if not company:
        raise HTTPException(404, "Company not found")
    events = []
    for filing in filings:
        events.extend(filing.get("events") or [])
    return _summary_sections(company, filings, events)


@router.get("/companies/{company_id}/roc-dump/events")
async def roc_dump_events(company_id: str, current_user: User = Depends(VIEW)):
    filings = [x async for x in DUMP.find({"company_id": company_id}).sort("metadata.filing_date", 1)]
    events = []
    for filing in filings:
        for event in filing.get("events") or []:
            item = dict(event)
            item["filing_id"] = filing.get("id")
            item["form_number"] = filing.get("form_number")
            item["source_filename"] = filing.get("filename")
            events.append(item)
    return {"count": len(events), "events": events}


@router.get("/companies/{company_id}/roc-dump/share-transfers")
async def roc_dump_share_transfers(company_id: str, current_user: User = Depends(VIEW)):
    company = await COMPANIES.find_one({"id": company_id}, {"share_transfers": 1, "id": 1})
    if not company:
        raise HTTPException(404, "Company not found")
    return {"count": len(company.get("share_transfers") or []), "items": company.get("share_transfers") or []}
