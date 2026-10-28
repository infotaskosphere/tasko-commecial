"""Phase 2 extracted subsystem: holiday_trademark_misc.

This is a normal module. It used to be stored as a string (SOURCE) and run
with exec() inside backend.server's namespace. Every name it borrowed from
that shared namespace is now imported explicitly below, from the same
object the shared namespace held. It is loaded (in the original order) by
backend/server_modules/holiday_trademark_misc.py via backend.server_modules.routes.load_into().
"""
from backend.dependencies import db
from backend.dependencies import get_current_user
from backend.dependencies import get_user_permissions
from backend.dependencies import require_admin
from backend.models import HolidayCreate
from backend.models import HolidayResponse
from backend.models import User
from backend.quickcompany_trademark_router import router as qc_trademark_router
from backend.recruitment import list_candidates as recruitment_list_candidates
from backend.recruitment import router as recruitment_router
from backend.whatsapp_hub import router as whatsapp_hub_router
from datetime import date
from datetime import datetime
from datetime import timezone
from fastapi import Depends
from fastapi import File
from fastapi import HTTPException
from fastapi import UploadFile
from io import BytesIO
from typing import Optional
import re
import uuid
from backend.server import IST, api_router, app, logger  # created in backend/server.py before route modules load

# ==================== HOLIDAY ROUTES ====================
@api_router.get("/holidays", response_model=list[HolidayResponse])
async def get_holidays(current_user: User = Depends(get_current_user)):
    # Return all non-rejected holidays to all users — no manual confirmation step
    query = {"status": {"$ne": "rejected"}}
    holidays = await db.holidays.find(query, {"_id": 0}).sort("date", 1).to_list(500)
    return holidays


@api_router.post("/holidays/auto-sync")
async def auto_sync_holidays(current_user: User = Depends(get_current_user)):
    """
    Fetches Indian public holidays for current + next year from date.nager.at
    and saves them as 'confirmed'. Idempotent — safe to call any number of times.
    Also upgrades any existing 'pending' holidays to 'confirmed' automatically.
    """
    import httpx as _httpx

    now = datetime.now(IST)
    added = 0
    upgraded = 0
    errors = []

    for year in [now.year, now.year + 1]:
        try:
            async with _httpx.AsyncClient(timeout=10) as http:
                resp = await http.get(
                    f"https://date.nager.at/api/v3/PublicHolidays/{year}/IN"
                )
            if resp.status_code != 200:
                errors.append(f"API {resp.status_code} for {year}")
                continue
            for h in resp.json():
                date_str = h["date"]
                name = h.get("localName") or h.get("name", "Holiday")
                existing = await db.holidays.find_one({"date": date_str}, {"_id": 0})
                if not existing:
                    await db.holidays.insert_one(
                        {
                            "date": date_str,
                            "name": name,
                            "status": "confirmed",
                            "type": "public",
                            "created_at": now.isoformat(),
                        }
                    )
                    added += 1
                elif existing.get("status") not in ("confirmed", "rejected"):
                    await db.holidays.update_one(
                        {"date": date_str}, {"$set": {"status": "confirmed"}}
                    )
                    upgraded += 1
        except Exception as e:
            errors.append(f"{year}: {e}")

    logger.info(
        f"auto-sync holidays: +{added} new, {upgraded} upgraded — by {current_user.email}"
    )
    return {"added": added, "upgraded": upgraded, "errors": errors}


@api_router.post("/holidays", response_model=HolidayResponse)
async def create_holiday(
    holiday: HolidayCreate, current_user: User = Depends(require_admin())
):
    """
    Create a holiday entry.
    HolidayCreate.date is typed as Any — the frontend sends a plain string ("2026-04-05").
    Calling .isoformat() on a str raises AttributeError → 500. Guard with isinstance check.
    """
    # ── Safe date → ISO string conversion ───────────────────────────────────
    raw_date = holiday.date
    if isinstance(raw_date, str):
        date_str = raw_date.strip()[:10]  # already "YYYY-MM-DD", just normalise
    elif hasattr(raw_date, "isoformat"):
        date_str = raw_date.isoformat()  # date / datetime object
    else:
        date_str = str(raw_date)[:10]

    # Validate it actually looks like a date
    try:
        date.fromisoformat(date_str)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid date format: '{date_str}'. Use YYYY-MM-DD.",
        )

    holiday_dict = {
        "date": date_str,
        "name": holiday.name,
        "description": getattr(holiday, "description", None),
        "status": "confirmed",
        "type": getattr(holiday, "type", None) or "manual",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    logger.info(
        f"Creating holiday: date={holiday_dict['date']}, name={holiday_dict.get('name')}, by={current_user.id}"
    )

    # Upsert: if a record exists (auto-fetched with pending status), confirm it.
    # If it's already confirmed, return it silently (no 400 error on duplicates).
    existing = await db.holidays.find_one({"date": holiday_dict["date"]}, {"_id": 0})
    if existing:
        if existing.get("status") == "confirmed":
            logger.info(f"Holiday already confirmed for {holiday_dict['date']}")
            return existing
        # Exists but not confirmed (pending/rejected from auto-fetch) -> confirm it
        await db.holidays.update_one(
            {"date": holiday_dict["date"]},
            {
                "$set": {
                    "name": holiday_dict.get("name", existing.get("name")),
                    "status": "confirmed",
                    "type": holiday_dict.get("type", existing.get("type", "public")),
                    "updated_by": current_user.id,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            },
        )
        updated = await db.holidays.find_one({"date": holiday_dict["date"]}, {"_id": 0})
        logger.info(f"Holiday upserted to confirmed: {holiday_dict['date']}")
        return updated

    try:
        await db.holidays.insert_one(holiday_dict)
        holiday_dict.pop("_id", None)
        logger.info(f"Holiday inserted: {holiday_dict['date']}")
        return holiday_dict
    except Exception as e:
        # Handle duplicate key error from unique index (race condition)
        logger.error(f"Holiday insert failed for {holiday_dict['date']}: {e}")
        existing2 = await db.holidays.find_one(
            {"date": holiday_dict["date"]}, {"_id": 0}
        )
        if existing2:
            # A concurrent insert created it — just confirm and return it
            await db.holidays.update_one(
                {"date": holiday_dict["date"]},
                {
                    "$set": {
                        "status": "confirmed",
                        "name": holiday_dict.get("name", existing2.get("name")),
                    }
                },
            )
            final = await db.holidays.find_one(
                {"date": holiday_dict["date"]}, {"_id": 0}
            )
            return final
        raise HTTPException(status_code=500, detail=f"Failed to save holiday: {str(e)}")


@api_router.patch("/holidays/{holiday_date}/status")
async def update_holiday_status(
    holiday_date: str, data: dict, current_user: User = Depends(require_admin())
):
    new_status = data.get("status")
    if new_status not in ["confirmed", "rejected", "pending"]:
        raise HTTPException(status_code=400, detail="Invalid status")
    result = await db.holidays.update_one(
        {"date": holiday_date},
        {"$set": {"status": new_status, "updated_by": current_user.id}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Holiday not found")
    return {"message": f"Holiday marked as {new_status}"}


@api_router.delete("/holidays/{holiday_date}")
async def delete_holiday(
    holiday_date: str, current_user: User = Depends(require_admin())
):
    result = await db.holidays.delete_one({"date": holiday_date})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Holiday not found")
    return {"message": "Holiday removed"}


# ─────────────────────────────────────────────────────────────────────────────
# PDF HOLIDAY EXTRACTOR — 100% FREE using pdfplumber + regex (no API key)
# ─────────────────────────────────────────────────────────────────────────────

# Month name → number map (reused from compliance parser above)
_HOLIDAY_MONTH_MAP = {
    "january": 1,
    "jan": 1,
    "february": 2,
    "feb": 2,
    "march": 3,
    "mar": 3,
    "april": 4,
    "apr": 4,
    "may": 5,
    "june": 6,
    "jun": 6,
    "july": 7,
    "jul": 7,
    "august": 8,
    "aug": 8,
    "september": 9,
    "sep": 9,
    "sept": 9,
    "october": 10,
    "oct": 10,
    "november": 11,
    "nov": 11,
    "december": 12,
    "dec": 12,
}


def _parse_holiday_date(text: str, default_year: int) -> Optional[str]:
    """Try every common date format found in Indian holiday PDFs. Returns YYYY-MM-DD or None."""
    text = text.strip()

    # YYYY-MM-DD or YYYY/MM/DD
    m = re.search(r"\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b", text)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except ValueError:
            pass

    # DD-MM-YYYY or DD/MM/YYYY
    m = re.search(r"\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b", text)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
        except ValueError:
            pass

    # "15 August 2026" or "15th August 2026"
    m = re.search(
        r"\b(\d{1,2})(?:st|nd|rd|th)?\s+"
        r"(january|february|march|april|may|june|july|august|september|october|november|december|"
        r"jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)"
        r"(?:\s+(\d{4}))?\b",
        text,
        re.IGNORECASE,
    )
    if m:
        try:
            yr = int(m.group(3)) if m.group(3) else default_year
            mo = _HOLIDAY_MONTH_MAP[m.group(2).lower()]
            return date(yr, mo, int(m.group(1))).isoformat()
        except ValueError:
            pass

    # "August 15" or "August 15, 2026"
    m = re.search(
        r"\b(january|february|march|april|may|june|july|august|september|october|november|december|"
        r"jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+"
        r"(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b",
        text,
        re.IGNORECASE,
    )
    if m:
        try:
            yr = int(m.group(3)) if m.group(3) else default_year
            mo = _HOLIDAY_MONTH_MAP[m.group(1).lower()]
            return date(yr, mo, int(m.group(2))).isoformat()
        except ValueError:
            pass

    return None


def _extract_holidays_from_text(raw_text: str) -> list:
    """
    Parse raw PDF text and extract holiday name + date pairs.
    Handles:
      - Table rows:  "Diwali | 20 October 2026"
      - Inline rows: "20-10-2026  Diwali"
      - Mixed:       "Diwali (20 Oct)"
    """
    results = []
    seen_dates = set()

    # Detect dominant year in the document (use current year as fallback)
    year_matches = re.findall(r"\b(20\d{2})\b", raw_text)
    if year_matches:
        from collections import Counter

        default_year = int(Counter(year_matches).most_common(1)[0][0])
    else:
        default_year = datetime.now().year

    lines = [l.strip() for l in raw_text.splitlines() if l.strip()]

    # --- Pass 1: pipe/tab separated table rows ---
    for line in lines:
        if "|" in line or "\t" in line:
            sep = "|" if "|" in line else "\t"
            cols = [c.strip() for c in line.split(sep) if c.strip()]
            date_val = None
            name_col = None
            for col in cols:
                d = _parse_holiday_date(col, default_year)
                if d and d not in seen_dates:
                    date_val = d
                else:
                    if col and not re.match(
                        r"^(sl\.?\s*no|s\.?\s*no|sr\.?\s*no|#|date|day|holiday|occasion|name)$",
                        col,
                        re.IGNORECASE,
                    ):
                        name_col = col
            if date_val and name_col and len(name_col) > 2:
                seen_dates.add(date_val)
                results.append({"name": name_col[:80].strip(), "date": date_val})

    # --- Pass 2: lines where date and name appear together ---
    for line in lines:
        # Skip header-like lines
        if re.match(
            r"^(sl\.?\s*no|s\.?\s*no|sr\.?\s*no|#|date|day|holiday|occasion|name|month)",
            line,
            re.IGNORECASE,
        ):
            continue
        if len(line) < 5:
            continue

        date_val = _parse_holiday_date(line, default_year)
        if not date_val or date_val in seen_dates:
            continue

        # Remove the date portion to get the name
        name = re.sub(
            r"\b\d{1,2}(?:st|nd|rd|th)?[\s\-/]*"
            r"(?:january|february|march|april|may|june|july|august|september|october|november|december|"
            r"jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)[\s,]*\d{0,4}\b",
            "",
            line,
            flags=re.IGNORECASE,
        )
        name = re.sub(r"\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b", "", name)
        name = re.sub(r"\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b", "", name)
        name = re.sub(
            r"\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b",
            "",
            name,
            flags=re.IGNORECASE,
        )
        name = re.sub(r"[\|\-–—,;:()\[\]]+", " ", name)
        name = re.sub(r"\s+", " ", name).strip()

        if len(name) < 3:
            continue

        seen_dates.add(date_val)
        results.append({"name": name[:80], "date": date_val})

    # Sort by date
    results.sort(key=lambda x: x["date"])
    return results


@api_router.post("/holidays/extract-from-pdf")
async def extract_holidays_from_pdf(
    file: UploadFile = File(...), current_user: User = Depends(get_current_user)
):
    """
    100% FREE holiday extractor.
    Uses pdfplumber (already installed) + regex to parse holiday PDFs.
    No API key, no external calls.
    """
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    # Extract all text from the PDF using pdfplumber (already in requirements)
    try:
        import pdfplumber

        parts = []
        with pdfplumber.open(BytesIO(content)) as pdf:
            for page in pdf.pages:
                # Extract plain text
                text = page.extract_text()
                if text:
                    parts.append(text)
                # Also extract tables so pipe-separated logic fires
                for table in page.extract_tables():
                    for row in table:
                        if row:
                            parts.append(
                                "  |  ".join(str(c or "").strip() for c in row)
                            )
        raw_text = "\n".join(parts)
    except Exception as exc:
        logger.error(f"pdfplumber failed: {exc}")
        raise HTTPException(status_code=422, detail=f"Could not read PDF: {str(exc)}")

    if not raw_text or len(raw_text.strip()) < 10:
        raise HTTPException(
            status_code=422,
            detail="No readable text found in PDF. Try a text-based (non-scanned) PDF.",
        )

    holidays = _extract_holidays_from_text(raw_text)

    if not holidays:
        raise HTTPException(
            status_code=404,
            detail="No holidays detected. Make sure the PDF contains dates alongside holiday names.",
        )

    logger.info(
        f"PDF holiday extraction (free): {len(holidays)} holidays found by {current_user.email}"
    )
    return {"holidays": holidays}


# ─────────────────────────────────────────────────────────────────────────────
# TRADEMARK / IP NOTICE PDF EXTRACTOR
# ─────────────────────────────────────────────────────────────────────────────

_TM_MONTH_MAP = {
    "january": 1,
    "jan": 1,
    "february": 2,
    "feb": 2,
    "march": 3,
    "mar": 3,
    "april": 4,
    "apr": 4,
    "may": 5,
    "june": 6,
    "jun": 6,
    "july": 7,
    "jul": 7,
    "august": 8,
    "aug": 8,
    "september": 9,
    "sep": 9,
    "sept": 9,
    "october": 10,
    "oct": 10,
    "november": 11,
    "nov": 11,
    "december": 12,
    "dec": 12,
}


def _parse_tm_date(text: str) -> Optional[str]:
    """
    Parse a date string in any common format used by India's IP Office.
    Returns YYYY-MM-DD string or None.
    """
    if not text:
        return None
    text = text.strip()

    # DD/MM/YYYY or DD-MM-YYYY
    m = re.search(r"\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b", text)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
        except ValueError:
            pass

    # YYYY-MM-DD
    m = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", text)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except ValueError:
            pass

    # "06-04-2026" style already caught above, but also "06 April 2026"
    m = re.search(
        r"\b(\d{1,2})(?:st|nd|rd|th)?[\s\-]+("
        r"january|february|march|april|may|june|july|august|september|october|november|december|"
        r"jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec"
        r")[\s,]+(\d{4})\b",
        text,
        re.IGNORECASE,
    )
    if m:
        try:
            mo = _TM_MONTH_MAP[m.group(2).lower()]
            return date(int(m.group(3)), mo, int(m.group(1))).isoformat()
        except ValueError:
            pass

    return None


def _extract_trademark_notice_data(raw_text: str) -> dict:
    """
    Parse raw text extracted from an IP/trademark notice PDF.

    Handles bilingual (Hindi + English) notices from tmrsearch.ipindia.gov.in.
    Returns a dict with all extracted fields; missing fields are None.
    """
    result = {
        "document_type": None,
        "application_no": None,
        "class": None,
        "application_date": None,
        "used_since": None,
        "applicant_name": None,
        "recipient_name": None,
        "hearing_date": None,
        "letter_date": None,
        "brand_name": None,
        "raw_text_snippet": raw_text[:500].strip(),
    }

    # ── Document Type ────────────────────────────────────────────────────────
    text_lower = raw_text.lower()
    if "show cause" in text_lower or "mis-r" in text_lower:
        result["document_type"] = "Show Cause Hearing Notice"
    elif "examination report" in text_lower:
        result["document_type"] = "Examination Report Notice"
    elif "opposition" in text_lower:
        result["document_type"] = "Opposition Notice"
    elif "renewal" in text_lower:
        result["document_type"] = "Renewal Notice"
    elif "registration" in text_lower and "certificate" in text_lower:
        result["document_type"] = "Registration Certificate"
    else:
        result["document_type"] = "IP Office Notice"

    # ── Application Number ───────────────────────────────────────────────────
    # Handles: "Application No: 5922988" or "Application No. 1234567" or
    # "आवेदन संख्या/Application No: 5922988"
    m = re.search(
        r"(?:application\s*no\.?|app\.?\s*no\.?|आवेदन\s*संख्या)[:\s\/]*(\d{5,10})",
        raw_text,
        re.IGNORECASE,
    )
    if m:
        result["application_no"] = m.group(1).strip()

    # ── Class ────────────────────────────────────────────────────────────────
    m = re.search(
        r"(?:in\s+class(?:es)?|class(?:es)?)[:\s\/]*(\d{1,2}(?:\s*[,&]\s*\d{1,2})*)",
        raw_text,
        re.IGNORECASE,
    )
    if m:
        result["class"] = m.group(1).strip()

    # ── Application Date ─────────────────────────────────────────────────────
    m = re.search(
        r"(?:application\s+date|आवेदन\s+तिथि)[:\s\/]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})",
        raw_text,
        re.IGNORECASE,
    )
    if m:
        result["application_date"] = _parse_tm_date(m.group(1))

    # ── Used Since ───────────────────────────────────────────────────────────
    m = re.search(
        r"(?:used\s+since|उपयोग\s+की\s+तिथि)[:\s\/]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})",
        raw_text,
        re.IGNORECASE,
    )
    if m:
        result["used_since"] = _parse_tm_date(m.group(1))

    # ── Applicant Name ───────────────────────────────────────────────────────
    # "Name of Applicant: MR. RAJESH DHARIWAL"
    m = re.search(
        r"(?:name\s+of\s+applicant|applicant(?:\'s)?\s+name|आवेदक\s+का\s+नाम)[:\s\/]*([A-Z][A-Za-z.\s]{3,60}?)(?:\n|$|\|)",
        raw_text,
        re.IGNORECASE,
    )
    if m:
        result["applicant_name"] = re.sub(r"\s+", " ", m.group(1)).strip().rstrip(".,")

    # ── Recipient / Agent Name ───────────────────────────────────────────────
    # First block: "To,\n<NAME>\n<ADDRESS>" — take line after "To,"
    m = re.search(
        r"(?:सेवा\s+में\s*\/\s*To|To\s*,)\s*\n\s*([A-Z][A-Za-z\s.]{2,50})\n",
        raw_text,
        re.IGNORECASE,
    )
    if m:
        result["recipient_name"] = re.sub(r"\s+", " ", m.group(1)).strip()

    # ── Hearing Date ─────────────────────────────────────────────────────────
    # "fixed for hearing on 06-04-2026" or "दिनांक 06-04-2026 को सुनवाई"
    # Try English first
    m = re.search(
        r"(?:hearing\s+on|fixed\s+for\s+hearing\s+on|scheduled.*?on)\s+(\d{1,2}[-\/]\d{1,2}[-\/]\d{4})",
        raw_text,
        re.IGNORECASE,
    )
    if m:
        result["hearing_date"] = _parse_tm_date(m.group(1))

    if not result["hearing_date"]:
        # Hindi version: "दिनांक 06-04-2026 को सुनवाई"
        m = re.search(r"दिनांक\s+(\d{1,2}[-\/]\d{1,2}[-\/]\d{4})\s+को\s+सुनवाई", raw_text)
        if m:
            result["hearing_date"] = _parse_tm_date(m.group(1))

    if not result["hearing_date"]:
        # Bold date pattern in English block — "on **06-04-2026** as scheduled"
        m = re.search(
            r"\bon\s+(\d{2}[-\/]\d{2}[-\/]\d{4})\s+as\s+scheduled",
            raw_text,
            re.IGNORECASE,
        )
        if m:
            result["hearing_date"] = _parse_tm_date(m.group(1))

    # ── Letter Date ──────────────────────────────────────────────────────────
    # "Dated: 16-02-2026" at top of letter
    m = re.search(
        r"(?:dated?|दिनांक)[:\s]*(\d{1,2}[-\/]\d{1,2}[-\/]\d{4})",
        raw_text,
        re.IGNORECASE,
    )
    if m:
        result["letter_date"] = _parse_tm_date(m.group(1))

    # ── Brand / Mark Name ────────────────────────────────────────────────────
    # Not always present in show cause notices. Try common patterns.
    m = re.search(
        r'(?:trade\s*mark(?:s)?\s+(?:application\s+)?(?:for|of)|in\s+respect\s+of)[:\s]+"?([A-Z][A-Za-z0-9\s&\-\'\.]{1,40})"?',
        raw_text,
        re.IGNORECASE,
    )
    if m:
        result["brand_name"] = m.group(1).strip().strip("\"'")

    return result


@api_router.post("/documents/extract-trademark-notice")
async def extract_trademark_notice(
    file: UploadFile = File(...), current_user: User = Depends(get_current_user)
):
    """
    Extract structured data from a trademark / IP notice PDF.

    No API key required — uses pdfplumber + regex only.
    Works with India IP Office notices (tmrsearch.ipindia.gov.in),
    bilingual Hindi/English format.

    Returns:
        document_type, application_no, class, application_date,
        used_since, applicant_name, recipient_name, hearing_date,
        letter_date, brand_name
    """
    filename = (file.filename or "").lower()
    if not filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    # Extract text using pdfplumber
    try:
        import pdfplumber

        parts = []
        with pdfplumber.open(BytesIO(content)) as pdf:
            for page in pdf.pages:
                text = page.extract_text()
                if text:
                    parts.append(text)
                # Also extract tables — helps with notices that put fields in table cells
                for table in page.extract_tables():
                    for row in table:
                        if row:
                            parts.append(
                                "  |  ".join(str(c or "").strip() for c in row)
                            )
        raw_text = "\n".join(parts)
    except Exception as exc:
        logger.error(f"pdfplumber failed on trademark notice: {exc}")
        raise HTTPException(status_code=422, detail=f"Could not read PDF: {str(exc)}")

    if not raw_text or len(raw_text.strip()) < 20:
        raise HTTPException(
            status_code=422,
            detail="No readable text found. Please upload a text-based (non-scanned) PDF.",
        )

    extracted = _extract_trademark_notice_data(raw_text)

    # Require at minimum an application number OR a hearing date
    if not extracted["application_no"] and not extracted["hearing_date"]:
        raise HTTPException(
            status_code=404,
            detail="Could not find application number or hearing date. "
            "Make sure this is a valid IP Office notice PDF.",
        )

    logger.info(
        f"Trademark notice extracted by {current_user.email}: "
        f"app={extracted['application_no']}, hearing={extracted['hearing_date']}"
    )
    return extracted


# ─────────────────────────────────────────────────────────────────────────────
# GLOBAL EXCEPTION HANDLER
# FIX: Must return a JSONResponse WITH CORS headers so the browser does not
# show a secondary "No Access-Control-Allow-Origin" error when a 500 occurs.
# The CORSMiddleware does NOT add headers to error responses generated by
# exception handlers that run outside the middleware stack, so we add them
# manually here.
# ─────────────────────────────────────────────────────────────────────────────
# NOTE: the actual global handler (universal_exception_handler) lives in
# application_runtime.py and is registered there via
# app.add_exception_handler(Exception, universal_exception_handler) --
# this stray decorator used to have no function body of its own (it was
# truncated by a previous automated code-split) and so silently attached
# itself to the unrelated merge_clients() route below, meaning every
# unhandled exception anywhere in the app would incorrectly invoke
# merge_clients(request, exc) instead of returning a proper error
# response. Removed here; see application_runtime.py for the real fix.

@api_router.post("/clients/merge")
async def merge_clients(payload: dict, current_user: User = Depends(get_current_user)):
    """
    Merge multiple duplicate clients into a primary client.
    payload: { primary_id: str, secondary_ids: [str], field_overrides: {field: value} }
    - Copies all non-null fields from secondaries into primary (primary wins on conflict unless overridden).
    - Merges services, dsc_details, assignments, contact_persons arrays.
    - Re-links tasks, leads, invoices, passwords and due-dates from the secondary
      client id(s) to the primary id, so nothing linked to a deleted duplicate
      goes orphaned.
    - Deletes secondary clients after merge.
    - Requires can_edit_clients permission.
    """
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_edit_clients", False):
        raise HTTPException(
            status_code=403, detail="Permission denied: cannot merge clients"
        )

    primary_id = payload.get("primary_id")
    secondary_ids = payload.get("secondary_ids", [])
    field_overrides = payload.get("field_overrides", {})

    if not primary_id or not secondary_ids:
        raise HTTPException(
            status_code=400, detail="primary_id and secondary_ids are required"
        )

    primary = await db.clients.find_one({"id": primary_id})
    if not primary:
        raise HTTPException(status_code=404, detail="Primary client not found")

    secondaries = []
    for sid in secondary_ids:
        sc = await db.clients.find_one({"id": sid})
        if sc:
            secondaries.append(sc)

    if not secondaries:
        raise HTTPException(status_code=404, detail="No secondary clients found")

    # Build merged document — primary wins unless field is blank
    merged = dict(primary)

    # Scalar fields: fill from secondaries if primary field is empty
    scalar_fields = [
        "email",
        "phone",
        "birthday",
        "address",
        "city",
        "state",
        "gstin",
        "pan",
        "gst_treatment",
        "place_of_supply",
        "referred_by",
        "notes",
        "website",
        "msme_number",
        "gst_address",
        "gst_city",
        "gst_state",
        "gst_pin",
        "cin",
        "llpin",
        "tally_ledger_name",
        "tally_group",
        "credit_limit",
        "opening_balance",
        "opening_balance_type",
        "default_payment_terms",
        "proprietor_name",
        "date_of_incorporation",
        "client_type_label",
        "mca_fetch_date",
        "assigned_to",
        "is_itr_client",
        "itr_data",
    ]
    for sc in secondaries:
        for f in scalar_fields:
            if not merged.get(f) and sc.get(f):
                merged[f] = sc[f]

    # Array merges — deduplicate
    # services
    all_services = list(merged.get("services") or [])
    for sc in secondaries:
        for s in sc.get("services") or []:
            if s and s not in all_services:
                all_services.append(s)
    merged["services"] = all_services

    # dsc_details
    existing_dsc = list(merged.get("dsc_details") or [])
    seen_dsc = {d.get("pan") or d.get("name") for d in existing_dsc}
    for sc in secondaries:
        for d in sc.get("dsc_details") or []:
            key = d.get("pan") or d.get("name")
            if key not in seen_dsc:
                existing_dsc.append(d)
                seen_dsc.add(key)
    merged["dsc_details"] = existing_dsc

    # contact_persons
    existing_contacts = list(merged.get("contact_persons") or [])
    seen_cp = {
        (c.get("name") or "").lower() for c in existing_contacts if c.get("name")
    }
    for sc in secondaries:
        for cp in sc.get("contact_persons") or []:
            key = (cp.get("name") or "").lower()
            if key and key not in seen_cp:
                existing_contacts.append(cp)
                seen_cp.add(key)
    merged["contact_persons"] = existing_contacts

    # assignments
    existing_assignments = list(merged.get("assignments") or [])
    seen_assignments = {a.get("user_id") for a in existing_assignments}
    for sc in secondaries:
        for a in sc.get("assignments") or []:
            uid = a.get("user_id")
            if uid and uid not in seen_assignments:
                existing_assignments.append(a)
                seen_assignments.add(uid)
            elif uid and uid in seen_assignments:
                # merge services into existing assignment
                for ea in existing_assignments:
                    if ea.get("user_id") == uid:
                        ea["services"] = list(
                            set((ea.get("services") or []) + (a.get("services") or []))
                        )
    merged["assignments"] = existing_assignments

    # Apply manual field overrides (user chose to take value from secondary)
    for f, v in field_overrides.items():
        if f not in ("id", "created_by", "created_at", "_id"):
            merged[f] = v

    # Notes — concatenate if both have notes
    primary_notes = (primary.get("notes") or "").strip()
    secondary_notes_parts = [
        (sc.get("notes") or "").strip()
        for sc in secondaries
        if (sc.get("notes") or "").strip()
        and (sc.get("notes") or "").strip() != primary_notes
    ]
    if secondary_notes_parts:
        merged["notes"] = (
            "\n\n---\n\n".join([primary_notes] + secondary_notes_parts)
            if primary_notes
            else "\n\n---\n\n".join(secondary_notes_parts)
        )

    merged["merged_from"] = secondary_ids
    merged["merged_at"] = datetime.now(timezone.utc).isoformat()

    # Update primary
    merged.pop("_id", None)
    await db.clients.update_one({"id": primary_id}, {"$set": merged})

    # Migrate tasks/leads/invoices/passwords/due-dates that reference secondary
    # clients to the primary — so no linked records go orphaned after the merge.
    for sid in secondary_ids:
        await db.tasks.update_many(
            {"client_id": sid}, {"$set": {"client_id": primary_id}}
        )
        await db.leads.update_many(
            {"converted_client_id": sid}, {"$set": {"converted_client_id": primary_id}}
        )
        await db.invoices.update_many(
            {"client_id": sid}, {"$set": {"client_id": primary_id}}
        )
        await db.passwords.update_many(
            {"client_id": sid}, {"$set": {"client_id": primary_id}}
        )
        await db.due_dates.update_many(
            {"client_id": sid}, {"$set": {"client_id": primary_id}}
        )

    # Delete secondaries
    for sid in secondary_ids:
        await db.clients.delete_one({"id": sid})

    # Return updated primary
    updated = await db.clients.find_one({"id": primary_id})
    if updated:
        updated.pop("_id", None)
    return {"success": True, "merged_client": updated, "deleted_ids": secondary_ids}


# ═══════════════════════════════════════════════════════════════════════════════
# CLIENT GROUPS — group clients under a named label
# ═══════════════════════════════════════════════════════════════════════════════


@api_router.get("/client-groups")
async def list_client_groups(current_user: User = Depends(get_current_user)):
    """Return all client groups for this org (stored in client_groups collection)."""
    groups = await db.client_groups.find({}).to_list(length=500)
    for g in groups:
        g.pop("_id", None)
    return groups


@api_router.post("/client-groups")
async def create_client_group(
    payload: dict, current_user: User = Depends(get_current_user)
):
    """Create a new client group. payload: { name, description?, color? }"""
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_edit_clients", False):
        raise HTTPException(status_code=403, detail="Permission denied")

    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Group name is required")

    existing = await db.client_groups.find_one(
        {"name": {"$regex": f"^{name}$", "$options": "i"}}
    )
    if existing:
        raise HTTPException(
            status_code=409, detail="A group with this name already exists"
        )

    group = {
        "id": str(uuid.uuid4()),
        "name": name,
        "description": payload.get("description", ""),
        "color": payload.get("color", "#0D3B66"),
        "client_ids": [],
        "created_by": current_user.id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.client_groups.insert_one(group)
    group.pop("_id", None)
    return group


@api_router.put("/client-groups/{group_id}")
async def update_client_group(
    group_id: str, payload: dict, current_user: User = Depends(get_current_user)
):
    """Update group name/description/color or replace client_ids list."""
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_edit_clients", False):
        raise HTTPException(status_code=403, detail="Permission denied")

    update_fields = {}
    for f in ("name", "description", "color", "client_ids"):
        if f in payload:
            update_fields[f] = payload[f]

    if not update_fields:
        raise HTTPException(status_code=400, detail="No fields to update")

    await db.client_groups.update_one({"id": group_id}, {"$set": update_fields})
    updated = await db.client_groups.find_one({"id": group_id})
    if not updated:
        raise HTTPException(status_code=404, detail="Group not found")
    updated.pop("_id", None)
    return updated


@api_router.delete("/client-groups/{group_id}")
async def delete_client_group(
    group_id: str, current_user: User = Depends(get_current_user)
):
    """Delete a client group (does NOT delete the clients themselves)."""
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_edit_clients", False):
        raise HTTPException(status_code=403, detail="Permission denied")

    result = await db.client_groups.delete_one({"id": group_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Group not found")
    return {"success": True}


@api_router.post("/client-groups/{group_id}/members")
async def add_clients_to_group(
    group_id: str, payload: dict, current_user: User = Depends(get_current_user)
):
    """Add client_ids to a group. payload: { client_ids: [str] }"""
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_edit_clients", False):
        raise HTTPException(status_code=403, detail="Permission denied")

    ids_to_add = payload.get("client_ids", [])
    await db.client_groups.update_one(
        {"id": group_id}, {"$addToSet": {"client_ids": {"$each": ids_to_add}}}
    )
    updated = await db.client_groups.find_one({"id": group_id})
    if not updated:
        raise HTTPException(status_code=404, detail="Group not found")
    updated.pop("_id", None)
    return updated


@api_router.delete("/client-groups/{group_id}/members")
async def remove_clients_from_group(
    group_id: str, payload: dict, current_user: User = Depends(get_current_user)
):
    """Remove client_ids from a group. payload: { client_ids: [str] }"""
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_edit_clients", False):
        raise HTTPException(status_code=403, detail="Permission denied")

    ids_to_remove = payload.get("client_ids", [])
    await db.client_groups.update_one(
        {"id": group_id}, {"$pull": {"client_ids": {"$in": ids_to_remove}}}
    )
    updated = await db.client_groups.find_one({"id": group_id})
    if not updated:
        raise HTTPException(status_code=404, detail="Group not found")
    updated.pop("_id", None)
    return updated


# ── Client Groups direct collection route safety fix ─────────────────────────
# The Clients page calls GET /api/client-groups.
# Register the exact collection endpoint directly on the FastAPI app so it
# cannot fail because of nested router mounting/order behavior.
#
# Keep the existing api_router client-group routes unchanged.
# This direct registration only guarantees the exact collection GET endpoint.

app.add_api_route(
    "/api/client-groups",
    list_client_groups,
    methods=["GET"],
    include_in_schema=False,
)

app.add_api_route(
    "/api/client-groups/",
    list_client_groups,
    methods=["GET"],
    include_in_schema=False,
)

# Mount the routes api_router holds *at this point*. Old FastAPI copied a
# router's routes at include time, so this early mount never contained routes
# added to api_router later (notably trademark_sphere's catch-all
# GET /api/{tm_id}, added in application_runtime). FastAPI 0.141 includes
# routers lazily (a live view), which let that catch-all shadow /api/companies,
# /api/quotations and /api/recruitment. A snapshot restores the old order;
# server.py still mounts the complete api_router afterwards.
from fastapi import APIRouter as _APIRouter

_api_router_snapshot = _APIRouter()
_api_router_snapshot.routes.extend(list(api_router.routes))
app.include_router(_api_router_snapshot)

# ── Recruitment direct API mount ─────────────────────────────────────────────
# EXPLICIT ROUTE SAFETY FIX:
# The People Matrix frontend calls GET /api/recruitment.
# Register the exact collection endpoint directly on the FastAPI app so it
# cannot disappear because of nested router mounting/order issues.
#
# Keep the normal router mount below as well so every other Recruitment
# endpoint (/stats, /{candidate_id}, etc.) remains available unchanged.
app.add_api_route(
    "/api/recruitment",
    recruitment_list_candidates,
    methods=["GET"],
    include_in_schema=False,
)
app.add_api_route(
    "/api/recruitment/",
    recruitment_list_candidates,
    methods=["GET"],
    include_in_schema=False,
)

app.include_router(
    recruitment_router,
    prefix="/api",
    include_in_schema=False,
)

# ── Phase 12 Commercial SaaS API v2 Router ────────────────────────────────────
from backend.api_v2.router_v2 import router as api_v2_router
app.include_router(api_v2_router, prefix="/api")

# ── Phase 11 AI-driven automation endpoints router ───────────────────────────
from backend.ai.ai_router import router as ai_router_router
app.include_router(ai_router_router, prefix="/api")

# ── ADMS machine root-level routes ───────────────────────────────────────────
# ZKTeco / Identix machines configured in ADMS Cloud mode push to these URLs.
# Machine firmware appends these paths to the Server Address automatically:
#   GET/POST  https://api.taskosphere.com/iclock/cdata
#   GET/POST  https://api.taskosphere.com/iclock/getrequest
#   GET/POST  https://api.taskosphere.com/iclock/devicecmd
#
# IMPORTANT: These routes must be at ROOT level — NOT under /api/identix/...
# No auth middleware. No CORS required. Always return plain text "OK".
app.include_router(
    qc_trademark_router, prefix="/api/trademark-qc", tags=["trademark-qc"]
)
from backend.attendance_identix import iclock_getrequest, iclock_cdata, iclock_devicecmd

# Support BOTH ADMS firmware URL conventions.
#
# Some Identix/ZKTeco firmware versions append the legacy ".aspx" suffix
# automatically (for example /iclock/cdata.aspx), while other firmware sends
# the modern extensionless paths (/iclock/cdata).  The device in production
# has been observed using /iclock/cdata.aspx, so both forms must hit the exact
# same handlers.  Do NOT redirect these requests: ADMS firmware may not follow
# redirects and a redirect would prevent the heartbeat from being recorded.
for _path, _handler in (
    ("/iclock/cdata", iclock_cdata),
    ("/iclock/getrequest", iclock_getrequest),
    ("/iclock/devicecmd", iclock_devicecmd),
):
    app.add_api_route(_path, _handler, methods=["GET", "POST"])
    app.add_api_route(f"{_path}.aspx", _handler, methods=["GET", "POST"])
app.include_router(whatsapp_hub_router, prefix="/api")

# ── Commercial Console Control Center Router ──────────────────────────────────
from backend.commercial_console_api import router as commercial_console_router
app.include_router(commercial_console_router)


# ═══════════════════════════════════════════════════════════════════════════════
# ROUTE SAFETY NET — collection endpoints must answer with AND without a
# trailing slash.
#
# The app runs with redirect_slashes=False, so Starlette will NOT redirect
# "/api/notifications/" -> "/api/notifications" (or vice-versa); a one-character
# difference produced hard 404s on list endpoints such as /api/notifications,
# /api/visits and /api/leads while their sibling routes (e.g.
# /api/notifications/unread-count) kept working.
#
# This block runs once, after every router is mounted, and registers the
# missing slash-variant of each already-registered /api route so the two forms
# are always equivalent. It never overwrites an existing route.
#
# _iter_api_routes() walks recursively rather than reading target_app.routes
# as a flat list: some FastAPI/Starlette versions store a sub-router included
# via app.include_router(sub_router) as its own wrapper object (with the
# individual APIRoutes nested one level down inside it) rather than flattening
# them onto the parent immediately. A flat, non-recursive scan silently sees
# zero matching routes in that case — the safety net would report "0 aliases
# registered" and do nothing, with no error, while every bare "/api/x" route
# quietly stops answering to "/api/x/" (this exact failure mode is what
# broke /api/quotations and /api/companies — see git history for the
# incident). Walking recursively makes the aliasing correct regardless of how
# a given FastAPI/Starlette version happens to store included routers.
# ═══════════════════════════════════════════════════════════════════════════════
def _iter_api_routes(routes):
    from fastapi.routing import APIRoute
    from backend.route_inventory import iter_routes as _effective_routes

    # Starlette 1.x keeps included routers as lazy wrappers with no `.routes`
    # attribute, so the recursive walk below finds nothing inside them (the
    # aliasing silently registered 0 variants). Walk the effective routes
    # instead, which works on both old and new Starlette.
    if any(type(r).__name__ == "_IncludedRouter" for r in routes):
        class _Holder:
            pass
        holder = _Holder()
        holder.routes = list(routes)
        yield from _effective_routes(holder)
        return

    seen = set()
    for r in routes:
        if isinstance(r, APIRoute) and id(r) not in seen:
            seen.add(id(r))
            yield r
        # Recurse into anything that itself exposes a `.routes` list — this
        # covers both a plain Starlette Router/Mount and FastAPI's internal
        # "included router" wrapper, whatever it happens to be called in the
        # installed version.
        sub_routes = getattr(r, "routes", None)
        if sub_routes:
            yield from _iter_api_routes(sub_routes)


def _register_slash_variants(target_app) -> None:
    all_routes = list(_iter_api_routes(target_app.routes))
    existing = {(r.path, m) for r in all_routes for m in r.methods}
    aliases = []
    for route in all_routes:
        if not route.path.startswith("/api"):
            continue
        if "{" in route.path:          # never alias parameterised paths
            continue
        variant = route.path[:-1] if route.path.endswith("/") else route.path + "/"
        if variant in ("", "/api"):
            continue
        if any((variant, m) in existing for m in route.methods):
            continue
        aliases.append((route, variant))

    for route, variant in aliases:
        target_app.add_api_route(
            variant,
            route.endpoint,
            methods=list(route.methods),
            response_model=route.response_model,
            status_code=route.status_code,
            dependencies=route.dependencies,
            name=route.name,
            include_in_schema=False,
        )
        for m in route.methods:
            existing.add((variant, m))

    logger.info(f"[routes] slash-variant aliases registered: {len(aliases)}")

    # Loud, specific self-check for the collection endpoints that have broken
    # this way before — if this ever logs a warning again, it means the
    # aliasing above found nothing to do for these paths and they need
    # investigating immediately, not silently.
    critical = ["/api/quotations", "/api/companies"]
    final_paths = {r.path for r in _iter_api_routes(target_app.routes)}
    for base in critical:
        missing = [p for p in (base, base + "/") if p not in final_paths]
        if missing:
            logger.warning(f"[routes] SAFETY NET GAP: {missing} not registered — "
                            f"this endpoint will 404 for some clients")


_register_slash_variants(app)


@app.get("/api/__routes", include_in_schema=False)
async def _debug_list_routes():
    """
    Lightweight introspection endpoint: lists every registered API route.

    Not exposed in the OpenAPI schema (include_in_schema=False on the
    decorator above). Useful for confirming in production that a given
    path/method actually made it onto the app -- e.g. after the slash-variant
    aliasing above runs -- without needing shell access to the container.
    """
    routes_info = [
        {
            "path": r.path,
            "methods": sorted(r.methods) if r.methods else [],
            "name": r.name,
        }
        for r in _iter_api_routes(app.routes)
    ]
    routes_info.sort(key=lambda r: r["path"])
    return {"count": len(routes_info), "routes": routes_info}
