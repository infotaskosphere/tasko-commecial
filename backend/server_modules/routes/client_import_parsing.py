"""Phase 2 extracted subsystem: client_import_parsing.

This is a normal module. It used to be stored as a string (SOURCE) and run
with exec() inside backend.server's namespace. Every name it borrowed from
that shared namespace is now imported explicitly below, from the same
object the shared namespace held. It is loaded (in the original order) by
backend/server_modules/client_import_parsing.py via backend.server_modules.routes.load_into().
"""
from backend.dependencies import db
from backend.dependencies import get_current_user
from backend.models import User
from datetime import datetime
from datetime import timezone
from dateutil import parser
from fastapi import Depends
from fastapi import File
from fastapi import HTTPException
from fastapi import UploadFile
from io import BytesIO
import httpx
import pandas as pd
import re
from backend.server import MCA_API_KEY, api_router, logger  # created in backend/server.py before route modules load

def _strip_watermark(s: str) -> str:
    """Remove single/short watermark chars from start/end of a string."""
    if not s:
        return s
    s = s.strip()
    s = re.sub(r"^[A-Za-z]\s+(?=[A-Z])", "", s)
    s = re.sub(r"\s+[A-Za-z]\s*$", "", s)
    return re.sub(r"\s{2,}", " ", s).strip()


def _clean_gst_watermark(text: str) -> str:
    """
    Remove GST certificate 'Goods and Services Tax Network' watermark fragments.
    The watermark appears as isolated 1-3 character syllables interspersed in the
    extracted text (e.g. x, Ta, es, ic, rv, Se, d, an, ds, oo, G).
    Strategy: remove tokens that are 1-3 chars, all-alpha, and all chars belong
    to the watermark character set, when surrounded by longer real-word neighbors.
    """
    if not text:
        return text
    WM_CHARS = set("goodservicstaxnewrk")
    result_lines = []
    for line in text.splitlines():
        tokens = line.split()
        cleaned = []
        for i, tok in enumerate(tokens):
            tok_alpha = re.sub(r"[^a-zA-Z]", "", tok)
            is_wm_candidate = (
                1 <= len(tok) <= 3
                and len(tok_alpha) >= 1
                and all(c.lower() in WM_CHARS for c in tok_alpha)
                and tok_alpha.isalpha()
            )
            if is_wm_candidate:
                prev_alpha_len = (
                    len(re.sub(r"[^a-zA-Z]", "", tokens[i - 1])) if i > 0 else 0
                )
                next_alpha_len = (
                    len(re.sub(r"[^a-zA-Z]", "", tokens[i + 1]))
                    if i + 1 < len(tokens)
                    else 0
                )
                if prev_alpha_len > 3 and next_alpha_len > 3:
                    continue  # surrounded by real words — discard as watermark
            cleaned.append(tok)
        result_lines.append(" ".join(cleaned))
    return "\n".join(result_lines)


def _parse_gst_reg06_pdf(pdf_bytes: bytes) -> dict:
    """
    Parse a GST Form REG-06 PDF using pdfplumber + regex.
    Handles PDFs with diagonal 'Goods and Services Tax Network' watermark whose
    individual syllables (x, Ta, es, ic, rv, Se, d, an, ds, oo, G ...) bleed
    into the extracted text and contaminate address fields.
    Returns: gstin, legal_name, trade_name, constitution, constitution_raw,
             address, city, state, pin, full_address, registration_type,
             valid_from, partners[{name, designation}].
    """
    from io import BytesIO
    import pdfplumber

    _INDIAN_STATES = {
        "andhra pradesh",
        "arunachal pradesh",
        "assam",
        "bihar",
        "chhattisgarh",
        "goa",
        "gujarat",
        "haryana",
        "himachal pradesh",
        "jharkhand",
        "karnataka",
        "kerala",
        "madhya pradesh",
        "maharashtra",
        "manipur",
        "meghalaya",
        "mizoram",
        "nagaland",
        "odisha",
        "punjab",
        "rajasthan",
        "sikkim",
        "tamil nadu",
        "telangana",
        "tripura",
        "uttar pradesh",
        "uttarakhand",
        "west bengal",
        "andaman and nicobar islands",
        "andaman and nicobar",
        "chandigarh",
        "dadra and nagar haveli and daman and diu",
        "dadra and nagar haveli",
        "daman and diu",
        "delhi",
        "jammu and kashmir",
        "ladakh",
        "lakshadweep",
        "puducherry",
        "pondicherry",
        "uttaranchal",
        "orissa",
    }

    with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
        raw_pages = [p.extract_text() or "" for p in pdf.pages]

    # Apply watermark cleaning to every page
    pages = [_clean_gst_watermark(p) for p in raw_pages]
    page1 = pages[0] if pages else ""
    annexure_b = next(
        (
            p
            for p in pages
            if "Annexure B" in p
            or "Details of Managing" in p
            or "Details of Proprietor" in p
        ),
        "",
    )

    def _find(pat, text, group=1, flags=re.IGNORECASE | re.MULTILINE):
        m = re.search(pat, text, flags)
        return _strip_watermark(m.group(group).strip()) if m else ""

    # ── Core fields ──────────────────────────────────────────────────────────
    gstin = _find(r"Registration Number\s*[:\-]?\s*([A-Z0-9]{15})", page1)

    legal_name = _find(
        r"(?:^\d+\.\s+)?Legal Name\s+([A-Z][A-Z0-9 &.\-,]+?)(?=\s*\n\s*\d+\.|\Z)", page1
    )
    if not legal_name:
        legal_name = _find(r"Legal Name\s*\n\s*([A-Z][A-Z0-9 &.\-,]+)", page1)

    trade_name = _find(
        r"Trade Name,?\s*if any\s+([A-Z][A-Z0-9 &.\-,]+?)(?=\s*\n\s*\d+\.|\Z)", page1
    )
    if not trade_name:
        trade_name = _find(r"Trade Name.*?\n\s*([A-Z][A-Z0-9 &.\-,]+)", page1)

    const_raw = _find(
        r"Constitution of Business\s+([A-Za-z ]+?)(?=\s*\n\s*\d+\.|\Z)", page1
    )
    if not const_raw:
        const_raw = _find(r"Constitution of Business\s*\n\s*([A-Za-z ]+)", page1)

    _cmap = {
        "proprietorship": "proprietor",
        "proprietary": "proprietor",
        "sole proprietorship": "proprietor",
        "proprietor": "proprietor",
        "private limited company": "pvt_ltd",
        "private limited": "pvt_ltd",
        "pvt ltd": "pvt_ltd",
        "pvt. ltd.": "pvt_ltd",
        "limited liability partnership": "llp",
        "llp": "llp",
        "partnership firm": "partnership",
        "partnership": "partnership",
        "huf": "huf",
        "hindu undivided family": "huf",
        "trust": "trust",
        "public limited company": "pvt_ltd",
        "public limited": "pvt_ltd",
        "society": "other",
        "cooperative": "other",
    }
    lc_const = const_raw.lower().strip()
    constitution = _cmap.get(lc_const, "")
    if not constitution:
        if "private limited" in lc_const or "pvt" in lc_const:
            constitution = "pvt_ltd"
        elif "llp" in lc_const or "limited liability" in lc_const:
            constitution = "llp"
        elif "proprietor" in lc_const or "sole " in lc_const:
            constitution = "proprietor"
        elif "partnership" in lc_const:
            constitution = "partnership"
        elif "huf" in lc_const or "hindu undivided" in lc_const:
            constitution = "huf"
        elif "trust" in lc_const:
            constitution = "trust"
        elif "public limited" in lc_const:
            constitution = "pvt_ltd"
        else:
            constitution = "other"

    # ── Address: extract the raw address block after watermark cleaning ───────
    addr_block_m = re.search(
        r"Address of Principal Place of\s*(?:Business)?\s*(.+?)(?=\n\s*\d+\.\s+|Date of Liability|6\.\s|$)",
        page1,
        re.DOTALL | re.IGNORECASE,
    )
    addr_block_raw = ""
    if addr_block_m:
        chunk = addr_block_m.group(1) or ""
        chunk = re.sub(r"(?i)^Business\s*[:\-]?\s*", "", chunk.strip())
        chunk = re.sub(r"(?i)\nBusiness\s*[:\-]?\s*", " ", chunk)
        chunk = re.sub(
            r"(?i)^Address\s+of\s+Principal\s+Place\s+of\s+Business\s*[:\-]?\s*",
            "",
            chunk.strip(),
        )
        chunk = re.sub(r"^\d+\.\s+", "", chunk.strip())
        addr_block_raw = re.sub(r"\s+", " ", chunk).strip()

    address = city = state = pin = full_address = ""

    if addr_block_raw:
        # ── Structured label-bounded extraction ────────────────────────────────
        # After watermark cleaning, the address block looks like:
        # "Building No./Flat No.: 81 Name Of Premises/Building: SHRIJI NAGAR 2
        #  Road/Street: GODADARA Locality/Sub Locality: Limbayat
        #  City/Town/Village: Surat District: Surat State: Gujarat PIN Code: 394210"
        # Some 1-2 char WM residues may still remain between labels.

        ALL_LABELS = [
            r"Floor No\.",
            r"Building No\./Flat No\.",
            r"Name Of Premises/Building",
            r"Road/Street(?:/Lane)?",
            r"Locality/Sub Loc(?:ality)?",
            r"City/Town/Village",
            r"District",
            r"State",
            r"PIN Code",
        ]

        def _lbl(start_pat, stop_pats, text):
            """Extract value between start label and first stop label."""
            stop_re = "|".join(stop_pats)
            m = re.search(
                start_pat
                + r"[:\s]+(?:[A-Za-z]{1,3}\s+)?(.+?)(?=\s+(?:"
                + stop_re
                + r")|$)",
                text,
                re.IGNORECASE | re.DOTALL,
            )
            if not m:
                return ""
            val = m.group(1).strip()
            val = re.sub(r"\s+[A-Za-z]{1,3}\s*$", "", val).strip()
            val = re.sub(r"^[A-Za-z]{1,3}\s+(?=[A-Z0-9])", "", val).strip()
            return _strip_watermark(val)

        floor = _lbl(r"Floor No\.", ALL_LABELS[2:], addr_block_raw)
        building = _lbl(r"Building No\./Flat No\.", ALL_LABELS[2:], addr_block_raw)
        premises = _lbl(r"Name Of Premises/Building", ALL_LABELS[3:], addr_block_raw)
        road = _lbl(r"Road/Street(?:/Lane)?", ALL_LABELS[4:], addr_block_raw)
        locality = _lbl(r"Locality/Sub Loc(?:ality)?", ALL_LABELS[5:], addr_block_raw)
        city_lbl = _lbl(r"City/Town/Village", ALL_LABELS[6:], addr_block_raw)
        district = _lbl(r"District", ALL_LABELS[7:], addr_block_raw)
        state_lbl = _lbl(r"State", ALL_LABELS[8:], addr_block_raw)
        pin_lbl = _find(r"PIN Code[:\s]+(\d{6})", addr_block_raw)

        if any([building, premises, road, city_lbl, state_lbl, pin_lbl]):
            addr_parts = [x for x in [floor, building, premises, road, locality] if x]
            address = ", ".join(addr_parts)
            city = city_lbl or district
            state = state_lbl
            pin = pin_lbl
            full_address = ", ".join(x for x in [address, city, state, pin] if x)
        else:
            # ── Fallback: comma-separated inline address ────────────────────
            full_address = addr_block_raw
            raw = re.sub(
                r"(?i)(signature not verified|digitally signed|date:.*|goods and services tax.*)",
                "",
                addr_block_raw,
            ).strip()
            parts = [p.strip() for p in re.split(r",\s*", raw) if p.strip()]
            parts = [
                re.sub(r"(?i)^address\s*[:\-]\s*", "", p).strip()
                for p in parts
                if p.strip()
            ]

            for i, p in enumerate(parts):
                if re.match(r"^\d{6}$", re.sub(r"\s+", "", p)):
                    pin = re.sub(r"\s+", "", p)
                    parts = parts[:i] + parts[i + 1 :]
                    break

            for i in range(len(parts) - 1, -1, -1):
                if parts[i].lower().strip() in _INDIAN_STATES:
                    state = parts[i].strip().title()
                    parts = parts[:i] + parts[i + 1 :]
                    break

            if parts:
                last = parts[-1].strip()
                prev = parts[-2].strip() if len(parts) > 1 else ""
                if last.lower() == prev.lower():
                    parts = parts[:-1]
                city = parts[-1].strip() if parts else ""
                if city:
                    parts = parts[:-1]
            address = ", ".join(p for p in parts if p)

    # ── Other fields ──────────────────────────────────────────────────────────
    reg_type = _find(r"Type of Registration\s*[\n\r]+\s*([A-Za-z ]+)", page1)
    if not reg_type:
        reg_type = _find(r"Type of Registration\s+([A-Za-z ]+)", page1)
    valid_from = _find(r"Period of Validity\s+From\s+(\d{2}/\d{2}/\d{4})", page1)

    # ── Partners / Directors (Annexure B) ─────────────────────────────────────
    partners = []
    if annexure_b:
        clean_lines = [
            ln
            for ln in annexure_b.split("\n")
            if not re.fullmatch(r"\s*[a-zA-Z]{1,2}\s*", ln)
        ]
        clean = _clean_gst_watermark("\n".join(clean_lines))
        clean = re.sub(r"(?m)^[a-zA-Z]\s+(Designation/Status)", r"\1", clean)

        entries = re.findall(
            r"\d+\s+Name\s+([A-Z][A-Z \-]+?)\s*\n\s*Designation/Status\s+([A-Za-z /]+)",
            clean,
            re.IGNORECASE,
        )
        if not entries:
            entries = re.findall(
                r"Name\s+([A-Z][A-Z \-]+?)\s*\n\s*Designation(?:/Status)?\s+([A-Za-z /]+)",
                clean,
                re.IGNORECASE,
            )
        for name, desig in entries:
            name_clean = _strip_watermark(name.strip())
            desig_clean = _strip_watermark(desig.strip())
            if name_clean:
                partners.append({"name": name_clean, "designation": desig_clean})

    return {
        "gstin": gstin,
        "legal_name": legal_name,
        "trade_name": trade_name,
        "constitution": constitution,
        "constitution_raw": const_raw,
        "address": address,
        "city": city,
        "state": state,
        "pin": pin,
        "full_address": full_address,
        "registration_type": reg_type,
        "valid_from": valid_from,
        "partners": partners,
    }


@api_router.get("/clients/check-gstin")
async def check_gstin(gstin: str, current_user: User = Depends(get_current_user)):
    """
    Check if a client with the given GSTIN already exists in the database.
    Returns { exists: bool, client_id: str|null, company_name: str|null }
    """
    gstin = gstin.strip().upper()
    if not gstin:
        return {"exists": False, "client_id": None, "company_name": None}

    existing = await db.clients.find_one(
        {"gstin": gstin}, {"_id": 1, "company_name": 1}
    )
    if existing:
        return {
            "exists": True,
            "client_id": str(existing["_id"]),
            "company_name": existing.get("company_name", ""),
        }
    return {"exists": False, "client_id": None, "company_name": None}


# ==============================================================
# # UDYAM CERTIFICATE PDF PARSER
# ==============================================================
def _parse_udyam_pdf(pdf_bytes: bytes) -> dict:
    """
    Parse a Udyam Registration Certificate PDF.
    Handles single-column and two-column (side-by-side field) layouts.
    Returns: udyam_number, enterprise_name, msme_type, major_activity,
             mobile, email, date_of_incorporation, address, city, state, pin,
             social_category, pan.
    """
    from io import BytesIO
    import pdfplumber

    with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
        pages = [p.extract_text() or "" for p in pdf.pages]

    full_text = "\n".join(pages)

    def _find(pat, text, group=1, flags=re.IGNORECASE | re.MULTILINE | re.DOTALL):
        m = re.search(pat, text, flags)
        return m.group(group).strip() if m else ""

    # Udyam registration number
    udyam_number = _find(r"(UDYAM-[A-Z]{2}-\d{2}-\d+)", full_text)

    # Enterprise name — strip M/S prefix
    enterprise_name_raw = _find(r"NAME OF ENTERPRISE\s+([^\n]+)", full_text)
    if not enterprise_name_raw:
        enterprise_name_raw = _find(
            r"Name of Enterprise\s*[:\-]?\s*([^\n]+)", full_text
        )
    enterprise_name = re.sub(
        r"(?i)^M[/\.]?S[/\.]?\s+", "", enterprise_name_raw.strip()
    ).strip()

    # MSME type — most recent classification year entry
    type_matches = re.findall(
        r"\d{4}-\d{2,4}\s+(Micro|Small|Medium)", full_text, re.IGNORECASE
    )
    msme_type = (
        type_matches[0].title()
        if type_matches
        else _find(r"\b(Micro|Small|Medium)\b", full_text)
    )

    # Major activity
    major_activity = _find(r"MAJOR ACTIVITY\s+([^\n]+)", full_text)
    if not major_activity:
        major_activity = _find(r"Major Activity\s*[:\-]?\s*([^\n]+)", full_text)

    # Social category
    social_category = _find(
        r"SOCIAL CATEGORY OF\s*\n\s*([A-Z][A-Z ]+?)(?=\s*\n\s*ENTREPRENEUR|\s*ENTREPRENEUR)",
        full_text,
    )
    if not social_category:
        social_category = _find(r"Social Category.*?([A-Z][A-Z ]+?)(?=\n)", full_text)

    # Mobile — prefer 10-digit Indian mobile number
    mobile = _find(r"Mobile(?:\s*No\.?)?\s*[:\-]?\s*(\d{10})", full_text)

    # Email
    email = _find(
        r"Email(?:[\s:]|\s*Id)?\s*[:\-]?\s*([\w.+\-]+@[\w.\-]+\.\w+)", full_text
    )

    # PAN
    pan = _find(r"\bPAN\s+([A-Z]{5}\d{4}[A-Z])\b", full_text)
    if not pan:
        pan = _find(r"\bPAN\b[:\s]+([A-Z]{5}\d{4}[A-Z])\b", full_text)

    # Date of incorporation / registration
    doi_raw = _find(
        r"DATE OF (?:INCORPORATION|REGISTRATION)[^\n]*\n[^\n]*\n\s*(\d{2}/\d{2}/\d{4})",
        full_text,
    )
    if not doi_raw:
        doi_raw = _find(
            r"Date of Incorporation\s*[:\-]?\s*(\d{2}/\d{2}/\d{4})", full_text
        )
    date_of_incorporation = ""
    if doi_raw:
        try:
            from dateutil import parser as date_parser

            date_of_incorporation = date_parser.parse(doi_raw, dayfirst=True).strftime(
                "%Y-%m-%d"
            )
        except Exception:
            date_of_incorporation = doi_raw

    # ── Address — two-column pdfplumber layout ─────────────────────────────────
    # Fields appear as: "LABEL VALUE   LABEL VALUE" on same line (two columns merged)
    # E.g.: "Flat/Door/Block No. PLOT NO. A-8-9-10-11   Name of Premises/ Building DIAMOND ESTATE"

    def _addr_val(label_pat, text, stop_pats=None):
        if stop_pats:
            stop = "|".join(stop_pats)
            m = re.search(
                label_pat + r"\s+([^\n]+?)(?=\s{2,}(?:" + stop + r")\s|\n|$)",
                text,
                re.IGNORECASE,
            )
            if not m:
                m = re.search(
                    label_pat + r"\s+(.+?)(?=\s+(?:" + stop + r")\s|\n|$)",
                    text,
                    re.IGNORECASE | re.DOTALL,
                )
        else:
            m = re.search(label_pat + r"\s+([^\n]+)", text, re.IGNORECASE)
        return m.group(1).strip().rstrip(",") if m else ""

    flat_no = _addr_val(
        r"Flat/Door/Block No\.?",
        full_text,
        stop_pats=[r"Name of Premises", r"Building", r"Village/Town"],
    )
    premises = _addr_val(
        r"Name of Premises/?\s*Building",
        full_text,
        stop_pats=[r"Village/Town", r"Block", r"Road/Street"],
    )
    village = _addr_val(
        r"Village/Town",
        full_text,
        stop_pats=[r"Block\b", r"Road/Street", r"City\b", r"State\b"],
    )
    block_val = _addr_val(
        r"\bBlock\b",
        full_text,
        stop_pats=[r"Road/Street", r"City\b", r"State\b", r"Flat/Door"],
    )
    if len(block_val) <= 1:
        block_val = ""
    road = _addr_val(
        r"Road/Street(?:/Lane)?",
        full_text,
        stop_pats=[r"City\b", r"State\b", r"District\b"],
    )

    city_m = re.search(
        r"\bCity\s+([A-Z][A-Z0-9 ]+?)(?=\s+State\b|\s+District\b|\s*$)",
        full_text,
        re.IGNORECASE | re.MULTILINE,
    )
    city = city_m.group(1).strip().title() if city_m else ""

    state_m = re.search(
        r"\bState\s+([A-Z][A-Z ]+?)(?=\s+District\b|\s*,|\s*$)",
        full_text,
        re.IGNORECASE | re.MULTILINE,
    )
    state = state_m.group(1).strip().title() if state_m else ""

    pin_m = re.search(r"\bPin\s*[:\-,]?\s*(\d{6})", full_text, re.IGNORECASE)
    pin = pin_m.group(1) if pin_m else ""
    if not pin:
        pin_m2 = re.search(r",\s*(\d{6})\b", full_text)
        pin = pin_m2.group(1) if pin_m2 else ""

    district_m = re.search(
        r"\bDistrict\s+([A-Z][A-Z ]+?)(?=\s*,|\s+Pin|\s*$)",
        full_text,
        re.IGNORECASE | re.MULTILINE,
    )
    district = district_m.group(1).strip().title() if district_m else ""
    if not city and district:
        city = district

    addr_parts_raw = [flat_no, premises, block_val, village, road]
    seen_lower = set()
    addr_parts = []
    for p in addr_parts_raw:
        p = p.strip().rstrip(",")
        if not p or len(p) <= 1:
            continue
        if p.lower() in seen_lower:
            continue
        seen_lower.add(p.lower())
        addr_parts.append(p)
    address = ", ".join(addr_parts)

    return {
        "udyam_number": udyam_number,
        "enterprise_name": enterprise_name,
        "msme_type": msme_type,
        "major_activity": major_activity.strip().title() if major_activity else "",
        "social_category": social_category.strip() if social_category else "",
        "mobile": mobile,
        "email": email,
        "date_of_incorporation": date_of_incorporation,
        "pan": pan,
        "address": address,
        "city": city,
        "state": state,
        "pin": pin,
    }


# ── ITR Computation PDF parser ────────────────────────────────────────────────
def _parse_itr_computation_pdf(pdf_bytes: bytes) -> dict:
    """
    Parse an ITR Computation of Income PDF and extract all ITR client fields.
    Handles the standard CA software computation format (e.g. EasyOffice, Winman, Saral TaxOffice).
    Returns a dict with:
      - client fields: company_name, pan, email, phone, address, city, state, date_of_birth
      - itr_data fields: itr_type, assessment_year, acknowledgement_no, filing_date,
                         income_salary, income_house_property, income_business,
                         income_capital_gains, income_other_sources,
                         tax_payable, refund_amount, filing_status
    """
    import pdfplumber
    import re as _re

    with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
        full_text = "\n".join((page.extract_text() or "") for page in pdf.pages)

    text = full_text
    result = {}

    def first(pattern, flags=0, group=1):
        m = _re.search(pattern, text, flags | _re.IGNORECASE)
        if m:
            try:
                return m.group(group).strip()
            except IndexError:
                return ""
        return ""

    def to_float(s):
        if not s:
            return None
        cleaned = _re.sub(r"[^0-9.\-]", "", str(s).replace(",", ""))
        try:
            return float(cleaned)
        except ValueError:
            return None

    # ── Assessee Name ──────────────────────────────────────────────────────
    name = first(r"NAME\s+OF\s+ASSESSEE\s*[:\-]?\s*([A-Z][A-Z\s]+?)(?:\n|PAN|$)")
    if not name:
        name = first(r"ASSESSEE\s*[:\-]\s*([A-Z][A-Z\s]+?)(?:\n|PAN|$)")
    if name:
        result["company_name"] = name.strip()

    # ── PAN ────────────────────────────────────────────────────────────────
    pan = first(r"\bPAN\s*[:\-]?\s*([A-Z]{5}[0-9]{4}[A-Z])\b")
    if pan:
        result["pan"] = pan.upper()

    # ── Assessment Year ────────────────────────────────────────────────────
    ay = first(r"ASSESSMENT\s+YEAR\s*[:\-]?\s*(\d{4}\s*[-–]\s*\d{2,4})")
    if ay:
        # Normalise to "2025-26" format
        ay_clean = _re.sub(r"\s", "", ay)
        m_ay = _re.match(r"(\d{4})[-–](\d{2,4})", ay_clean)
        if m_ay:
            yr = m_ay.group(1)
            suffix = m_ay.group(2)[-2:]
            result["assessment_year"] = f"{yr}-{suffix}"

    # ── Financial Year (fallback for AY) ───────────────────────────────────
    if not result.get("assessment_year"):
        fy = first(r"FINANCIAL\s+YEAR\s*[:\-]?\s*(\d{4}\s*[-–]\s*\d{2,4})")
        if fy:
            fy_clean = _re.sub(r"\s", "", fy)
            m_fy = _re.match(r"(\d{4})[-–](\d{2,4})", fy_clean)
            if m_fy:
                # AY = FY + 1
                yr = int(m_fy.group(1)) + 1
                suffix = str(yr)[-2:]
                result["assessment_year"] = f"{yr}-{suffix}"

    # ── ITR Type ───────────────────────────────────────────────────────────
    itr_type = first(r"\bRETURN\s*[:\-]?\s*(ITR[-\s]?[1-7U])\b")
    if not itr_type:
        itr_type = first(r"\b(ITR[-\s]?[1-7U])\b")
    if itr_type:
        # Normalise "ITR3" → "ITR-3"
        itr_norm = _re.sub(r"ITR\s*", "ITR-", itr_type.upper()).replace("--", "-")
        result["itr_type"] = itr_norm

    # ── Filing Date ────────────────────────────────────────────────────────
    filing_date = first(
        r"(?:FILING\s+DATE|DATE\s+OF\s+FILING)\s*[:\-]?\s*(\d{2}[/\-]\d{2}[/\-]\d{4})"
    )
    if filing_date:
        # Convert DD/MM/YYYY or DD-MM-YYYY → YYYY-MM-DD
        parts = _re.split(r"[/\-]", filing_date)
        if len(parts) == 3 and len(parts[2]) == 4:
            result["filing_date"] = (
                f"{parts[2]}-{parts[1].zfill(2)}-{parts[0].zfill(2)}"
            )

    # ── Acknowledgement Number ─────────────────────────────────────────────
    ack = first(
        r"(?:ACK(?:NOWLEDGEMENT)?\.?\s*NO(?:\.)?|NO\.\s*[:\-])\s*[:\-]?\s*(\d{12,15})"
    )
    if not ack:
        ack = first(r"\b(\d{15})\b")  # 15-digit standalone
    if ack:
        result["acknowledgement_no"] = ack

    # ── Email ──────────────────────────────────────────────────────────────
    email = first(r"\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b")
    if email:
        result["email"] = email.lower()

    # ── Phone ──────────────────────────────────────────────────────────────
    phone_m = _re.search(r"\b((?:\+91[\s\-]?)?[6-9][0-9]{9})\b", text)
    if phone_m:
        result["phone"] = _re.sub(r"\D", "", phone_m.group(1))[-10:]

    # ── Address ────────────────────────────────────────────────────────────
    addr = first(r"RESIDENTIAL\s+ADDRESS\s*[:\-]?\s*([^\n]{10,200})")
    if addr:
        # Multi-line addresses may be joined by commas
        result["address"] = addr.strip().rstrip(",")

    # Extract city / state / pin from address
    if result.get("address"):
        addr_text = result["address"]
        # PIN code
        pin_m = _re.search(r"\b(\d{6})\b", addr_text)
        if pin_m:
            result["pin"] = pin_m.group(1)
        # State (common Indian states)
        state_m = _re.search(
            r"\b(Gujarat|Maharashtra|Rajasthan|Madhya Pradesh|Uttar Pradesh|Karnataka|Tamil Nadu|"
            r"Kerala|West Bengal|Delhi|Haryana|Punjab|Andhra Pradesh|Telangana|Odisha|Bihar|"
            r"Jharkhand|Chhattisgarh|Uttarakhand|Himachal Pradesh|Assam|Goa)\b",
            addr_text,
            _re.IGNORECASE,
        )
        if state_m:
            result["state"] = state_m.group(1).title()
        # City heuristic
        city_m = _re.search(
            r"\b(Surat|Ahmedabad|Mumbai|Delhi|Pune|Bangalore|Bengaluru|Chennai|Hyderabad|"
            r"Kolkata|Jaipur|Vadodara|Rajkot|Indore|Bhopal|Nagpur|Lucknow|Patna|Chandigarh|"
            r"Coimbatore|Visakhapatnam)\b",
            addr_text,
            _re.IGNORECASE,
        )
        if city_m:
            result["city"] = city_m.group(1).title()

    # ── Date of Birth ──────────────────────────────────────────────────────
    dob = first(r"DATE\s+OF\s+BIRTH\s*[:\-]?\s*(\d{2}[/\-]\d{2}[/\-]\d{4})")
    if dob:
        parts = _re.split(r"[/\-]", dob)
        if len(parts) == 3 and len(parts[2]) == 4:
            result["date_of_birth"] = (
                f"{parts[2]}-{parts[1].zfill(2)}-{parts[0].zfill(2)}"
            )

    # ── Ward / Circle ──────────────────────────────────────────────────────
    ward = first(
        r"WARD\s*(?:NO\.?|NUMBER)?\s*[:\-]?\s*([A-Z0-9\s\(\)/,]+?)(?:\n|FINANCIAL|GENDER|$)"
    )
    if ward:
        result["ward"] = ward.strip()

    # ── Gender ─────────────────────────────────────────────────────────────
    gender = first(r"GENDER\s*[:\-]?\s*(MALE|FEMALE|OTHER)")
    if gender:
        result["gender"] = gender.lower()

    # ── Residential Status ─────────────────────────────────────────────────
    res_status = first(
        r"RESIDENTIAL\s+STATUS\s*[:\-]?\s*(RESIDENT|NON.RESIDENT|NRI|RNOR)"
    )
    if res_status:
        result["residential_status"] = res_status.upper()

    # ── Bank Details ───────────────────────────────────────────────────────
    bank_name = first(
        r"NAME\s+OF\s+BANK\s*[:\-]?\s*([A-Z][A-Z\s&.]+?)(?:\n|MICR|IFSC|ACCOUNT|$)"
    )
    if bank_name:
        result["bank_name"] = bank_name.strip()

    ifsc = first(r"IFSC\s+CODE\s*[:\-]?\s*([A-Z]{4}0[A-Z0-9]{6})")
    if ifsc:
        result["ifsc_code"] = ifsc.upper()

    account_no = first(r"ACCOUNT\s+NO\.?\s*[:\-]?\s*(\d{8,20})")
    if account_no:
        result["account_no"] = account_no

    # ── Income Heads ───────────────────────────────────────────────────────
    # Salary
    salary = first(r"TAXABLE\s+SALARY\s+(\d[\d,]+)")
    if not salary:
        salary = first(r"SALARIES\s+(\d[\d,]+)")
    if salary:
        v = to_float(salary.replace(",", ""))
        if v is not None and v > 0:
            result["income_salary"] = v

    # Business / Profession (u/s 44AD etc)
    biz = first(
        r"PROFITS\s+AND\s+GAINS\s+FROM\s+BUSINESS\s+(?:OR\s+PROFESSION\s+)?(\d[\d,]+)"
    )
    if not biz:
        biz = first(
            r"PROFIT\s+(?:DECLARED|HIGHER\s+OF\s+THE\s+ABOVE)\s+(?:U/S\s+44AD[^\d]*)(\d[\d,]+)"
        )
    if biz:
        v = to_float(biz.replace(",", ""))
        if v is not None and v > 0:
            result["income_business"] = v

    # Capital Gains
    cg = first(r"(?:TOTAL\s+)?CAPITAL\s+GAINS?\s+(\d[\d,]+)")
    if not cg:
        # Sum short-term + long-term from doc
        stcg_vals = _re.findall(
            r"SHORT\s+TERM\s+CAPITAL\s+GAIN\s+@\s*\d+%[^0-9\-]*(-?\d[\d,]*)",
            text,
            _re.IGNORECASE,
        )
        ltcg_vals = _re.findall(
            r"LONG\s+TERM\s+CAPITAL\s+GAIN\s+@\s*\d+%[^0-9\-]*(-?\d[\d,]*)",
            text,
            _re.IGNORECASE,
        )
        all_cg = stcg_vals + ltcg_vals
        if all_cg:
            total_cg = sum(to_float(v.replace(",", "")) or 0 for v in all_cg)
            if total_cg != 0:
                result["income_capital_gains"] = round(total_cg, 2)
    else:
        v = to_float(cg.replace(",", ""))
        if v is not None:
            result["income_capital_gains"] = v

    # Other Sources
    other_src = first(r"INCOME\s+FROM\s+OTHER\s+SOURCES\s+(\d[\d,]+)")
    if not other_src:
        other_src = first(r"OTHER\s+SOURCES[^\d]*(\d[\d,]+)")
    if other_src:
        v = to_float(other_src.replace(",", ""))
        if v is not None and v > 0:
            result["income_other_sources"] = v

    # ── Gross Total Income ─────────────────────────────────────────────────
    gti = first(r"GROSS\s+TOTAL\s+INCOME\s+(\d[\d,]+)")
    if gti:
        v = to_float(gti.replace(",", ""))
        if v:
            result["gross_total_income"] = v

    # ── Total Income ───────────────────────────────────────────────────────
    total_income = first(r"TOTAL\s+INCOME\s+ROUNDED\s+OFF[^\d]*(\d[\d,]+)")
    if not total_income:
        total_income = first(r"TOTAL\s+INCOME\s+(\d[\d,]+)")
    if total_income:
        v = to_float(total_income.replace(",", ""))
        if v:
            result["total_income"] = v

    # ── Tax Payable ────────────────────────────────────────────────────────
    tax_payable_raw = first(r"TAX\s+PAYABLE\s+(\d[\d,]+|NIL)")
    if tax_payable_raw and tax_payable_raw.upper() != "NIL":
        v = to_float(tax_payable_raw.replace(",", ""))
        result["tax_payable"] = v if v is not None else 0.0
    else:
        result["tax_payable"] = 0.0

    # Refund
    refund_raw = first(r"REFUND\s+(?:AMOUNT\s+)?(\d[\d,]+)")
    if refund_raw:
        v = to_float(refund_raw.replace(",", ""))
        if v and v > 0:
            result["refund_amount"] = v

    # ── Filing Status heuristic ────────────────────────────────────────────
    if result.get("acknowledgement_no") and result.get("filing_date"):
        result["filing_status"] = "filed"
    else:
        result["filing_status"] = "pending"

    # ── Section 115BAC ────────────────────────────────────────────────────
    bac_m = _re.search(
        r"(?:OPTED\s+FOR\s+TAXATION\s+U/S\s+115BAC|115BAC)[^\n]*(YES|NO)",
        text,
        _re.IGNORECASE,
    )
    if bac_m:
        result["opted_115bac"] = bac_m.group(1).upper() == "YES"

    return result


@api_router.post("/clients/parse-itr-computation-pdf")
async def parse_itr_computation_pdf(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """
    Parse an ITR Computation of Income PDF.
    Returns extracted fields: assessee name, PAN, AY, income heads,
    tax payable, refund, bank details, address, etc.
    Used to auto-fill the ITR Client form.
    """
    filename = (file.filename or "").lower()
    if not filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    content = await file.read()
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="PDF too large — max 20 MB.")

    try:
        result = _parse_itr_computation_pdf(content)
    except Exception as e:
        logger.error(f"parse_itr_computation_pdf error: {e}", exc_info=True)
        raise HTTPException(
            status_code=422,
            detail="Could not parse this PDF. Please ensure it is an ITR Computation of Income document.",
        )

    if not result.get("pan") and not result.get("company_name"):
        raise HTTPException(
            status_code=422,
            detail="No ITR data found. Please upload a valid ITR Computation of Income PDF.",
        )

    return result


def _map_mca_constitution(raw: str) -> str:
    """Map MCA class/constitution/category string → client_type slug."""
    r = (raw or "").lower().strip()
    if "private" in r:
        return "pvt_ltd"
    if "llp" in r or "limited liability partnership" in r:
        return "llp"
    if "public" in r:
        return "public_ltd"
    if "section 8" in r or "section8" in r or "not for profit" in r:
        return "section_8"
    if "one person" in r or "opc" in r:
        return "pvt_ltd"
    if "partnership" in r:
        return "partnership"
    if "proprietor" in r or "sole" in r:
        return "proprietor"
    if "huf" in r or "hindu undivided" in r:
        return "huf"
    if "trust" in r:
        return "trust"
    return "other"


def _clean_obfuscated_email(raw: str) -> str:
    """Decode MCA-style obfuscated emails, e.g.
    'indo[dot]jigar[at]gmail[dot]com' -> 'indo.jigar@gmail.com'."""
    v = (raw or "").strip()
    if not v:
        return ""
    v = re.sub(r"\[\s*at\s*\]", "@", v, flags=re.IGNORECASE)
    v = re.sub(r"\[\s*dot\s*\]", ".", v, flags=re.IGNORECASE)
    v = re.sub(r"\(\s*at\s*\)", "@", v, flags=re.IGNORECASE)
    v = re.sub(r"\(\s*dot\s*\)", ".", v, flags=re.IGNORECASE)
    v = re.sub(r"\s+at\s+", "@", v, flags=re.IGNORECASE)
    v = re.sub(r"\s+dot\s+", ".", v, flags=re.IGNORECASE)
    v = v.replace(" ", "")
    m = re.search(r"[\w.+\-]+@[\w.\-]+\.\w+", v)
    return m.group(0).lower() if m else ""


def _detect_entity_type_from_name(name: str) -> str:
    """Best-effort client_type guess from a company/LLP name suffix."""
    n = (name or "").lower()
    if any(
        x in n
        for x in ["private limited", "pvt ltd", "pvt. ltd", "pvt.ltd", "pvt limited"]
    ):
        return "pvt_ltd"
    if "llp" in n or "limited liability" in n:
        return "llp"
    if any(x in n for x in [" limited", " ltd"]):
        return "public_ltd"
    if "partnership" in n:
        return "partnership"
    if "huf" in n or "hindu undivided" in n:
        return "huf"
    if "trust" in n:
        return "trust"
    return ""


# ── Browser-like headers for web scraping ────────────────────────────────────
_SCRAPE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

from urllib.parse import quote_plus
from bs4 import BeautifulSoup

_CIN_RE = re.compile(r"^[UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$")
_LLPIN_RE = re.compile(r"^[A-Z]{2,3}-\d{4,}$")


def _slugify_company_name(name: str) -> str:
    """Convert a company name to the lowercase-hyphen slug QuickCompany.in
    uses for its /company/<slug> detail pages, e.g.
    'Maple Leaf Ventures LLP' -> 'maple-leaf-ventures-llp'."""
    s = re.sub(r"[^a-zA-Z0-9]+", "-", (name or "").strip().lower())
    return s.strip("-")


# ── ZaubaCorp "meta description" sentence parser ─────────────────────────────
# ZaubaCorp renders a fully static, SEO-friendly paragraph on every company /
# LLP page (and in the <meta name="description"> tag) of the form:
#
#   "<NAME> (CIN: <CIN>) is a <category> company incorporated on <date>. ...
#    Directors of <NAME> are A and B. ... Its Email address is x@y.com and
#    its registered address is <ADDRESS>, <STATE>, India - <PIN> Current
#    status of <NAME> is - Active."
#
#   "<NAME> (LLPIN: <LLPIN>) is a Limited Liability Partnership firm
#    incorporated on <date>. ... Designated Partners of <NAME> are A, and B.
#    ... Its Email address is x@y.com and its registered address is
#    <ADDRESS>, <STATE>, India - <PIN> Current status of <NAME> is - Active."
#
# This text is present in the static HTML (no JS needed), which makes it a
# far more reliable extraction target than label/value grids that are
# populated client-side.
_ZB_CIN = re.compile(
    r"\(CIN:\s*([A-Z0-9]{21})\)|Corporate Identification Number\s*\(CIN\)\s*is\s*([A-Z0-9]{21})",
    re.I,
)
_ZB_LLPIN = re.compile(
    r"\(LLPIN:\s*([A-Z]{2,3}-\d{3,})\)|LLP Identification Number is\s*\(LLPIN\)\s*([A-Z]{2,3}-\d{3,})",
    re.I,
)
_ZB_INCORPORATED = re.compile(r"incorporated on\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})", re.I)
_ZB_CATEGORY = re.compile(r"is a\s+(.+?)\s+incorporated on", re.I)
_ZB_ROC = re.compile(r"Registrar of Companies,\s*([A-Za-z .]+?)\.", re.I)
_ZB_DIRECTORS = re.compile(r"Directors? of [^.]*?\bare\s+(.+?)\.", re.I)
_ZB_PARTNERS = re.compile(r"Designated Partners of [^.]*?\bare\s+(.+?)\.", re.I)
_ZB_EMAIL = re.compile(r"Email address is\s+([\w.+\-]+@[\w.\-]+\.\w+)", re.I)
_ZB_ADDRESS_PIN = re.compile(r"registered address is\s+(.+?)(?:\s*,?\s*(?:India|IN))?\s*(?:-|,)\s*(\d{6})(?:\s*[-,]?\s*(?:India|IN))?(?:\.|$)", re.I)
_ZB_STATUS = re.compile(
    r"Current status of [^.]*?\bis\s*-\s*([A-Za-z][A-Za-z /]*?)\.?\s*$", re.I
)
_ZB_AUTH_CAP = re.compile(r"authorized?\s+share capital is Rs\.?\s*([\d,]+)", re.I)
_ZB_PAIDUP_CAP = re.compile(r"paid[- ]?up capital is Rs\.?\s*([\d,]+)", re.I)


def _parse_zaubacorp_summary(text: str, company_name: str = "") -> dict:
    """Parse ZaubaCorp's descriptive summary paragraph into structured fields."""
    from datetime import date as _date
    from dateutil import parser as date_parser

    text = re.sub(r"\s+", " ", text or "").strip()
    out: dict = {}

    m = _ZB_CIN.search(text)
    if m:
        out["cin"] = (m.group(1) or m.group(2) or "").upper()

    m = _ZB_LLPIN.search(text)
    if m:
        out["llpin"] = (m.group(1) or m.group(2) or "").upper()

    m = _ZB_INCORPORATED.search(text)
    if m:
        try:
            out["date_of_incorporation"] = date_parser.parse(
                m.group(1), dayfirst=True
            ).strftime("%Y-%m-%d")
        except Exception:
            out["date_of_incorporation"] = m.group(1)

    category = ""
    m = _ZB_CATEGORY.search(text)
    if m:
        category = m.group(1).strip()
    elif "limited liability partnership" in text.lower():
        category = "Limited Liability Partnership"

    client_type = _map_mca_constitution(category or company_name)
    if client_type == "other" and out.get("llpin"):
        client_type = "llp"
    out["client_type"] = client_type
    out["company_category"] = category

    m = _ZB_ROC.search(text)
    if m:
        out["roc"] = m.group(1).strip()

    directors_raw = ""
    m = _ZB_PARTNERS.search(text) or _ZB_DIRECTORS.search(text)
    if m:
        directors_raw = m.group(1)
    directors = []
    if directors_raw:
        # "A, B and C" / "A and B" / "A, and B"
        directors_raw = re.sub(r"\s+and\s+", ", ", directors_raw, flags=re.I)
        for part in directors_raw.split(","):
            nm = part.strip(" .")
            if nm and len(nm) > 1:
                directors.append(
                    {
                        "name": nm.title(),
                        "designation": "Director"
                        if "llpin" not in out
                        else "Designated Partner",
                        "din": "",
                    }
                )
    out["directors"] = directors

    m = _ZB_EMAIL.search(text)
    if m:
        out["email"] = m.group(1)

    address = city = state = pin = ""
    m = _ZB_ADDRESS_PIN.search(text)
    if m:
        address_full = m.group(1).strip()
        pin = m.group(2)
        parts = [p.strip() for p in address_full.split(",") if p.strip()]
        if parts and parts[-1].strip().lower() in ("india", "in"):
            parts.pop()
        if parts:
            state = parts.pop().strip()
        if parts:
            words = parts[-1].split()
            if words:
                city = words[-1].strip(" .,")
        address = address_full

    out["address"] = address
    out["city"] = city
    out["state"] = state
    # Keep both aliases for backward compatibility.  The Client form's
    # primary address field uses "pin"; older GST flows use "gst_pin".
    out["pin"] = pin
    out["gst_pin"] = pin

    m = _ZB_STATUS.search(text)
    if m:
        out["company_status"] = m.group(1).strip().rstrip(".")

    m = _ZB_AUTH_CAP.search(text)
    if m:
        out["authorized_capital"] = m.group(1)

    m = _ZB_PAIDUP_CAP.search(text)
    if m:
        out["paid_up_capital"] = m.group(1)

    out["mca_fetch_date"] = _date.today().isoformat()
    out["source"] = "zaubacorp.com"
    return out


async def _scrape_quickcompany(query: str) -> dict:
    """Scrape company details from quickcompany.in. Returns {} on failure.

    QuickCompany serves company-detail pages at the static, predictable URL
    /company/<slug-of-company-name> (e.g. /company/maple-leaf-ventures-llp).
    The company name, director names and director profile links are present
    in the server-rendered HTML; most other fields (CIN, address, financials)
    are populated client-side and are therefore best-effort only here.
    """
    from datetime import date as _date

    q = query.strip()
    is_cin = bool(_CIN_RE.match(q.upper()))
    is_llpin = bool(_LLPIN_RE.match(q.upper()))

    urls_to_try: list[str] = []
    if not is_cin and not is_llpin:
        urls_to_try.append(
            f"https://www.quickcompany.in/company/{_slugify_company_name(q)}"
        )
    # Generic search fallback (best-effort; QuickCompany's /company search is
    # primarily client-rendered so this mostly helps when it does return a
    # server-rendered list of matches)
    urls_to_try.append(f"https://www.quickcompany.in/company?q={q}")

    async with httpx.AsyncClient(
        timeout=15.0, follow_redirects=True, headers=_SCRAPE_HEADERS
    ) as client:
        for url in urls_to_try:
            try:
                resp = await client.get(url)
                if resp.status_code != 200:
                    continue
                soup = BeautifulSoup(resp.text, "html.parser")
                page_text = soup.get_text(" ", strip=True)

                company_name = ""
                h1 = soup.find("h1")
                if h1:
                    company_name = h1.get_text(strip=True)

                detail_soup = soup
                detail_url = url

                # If this looks like a search results page (no clean h1, or
                # h1 doesn't resemble the query), try to follow the first
                # /company/<slug> link to a real detail page.
                if not company_name or "search" in page_text.lower()[:200]:
                    link = soup.find("a", href=re.compile(r"^/company/[a-z0-9\-]+$"))
                    if link:
                        href = link.get("href", "")
                        try:
                            dr = await client.get(f"https://www.quickcompany.in{href}")
                            if dr.status_code == 200:
                                detail_soup = BeautifulSoup(dr.text, "html.parser")
                                detail_url = f"https://www.quickcompany.in{href}"
                                dh1 = detail_soup.find("h1")
                                if dh1:
                                    company_name = dh1.get_text(strip=True)
                                page_text = detail_soup.get_text(" ", strip=True)
                        except Exception:
                            pass

                if not company_name:
                    continue

                # CIN / LLPIN — may appear in JSON-LD / meta tags even if the
                # visible "Company Information" grid is populated client-side.
                found_cin = ""
                cin_m = re.search(
                    r"\b([UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6})\b", page_text
                )
                if cin_m:
                    found_cin = cin_m.group(1)
                found_llpin = ""
                llpin_m = re.search(r"\b([A-Z]{2,3}-\d{4,})\b", page_text)
                if llpin_m and not found_cin:
                    found_llpin = llpin_m.group(1)

                # Directors — rendered server-side as links to /directors/<din>-<slug>
                directors = []
                for a in detail_soup.find_all("a", href=re.compile(r"^/directors/\d")):
                    dname = a.get_text(strip=True)
                    if not dname:
                        continue
                    dhref = a.get("href", "")
                    din_m = re.match(r"^/directors/(\d+)", dhref)
                    directors.append(
                        {
                            "name": dname,
                            "designation": "Designated Partner"
                            if "llp" in (company_name or "").lower() or found_llpin
                            else "Director",
                            "din": din_m.group(1) if din_m else "",
                        }
                    )

                client_type = _map_mca_constitution(company_name)

                return {
                    "company_name": company_name,
                    "cin": found_cin,
                    "llpin": found_llpin or None,
                    "client_type": client_type,
                    "date_of_incorporation": "",
                    "email": "",
                    "address": "",
                    "city": "",
                    "state": "",
                    "gst_pin": "",
                    "pan": "",
                    "directors": directors,
                    "company_status": "",
                    "authorized_capital": "",
                    "paid_up_capital": "",
                    "mca_fetch_date": _date.today().isoformat(),
                    "source": "quickcompany.in",
                    "detail_url": detail_url,
                }
            except Exception as exc:
                logger.debug(f"quickcompany scrape error for {url}: {exc}")
                continue
    return {}


# ── ZaubaCorp search-result table parsing ────────────────────────────────────
# ZaubaCorp's /companysearchresults/company endpoint returns a fully static
# HTML table:
#
#   ### Companies named <term>
#   | CIN / LLPIN                                  | Name                        | Address |
#   |-----------------------------------------------|-----------------------------|---------|
#   | [<CIN>](https://www.zaubacorp.com/<slug>-<CIN>) | [<NAME>](.../<slug>-<CIN>) | ...     |
#
# We try a handful of query-param spellings (the exact one accepted by the
# backend can vary by deployment / caching layer) and, for each response,
# only trust it if the rendered heading actually reflects our search term —
# otherwise it's the generic/default listing and we move on to the next
# candidate.
_ZB_SEARCH_PARAM_CANDIDATES = ["company", "q", "value", "search", "term", "p", "name"]


def _zaubacorp_pick_row(soup: "BeautifulSoup", q: str, is_cin: bool, is_llpin: bool):
    """Return (cin_or_llpin, detail_url, name) for the best-matching row in a
    ZaubaCorp search-results table, or None if nothing usable is found."""
    q_upper = q.strip().upper()
    q_words = [w for w in re.findall(r"[A-Za-z0-9]+", q.lower()) if len(w) > 1]

    best = None
    best_score = -1
    for row in soup.find_all("tr"):
        cells = row.find_all(["td", "th"])
        if len(cells) < 2:
            continue
        id_cell, name_cell = cells[0], cells[1]
        id_text = id_cell.get_text(strip=True).upper()

        name_link = name_cell.find("a", href=True)
        if not name_link:
            continue
        name_text = name_link.get_text(strip=True)
        href = name_link.get("href", "")
        if not href.startswith("http"):
            href = f"https://www.zaubacorp.com{href}"

        if is_cin or is_llpin:
            if id_text == q_upper:
                return id_text, href, name_text
            continue

        # Name-based search: score by how many query words appear in the
        # candidate company name.
        name_lower = name_text.lower()
        score = sum(1 for w in q_words if w in name_lower)
        if score and score > best_score:
            best_score = score
            best = (id_text, href, name_text)

    if best and best_score >= max(1, len(q_words) - 1):
        return best
    return None


def _parse_zaubacorp_directors_table(soup: "BeautifulSoup") -> list:
    """Parse the 'Current Directors & Key Managerial Personnel' table on a
    ZaubaCorp company/LLP detail page.

    The table is fully server-rendered with columns:
        DIN | Director Name | Designation | Appointment Date
    (the DIN and Director Name cells contain links). We only use the
    *current* directors table (skip any 'Past Directors' table, which has an
    extra 'Cessation' column).

    Returns a list of {"name", "designation", "din", "appointment_date"} dicts.
    """
    directors: list = []

    for table in soup.find_all("table"):
        header_row = table.find("tr")
        if not header_row:
            continue
        headers = [
            c.get_text(strip=True).lower() for c in header_row.find_all(["th", "td"])
        ]
        if not headers or "din" not in headers[0]:
            continue
        if "director name" not in " ".join(headers):
            continue
        # Skip past-directors tables (they include a "Cessation" column)
        if any("cessation" in h for h in headers):
            continue

        din_idx = next((i for i, h in enumerate(headers) if "din" in h), 0)
        name_idx = next(
            (i for i, h in enumerate(headers) if "director name" in h or "name" in h), 1
        )
        desig_idx = next((i for i, h in enumerate(headers) if "designation" in h), None)
        appt_idx = next((i for i, h in enumerate(headers) if "appointment" in h), None)

        for row in table.find_all("tr")[1:]:
            cells = row.find_all(["td", "th"])
            if len(cells) <= max(din_idx, name_idx):
                continue
            din = cells[din_idx].get_text(strip=True)
            name = cells[name_idx].get_text(strip=True)
            if not name or not re.match(r"^\d{6,8}$", din):
                continue
            designation = (
                cells[desig_idx].get_text(strip=True)
                if desig_idx is not None and len(cells) > desig_idx
                else "Director"
            )
            appt_date_raw = (
                cells[appt_idx].get_text(strip=True)
                if appt_idx is not None and len(cells) > appt_idx
                else ""
            )
            appt_date = ""
            if appt_date_raw:
                try:
                    from dateutil import parser as date_parser

                    appt_date = date_parser.parse(
                        appt_date_raw, dayfirst=True
                    ).strftime("%Y-%m-%d")
                except Exception:
                    appt_date = appt_date_raw

            directors.append(
                {
                    "name": name.title(),
                    "designation": designation or "Director",
                    "din": din,
                    "appointment_date": appt_date,
                }
            )

        if directors:
            break

    return directors


async def _scrape_zaubacorp(query: str) -> dict:
    """Scrape company details from zaubacorp.com. Returns {} on failure.

    ZaubaCorp pages are fully server-rendered (no JS required), and every
    company/LLP page carries a structured summary sentence describing the
    CIN/LLPIN, incorporation date, directors/partners, email, registered
    address and current status — see _parse_zaubacorp_summary().
    """
    q = query.strip()
    q_upper = q.upper()
    is_cin = bool(_CIN_RE.match(q_upper))
    is_llpin = bool(_LLPIN_RE.match(q_upper))

    hdrs = {**_SCRAPE_HEADERS, "Referer": "https://www.zaubacorp.com/"}
    detail_url = ""
    matched_name = ""

    async with httpx.AsyncClient(
        timeout=15.0, follow_redirects=True, headers=hdrs
    ) as client:
        # ── 1. Resolve a detail-page URL via the search-results table ───────
        for param in _ZB_SEARCH_PARAM_CANDIDATES:
            search_url = f"https://www.zaubacorp.com/companysearchresults/company?{param}={quote_plus(q)}"
            try:
                resp = await client.get(search_url)
                if resp.status_code != 200:
                    continue
                soup = BeautifulSoup(resp.text, "html.parser")

                heading = soup.find(["h1", "h2", "h3"])
                heading_text = (
                    heading.get_text(" ", strip=True).lower() if heading else ""
                )
                # Skip the generic/default listing (heading doesn't mention
                # any part of our query)
                q_words = [
                    w for w in re.findall(r"[A-Za-z0-9]+", q.lower()) if len(w) > 1
                ]
                if (
                    q_words
                    and not any(w in heading_text for w in q_words)
                    and not (is_cin or is_llpin)
                ):
                    continue

                picked = _zaubacorp_pick_row(soup, q, is_cin, is_llpin)
                if picked:
                    company_identifier, detail_url, matched_name = picked
                    break
            except Exception as exc:
                logger.debug(f"zaubacorp search error ({param}) for {q!r}: {exc}")
                continue

        if not detail_url:
            return {}

        # ── 2. Fetch the detail page and parse the summary sentence ─────────
        try:
            dr = await client.get(detail_url)
            if dr.status_code != 200:
                return {}
            ds = BeautifulSoup(dr.text, "html.parser")

            company_name = matched_name
            dh1 = ds.find("h1")
            if dh1:
                h1_text = dh1.get_text(strip=True)
                if h1_text:
                    company_name = h1_text

            meta_desc = ds.find("meta", attrs={"name": "description"})
            summary_text = meta_desc.get("content", "") if meta_desc else ""
            if not summary_text or len(summary_text) < 40:
                summary_text = ds.get_text(" ", strip=True)

            parsed = _parse_zaubacorp_summary(summary_text, company_name)
            # The search result itself carries the canonical CIN/LLPIN in its
            # first column. Preserve it even when the detail-page summary is
            # incomplete or its SEO text changes.
            if company_identifier:
                identifier = str(company_identifier).strip().upper()
                if _CIN_RE.match(identifier):
                    parsed["cin"] = identifier
                elif _LLPIN_RE.match(identifier):
                    parsed["llpin"] = identifier
            parsed["company_name"] = company_name
            parsed["detail_url"] = detail_url

            table_directors = _parse_zaubacorp_directors_table(ds)
            if table_directors:
                parsed["directors"] = table_directors

            return parsed
        except Exception as exc:
            logger.debug(f"zaubacorp detail fetch error for {detail_url}: {exc}")
            return {}


@api_router.get("/clients/fetch-mca-details")
async def fetch_mca_details(
    query: str = "", cin: str = "", current_user: User = Depends(get_current_user)
):
    """
    Fetch company details by company name OR CIN/LLPIN.
    Priority: quickcompany.in → zaubacorp.com → data.gov.in (fallback, needs MCA_API_KEY).
    """
    q = (query or cin or "").strip()
    if not q or len(q) < 3:
        raise HTTPException(
            status_code=400,
            detail="Please enter a company name or CIN (minimum 3 characters).",
        )

    q_upper = q.upper()
    is_cin = bool(_CIN_RE.match(q_upper))
    is_llpin = bool(_LLPIN_RE.match(q_upper))

    # ── Multi-source company master lookup ────────────────────────────────────
    # Do not return the first result: QuickCompany can contain the company name
    # while Zauba contains the CIN/address/incorporation date. Merge every
    # available source so the Client form receives a complete master record.
    source_results: list[dict] = []
    try:
        result = await _scrape_quickcompany(q)
        if result and (result.get("company_name") or result.get("cin")):
            source_results.append(result)
    except Exception as exc:
        logger.warning(f"quickcompany scrape failed: {exc}")

    try:
        result = await _scrape_zaubacorp(q)
        if result and (result.get("company_name") or result.get("cin")):
            source_results.append(result)
    except Exception as exc:
        logger.warning(f"zaubacorp scrape failed: {exc}")

    # ── 3. data.gov.in API (requires MCA_API_KEY, CIN/LLPIN only) ────────────
    if (is_cin or is_llpin) and MCA_API_KEY:
        try:
            async with httpx.AsyncClient(timeout=20.0) as http:
                resp = await http.get(
                    "https://api.data.gov.in/resource/ec58dab7-d891-4abb-936e-d5d274a6ce9b",
                    params={
                        "api-key": MCA_API_KEY,
                        "format": "json",
                        "limit": "1",
                        "filters[CIN]": q_upper,
                    },
                )
                resp.raise_for_status()
                records = resp.json().get("records", [])
                if records:
                    from datetime import date as _date

                    r = records[0]
                    doi = ""
                    raw_doi = (
                        r.get("DATE_OF_REGISTRATION")
                        or r.get("date_of_registration")
                        or ""
                    )
                    if raw_doi:
                        try:
                            from dateutil import parser as dp

                            doi = dp.parse(str(raw_doi), dayfirst=True).strftime(
                                "%Y-%m-%d"
                            )
                        except Exception:
                            doi = str(raw_doi)
                    raw_class = r.get("COMPANY_CLASS") or r.get("company_class") or ""
                    source_results.append({
                        "company_name": r.get("COMPANY_NAME")
                        or r.get("company_name")
                        or "",
                        "cin": q_upper,
                        "llpin": None,
                        "client_type": _map_mca_constitution(raw_class),
                        "date_of_incorporation": doi,
                        "email": "",
                        "address": r.get("REGISTERED_OFFICE_ADDRESS")
                        or r.get("registered_office_address")
                        or "",
                        "city": "",
                        "state": r.get("REGISTERED_STATE")
                        or r.get("registered_state")
                        or "",
                        "gst_pin": "",
                        "pan": "",
                        "directors": [],
                        "company_status": r.get("COMPANY_STATUS")
                        or r.get("company_status")
                        or "",
                        "authorized_capital": r.get("AUTHORISED_CAPITAL_IN_INR") or "",
                        "paid_up_capital": r.get("PAIDUP_CAPITAL_IN_INR") or "",
                        "mca_fetch_date": _date.today().isoformat(),
                        "source": "data.gov.in",
                    })
        except Exception as exc:
            logger.warning(f"data.gov.in fallback failed: {exc}")

    if source_results:
        # Field-level merge: retain the first non-empty value, but prefer
        # authoritative/structured values when a later source provides them.
        merged: dict = {}
        preferred_fields = {
            "cin", "llpin", "date_of_incorporation", "address", "city", "state",
            "pin", "email", "company_status", "authorized_capital",
            "paid_up_capital", "roc", "roc_name", "registration_number",
            "rd_name", "last_agm_date", "balance_sheet_date", "company_category",
            "company_subcategory", "listed", "active_compliance", "charges",
            "directors",
        }
        for item in source_results:
            for key, value in item.items():
                if value in (None, "", [], {}):
                    continue
                if key not in merged or merged.get(key) in (None, "", [], {}):
                    merged[key] = value
                elif key in preferred_fields and key in ("cin", "llpin", "date_of_incorporation", "address", "city", "state", "pin", "roc", "roc_name", "registration_number", "last_agm_date", "balance_sheet_date"):
                    merged[key] = value

        # Normalise common aliases expected by the client form.
        # Different upstream company-master sources use different labels for
        # the same legal field.  Canonicalise them here so the frontend never
        # has to guess which source supplied the value.
        def _first_non_empty(*keys):
            for key in keys:
                value = merged.get(key)
                if value not in (None, "", [], {}):
                    return value
            return ""

        merged["company_name"] = _first_non_empty(
            "company_name", "name", "legal_name", "companyName"
        ) or q
        merged["cin"] = str(_first_non_empty(
            "cin", "cin_number", "corporate_identity_number", "corporate_identification_number"
        ) or (q_upper if is_cin else "")).strip().upper()
        merged["llpin"] = str(_first_non_empty(
            "llpin", "llpin_number", "llp_identification_number"
        ) or (q_upper if is_llpin else "")).strip().upper()
        merged["date_of_incorporation"] = _first_non_empty(
            "date_of_incorporation", "incorporation_date", "date_of_registration"
        )
        merged["address"] = _first_non_empty(
            "address", "registered_address", "registered_office_address",
            "registered_office", "registeredAddress"
        )
        merged["city"] = _first_non_empty("city", "registered_city", "registeredCity")
        merged["state"] = _first_non_empty(
            "state", "registered_state", "registeredState", "registration_state"
        )
        merged["pin"] = str(_first_non_empty(
            "pin", "pincode", "postal_code", "postalCode", "zip", "zip_code",
            "registered_pin", "registered_pincode", "gst_pin"
        ) or "").strip()
        if not merged["pin"] and merged.get("address"):
            pin_match = re.search(r"\b(\d{6})\b", str(merged["address"]))
            if pin_match:
                merged["pin"] = pin_match.group(1)
        # Keep the GST alias as a compatibility field while "pin" is the
        # canonical primary-address PIN consumed by the Client form.
        merged["gst_pin"] = merged.get("gst_pin") or merged.get("pin") or ""
        merged["email"] = _first_non_empty("email", "email_id", "emailId")
        merged["pan"] = _first_non_empty("pan", "pan_number", "panNumber")
        merged["registration_number"] = _first_non_empty(
            "registration_number", "registration_no", "registrationNumber"
        )
        merged["roc"] = _first_non_empty("roc", "roc_name", "registrar_of_companies")
        merged["roc_name"] = _first_non_empty("roc_name", "roc", "registrar_of_companies")
        merged["rd_name"] = _first_non_empty("rd_name", "rd", "rd_region")
        merged["company_category"] = _first_non_empty(
            "company_category", "category", "company_class", "class_of_company"
        )
        merged["company_subcategory"] = _first_non_empty(
            "company_subcategory", "subcategory", "company_sub_category"
        )
        merged["active_compliance"] = _first_non_empty(
            "active_compliance", "active_compliance_status"
        )
        merged["authorized_capital"] = _first_non_empty(
            "authorized_capital", "authorised_capital", "authorized_share_capital"
        )
        merged["paid_up_capital"] = _first_non_empty(
            "paid_up_capital", "paidup_capital", "paid_up_share_capital"
        )
        merged["last_agm_date"] = _first_non_empty(
            "last_agm_date", "date_of_last_agm", "agm_date"
        )
        merged["balance_sheet_date"] = _first_non_empty(
            "balance_sheet_date", "date_of_balance_sheet", "last_balance_sheet_date"
        )
        merged["books_address"] = _first_non_empty(
            "books_address", "books_of_account_address",
            "address_at_which_books_of_account_are_maintained"
        )
        merged["company_status"] = _first_non_empty(
            "company_status", "status", "companyStatus"
        )
        if not isinstance(merged.get("charges"), list):
            merged["charges"] = []
        if not isinstance(merged.get("loan_details"), list):
            merged["loan_details"] = []
        if not isinstance(merged.get("directors"), list):
            merged["directors"] = []
        if not merged.get("client_type"):
            merged["client_type"] = _detect_entity_type_from_name(merged.get("company_name", ""))
        merged["mca_fetch_date"] = datetime.now(timezone.utc).date().isoformat()
        merged["source"] = " + ".join(dict.fromkeys(str(x.get("source")) for x in source_results if x.get("source")))
        return merged

    raise HTTPException(
        status_code=404,
        detail=f"No company found for '{q}'. Try a more specific name or the exact CIN/LLPIN.",
    )


def _parse_mca_pdf(pdf_bytes: bytes) -> dict:
    """
    Parse an MCA Company Master Data PDF (printed from mca.gov.in).
    Handles the 'Company Master Data' format where:
      - Address appears on the line BEFORE the 'Registered Address' label
      - Director DIN and name may be on separate lines
    """
    from io import BytesIO
    import pdfplumber
    from dateutil import parser as date_parser

    with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
        pages = [p.extract_text() or "" for p in pdf.pages]

    full_text = "\n".join(pages)
    lines = [l.rstrip() for l in full_text.splitlines()]

    def _find(pat, text, group=1, flags=re.IGNORECASE | re.MULTILINE | re.DOTALL):
        m = re.search(pat, text, flags)
        return m.group(group).strip() if m else ""

    def _line_val(label, default=""):
        """Extract value that follows label on the same line (tab or multi-space separated)."""
        # Try wide-spaced: "Label              VALUE"
        pat = re.compile(r"^\s*" + re.escape(label) + r"\s{2,}(.+)$", re.IGNORECASE)
        for line in lines:
            m = pat.match(line)
            if m:
                val = m.group(1).strip()
                if val and val not in ("-", "nan", ""):
                    return val
        # Fallback: single-space separated
        pat2 = re.compile(r"^\s*" + re.escape(label) + r"\s+(.+)$", re.IGNORECASE)
        for line in lines:
            m = pat2.match(line)
            if m:
                val = m.group(1).strip()
                if val and val not in ("-", "nan", ""):
                    return val
        return default

    # ── CIN / LLPIN ──────────────────────────────────────────────────────────
    cin = _find(r"\bCIN\s+([UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6})\b", full_text)
    llpin = _find(r"\bLLPIN\s+([A-Z]{3}-\d{4,})\b", full_text)
    if not cin and not llpin:
        cin = _find(r"\bCIN\b\s+([A-Z0-9]{21})\b", full_text)

    # ── Company / LLP Name ────────────────────────────────────────────────────
    company_name = _line_val("Company Name")
    if not company_name:
        company_name = _line_val("LLP Name")
    if not company_name:
        m = re.search(
            r"^Company Name\s*\n\s*([A-Z][A-Z0-9 &.\-]+)",
            full_text,
            re.IGNORECASE | re.MULTILINE,
        )
        if m:
            company_name = m.group(1).strip()

    # ── Company Category / Class (used to derive client_type) ─────────────────
    company_category = (
        _line_val("Company Category")
        or _line_val("Class of Company")
        or _line_val("Company SubCategory")
        or _line_val("Type of Company")
        or ""
    )
    client_type = _map_mca_constitution(company_category)
    if client_type == "other":
        client_type = _map_mca_constitution(company_category + " " + company_name)
    if client_type == "other" and llpin:
        client_type = "llp"
    if client_type == "other":
        client_type = _detect_entity_type_from_name(company_name)
    if not client_type:
        client_type = "other"

    # ── Date of Incorporation ─────────────────────────────────────────────────
    doi_raw = _line_val("Date of Incorporation")
    date_of_incorporation = ""
    if doi_raw:
        try:
            date_of_incorporation = date_parser.parse(doi_raw, dayfirst=True).strftime(
                "%Y-%m-%d"
            )
        except Exception:
            date_of_incorporation = ""

    # ── Email (MCA may obfuscate with [at] / [dot]) ───────────────────────────
    email_raw = _line_val("Email Id") or _line_val("Email")
    email = _clean_obfuscated_email(email_raw)
    if not email:
        em = re.search(r"[\w.+\-]+@[\w.\-]+\.\w+", full_text)
        email = em.group(0).lower() if em else ""

    # ── Registered Address ───────────────────────────────────────────────────
    # MCA website format: address text may wrap and the label can appear BETWEEN
    # the two address lines, e.g.
    #   1088 A, RAJMAHAL MALL DINDOLI, KHARWASA ROAD, Surat, SURAT,
    #   Registered Address
    #   Gujarat, India, 394210
    address = city = state = pin = ""
    SKIP_RE = re.compile(
        r"^(Address at which|Listed|Authorised|Auth\.?|Paid|Date of|Company Status|"
        r"Small Company|Category|Subcategory|Class of|Type of|ACTIVE|Director|Sr\.|DIN|"
        r"Index of|Jurisdiction|ROC|RD\b|Email|CIN|LLPIN|Registration Number|"
        r"Company Name|LLP Name)",
        re.IGNORECASE,
    )
    for i, line in enumerate(lines):
        if re.match(r"^\s*Registered\s+(Office\s+)?Address\s*$", line, re.IGNORECASE):
            part1 = lines[i - 1].strip() if i > 0 else ""
            part2 = lines[i + 1].strip() if i + 1 < len(lines) else ""
            if SKIP_RE.match(part1):
                part1 = ""
            if SKIP_RE.match(part2):
                part2 = ""
            address = (
                (part1.rstrip(",") + ", " + part2).strip(", ")
                if (part1 and part2)
                else (part1 or part2)
            )
            break
        m = re.match(
            r"^\s*Registered\s+(?:Office\s+)?Address\s{2,}(.+)$", line, re.IGNORECASE
        )
        if m:
            address = m.group(1).strip()
            # may continue on next line until label
            if (
                i + 1 < len(lines)
                and lines[i + 1].strip()
                and not SKIP_RE.match(lines[i + 1].strip())
            ):
                address = (address.rstrip(",") + ", " + lines[i + 1].strip()).strip(
                    ", "
                )
            break

    if not address:
        m = re.search(
            r"Registered(?:\s+Office)?\s+Address\s*\n([^\n]+)", full_text, re.IGNORECASE
        )
        if m:
            address = m.group(1).strip()

    # Collapse double commas / stray whitespace
    if address:
        address = re.sub(r"\s*,\s*,+\s*", ", ", address)
        address = re.sub(r"\s+", " ", address).strip(" ,")

    INDIAN_STATES = [
        "Andhra Pradesh",
        "Arunachal Pradesh",
        "Assam",
        "Bihar",
        "Chhattisgarh",
        "Goa",
        "Gujarat",
        "Haryana",
        "Himachal Pradesh",
        "Jharkhand",
        "Karnataka",
        "Kerala",
        "Madhya Pradesh",
        "Maharashtra",
        "Manipur",
        "Meghalaya",
        "Mizoram",
        "Nagaland",
        "Odisha",
        "Orissa",
        "Punjab",
        "Rajasthan",
        "Sikkim",
        "Tamil Nadu",
        "Telangana",
        "Tripura",
        "Uttar Pradesh",
        "Uttarakhand",
        "West Bengal",
        "Andaman and Nicobar Islands",
        "Chandigarh",
        "Dadra and Nagar Haveli and Daman and Diu",
        "Daman and Diu",
        "Delhi",
        "Jammu and Kashmir",
        "Ladakh",
        "Lakshadweep",
        "Puducherry",
        "Pondicherry",
    ]
    STATE_CODES = {
        "GJ": "Gujarat",
        "MH": "Maharashtra",
        "DL": "Delhi",
        "KA": "Karnataka",
        "TN": "Tamil Nadu",
        "UP": "Uttar Pradesh",
        "RJ": "Rajasthan",
        "WB": "West Bengal",
        "AP": "Andhra Pradesh",
        "TS": "Telangana",
        "HR": "Haryana",
        "PB": "Punjab",
        "MP": "Madhya Pradesh",
        "OR": "Odisha",
        "BR": "Bihar",
        "KL": "Kerala",
        "UK": "Uttarakhand",
        "JH": "Jharkhand",
        "HP": "Himachal Pradesh",
        "GA": "Goa",
        "AS": "Assam",
        "CG": "Chhattisgarh",
        "JK": "Jammu and Kashmir",
    }
    GENERIC_LOC = {"india", "bharat", "in"}

    if address:
        # PIN
        pin_m = re.search(r"\b(\d{6})\b", address)
        pin = pin_m.group(1) if pin_m else ""

        # State: prefer full name match, fall back to 2-letter code before PIN
        addr_lower = address.lower()
        for s in sorted(INDIAN_STATES, key=len, reverse=True):
            if re.search(
                r"(^|[,\s])" + re.escape(s.lower()) + r"($|[,\s])", addr_lower
            ):
                state = s
                break
        if not state:
            sc_m = re.search(r"\b([A-Z]{2})\s+\d{6}\b", address)
            if sc_m and sc_m.group(1) in STATE_CODES:
                state = STATE_CODES[sc_m.group(1)]

        # City: strip PIN, country, state, and trailing state-code; take last token
        addr_clean = re.sub(r",?\s*\d{6}\s*$", "", address).strip(" ,")
        addr_clean = re.sub(
            r",?\s*(India|Bharat|IN)\s*$", "", addr_clean, flags=re.IGNORECASE
        ).strip(" ,")
        if state:
            addr_clean = re.sub(
                r",?\s*" + re.escape(state) + r"\s*$",
                "",
                addr_clean,
                flags=re.IGNORECASE,
            ).strip(" ,")
        # Strip trailing 2-letter state code ONLY if it's a known code,
        # otherwise we mangle words like 'SURAT' -> 'SUR'.
        m_sc = re.search(r",\s*([A-Z]{2})\s*$", addr_clean)
        if m_sc and m_sc.group(1) in STATE_CODES:
            addr_clean = addr_clean[: m_sc.start()].strip(" ,")
        parts = [x.strip() for x in addr_clean.split(",") if x.strip()]
        # Drop trailing generic tokens
        while parts and parts[-1].lower() in GENERIC_LOC:
            parts.pop()
        # Drop trailing token if it equals the state
        while parts and state and parts[-1].lower() == state.lower():
            parts.pop()
        if parts and not city:
            # Pick last non-numeric token >= 2 chars
            for tok in reversed(parts):
                t = tok.strip().strip(".")
                if len(t) >= 2 and not re.fullmatch(r"\d+", t):
                    city = t.title()
                    break

    # ── Company Status ────────────────────────────────────────────────────────
    company_status = _line_val("Company Status(for efiling)") or _line_val(
        "Company Status"
    )

    # ── Directors ─────────────────────────────────────────────────────────────
    directors = []
    dir_start = None
    for i, line in enumerate(lines):
        if re.search(r"Director[s/]*Signatory Details", line, re.IGNORECASE):
            dir_start = i + 1
            break

    if dir_start is not None:
        dir_lines = lines[dir_start:]
        # Row may be one of:
        #   <Sr.No>? <DIN/PAN> <NAME?> <Designation> <Category?> <Date> ...
        # The director name may also wrap onto the line above and/or below.
        # Match: optional leading Sr.No, DIN/PAN, anything (incl. partial name),
        # then a designation keyword, then a date.
        row_re = re.compile(
            r"^\s*(?:\d{1,3}\s+)?"  # optional Sr.No
            r"(\d{8}|[A-Z]{5}\d{4}[A-Z])\s+"  # DIN (8 digits) or PAN
            r"(.*?)"  # middle (may include name fragment + category)
            r"\b(Director|Designated Partner|Partner|Manager|Whole[- ]?Time Director|"
            r"Managing Director|Additional Director|Nominee Director|Independent Director|"
            r"Secretary|Chief[A-Za-z ]*|Chairman)\b"
            r"[A-Za-z ]*?\s+"  # optional category words
            r"(\d{2}/\d{2}/\d{4})",  # appointment date
            re.IGNORECASE,
        )
        noise_re = re.compile(
            r"^(Sr\.|Sr|No|DIN|PAN|Name|Designation|Category|Date|Signatory|"
            r"Cessation|Appointment|of|-)$",
            re.IGNORECASE,
        )

        def _clean_name_part(s):
            s = (s or "").strip()
            # Remove a known designation/category word if it leaks in
            s = re.sub(
                r"\b(Director|Partner|Promoter|Independent|Nominee|Additional|"
                r"Managing|Whole[- ]?Time|Designated|Secretary|Manager|Chairman|"
                r"Chief[A-Za-z ]*|Professional|Shareholder)\b",
                "",
                s,
                flags=re.IGNORECASE,
            )
            s = re.sub(r"\d", "", s)  # strip digits / dates leftovers
            s = re.sub(r"[\.\-/]+", " ", s)
            s = re.sub(r"\s+", " ", s).strip()
            # Keep only letters and spaces
            s = re.sub(r"[^A-Za-z ]", "", s).strip()
            return s

        for j, line in enumerate(dir_lines):
            m = row_re.search(line)
            if not m:
                continue
            din = m.group(1).strip()
            middle = _clean_name_part(m.group(2))
            desig = m.group(3).strip().title()
            # Collect name fragments from line above / below (single-token wrap is common)
            nb = dir_lines[j - 1].strip() if j > 0 else ""
            na = dir_lines[j + 1].strip() if j + 1 < len(dir_lines) else ""
            if noise_re.match(nb) or row_re.search(nb):
                nb = ""
            if noise_re.match(na) or row_re.search(na):
                na = ""
            nb_clean = (
                _clean_name_part(nb) if nb and re.match(r"^[A-Za-z .\-]+$", nb) else ""
            )
            na_clean = (
                _clean_name_part(na) if na and re.match(r"^[A-Za-z .\-]+$", na) else ""
            )
            full_name = " ".join(x for x in [nb_clean, middle, na_clean] if x).strip()
            full_name = re.sub(r"\s+", " ", full_name).title() or "Unknown"
            # Skip duplicates by DIN
            if din and any(d.get("din") == din for d in directors):
                continue
            directors.append(
                {
                    "name": full_name,
                    "designation": desig,
                    "email": None,
                    "phone": None,
                    "birthday": None,
                    "din": din if din not in ("-", "") else None,
                }
            )
        # Fallback: DIN followed by Name on same line (no leading Sr.No)
        if not directors:
            din_re = re.compile(
                r"(\d{8})\s+([A-Z][A-Z .\-]+?)\s+(\d{2}/\d{2}/\d{4})", re.IGNORECASE
            )
            for line in dir_lines:
                m = din_re.search(line)
                if m:
                    directors.append(
                        {
                            "name": m.group(2).strip().title(),
                            "designation": "Director",
                            "email": None,
                            "phone": None,
                            "birthday": None,
                            "din": m.group(1).strip(),
                        }
                    )

    # ── Additional MCA master-data fields ───────────────────────────────────
    def _line_val_any(*labels):
        for label in labels:
            value = _line_val(label)
            if value:
                return value
        return ""

    roc_name = _line_val_any("ROC (name and office)", "ROC Name")
    registration_number = _line_val_any("Registration Number")
    rd_name = _line_val_any("RD (name and Region)", "RD Name")
    active_compliance = _line_val_any("ACTIVE compliance")
    subcategory = _line_val_any("Subcategory of the Company", "Company Subcategory", "Company SubCategory")
    listed_raw = _line_val_any("Listed in Stock Exchange(s) (Y/N)", "Listed in Stock Exchange")
    authorized_capital = _line_val_any("Authorised Capital (Rs)", "Authorized Capital (Rs)")
    paid_up_capital = _line_val_any("Paid up Capital (Rs)", "Paid-up Capital (Rs)")
    last_agm_date = _line_val_any("Date of last AGM", "Last AGM Date")
    balance_sheet_date = _line_val_any("Date of Balance Sheet", "Balance Sheet Date")
    books_address = _line_val_any("Address at which the books of account are to be maintained")

    # Charge register. The sample supplied by the user correctly shows
    # "No Records Found"; in that case keep an empty list instead of inventing
    # a loan/charge.
    charges = []
    charge_start = None
    for i, line in enumerate(lines):
        if re.search(r"Index of Charges", line, re.IGNORECASE):
            charge_start = i + 1
            break
    if charge_start is not None:
        charge_text = "\n".join(lines[charge_start:])
        if not re.search(r"No Records Found", charge_text, re.IGNORECASE):
            charge_headers = re.compile(r"(charge|sr\.?\s*no|amount|date|holder|asset|status)", re.I)
            for j in range(charge_start, min(len(lines), charge_start + 40)):
                row = lines[j].strip()
                if row and charge_headers.search(row):
                    charges.append({"raw": row})
            # Deduplicate raw rows.
            seen_charge = set()
            charges = [x for x in charges if not (x["raw"] in seen_charge or seen_charge.add(x["raw"]))]

    # Parse dates for master-data dates when present.
    def _master_date(value):
        if not value or value in ("-", "nan"):
            return ""
        try:
            return date_parser.parse(value, dayfirst=True).strftime("%Y-%m-%d")
        except Exception:
            return value

    return {
        "company_name": company_name,
        "cin": cin or "",
        "llpin": llpin,
        "client_type": client_type,
        "company_category": company_category,
        "company_subcategory": subcategory,
        "email": email,
        "phone": "",
        "date_of_incorporation": date_of_incorporation,
        "address": address,
        "city": city,
        "state": state,
        "pin": pin,
        "company_status": company_status,
        "roc": roc_name,
        "roc_name": roc_name,
        "registration_number": registration_number,
        "rd_name": rd_name,
        "active_compliance": active_compliance,
        "listed": str(listed_raw).strip().lower() in ("yes", "y", "true", "1"),
        "authorized_capital": authorized_capital,
        "paid_up_capital": paid_up_capital,
        "last_agm_date": _master_date(last_agm_date),
        "balance_sheet_date": _master_date(balance_sheet_date),
        "books_address": books_address,
        "charges": charges,
        "directors": directors,
        "pan": "",
        "raw": {},
    }


@api_router.post("/clients/parse-multi-documents")
async def parse_multi_documents(
    files: list[UploadFile] = File(...), current_user: User = Depends(get_current_user)
):
    """
    Accept 1-3 documents: GST Registration Certificate (PDF),
    Udyam/MSME Certificate (PDF), or MCA Company Master Data (PDF or Excel).
    Auto-detects document type for each file, parses, and merges into one
    client record.  Field priority: GST > Udyam > MCA.
    """
    gst_data: dict = {}
    udyam_data: dict = {}
    mca_data: dict = {}
    doc_types_found: list = []

    for file in files:
        raw_content = await file.read()
        fname = (file.filename or "").lower()
        ext = fname.rsplit(".", 1)[-1] if "." in fname else ""

        if ext == "pdf":
            try:
                import pdfplumber

                with pdfplumber.open(BytesIO(raw_content)) as pdf:
                    fp_text = (pdf.pages[0].extract_text() or "") if pdf.pages else ""
                    sp_text = (
                        (pdf.pages[1].extract_text() or "")
                        if len(pdf.pages) > 1
                        else ""
                    )
            except Exception:
                fp_text = sp_text = ""

            combined = (fp_text + "\n" + sp_text).lower()

            # ── Document type detection ─────────────────────────────────────
            # Udyam: unambiguous — UDYAM-XX-YY-NNNNN pattern
            is_udyam = bool(re.search(r"UDYAM-[A-Z]{2}-\d{2}-\d+", fp_text + sp_text))

            # GST REG-06: form title + 15-char GSTIN (2 digits + 5 alpha + 4 digits + 1 alpha + 1 digit + Z + 1 alphanum)
            is_gst = bool(
                re.search(
                    r"\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z0-9]\b",
                    fp_text + sp_text,
                    re.IGNORECASE,
                )
            ) or ("form gst" in combined or "gst reg-06" in combined)

            # MCA: Company Master Data / Ministry of Corporate Affairs PDFs
            is_mca = (
                "company master data" in combined
                or "ministry of corporate affairs" in combined
                or "mca services" in combined
                or (
                    bool(re.search(r"\bCIN\s+[UL]\d{5}", fp_text, re.IGNORECASE))
                    and any(
                        k in combined
                        for k in [
                            "company name",
                            "llp name",
                            "registered address",
                            "date of incorporation",
                            "company status",
                        ]
                    )
                )
            )

            # Resolve: Udyam > GST > MCA (most-specific first)
            if is_udyam and not udyam_data:
                try:
                    udyam_data = _parse_udyam_pdf(raw_content)
                    doc_types_found.append("Udyam Certificate")
                except Exception as e:
                    logger.warning(f"Udyam parse failed: {e}")
            elif is_gst and not gst_data:
                try:
                    gst_data = _parse_gst_reg06_pdf(raw_content)
                    doc_types_found.append("GST Certificate")
                except Exception as e:
                    logger.warning(f"GST parse failed: {e}")
            elif is_mca and not mca_data:
                try:
                    mca_data = _parse_mca_pdf(raw_content)
                    doc_types_found.append("MCA Master Data")
                except Exception as e:
                    logger.warning(f"MCA PDF parse failed: {e}")

        elif ext in ("xlsx", "xls") and not mca_data:
            try:
                excel = pd.ExcelFile(BytesIO(raw_content))
                company_info: dict = {}
                directors: list = []

                for sheet_name in excel.sheet_names:
                    df = pd.read_excel(
                        excel, sheet_name=sheet_name, header=None
                    ).fillna("")
                    sheet_lower = sheet_name.lower().strip()
                    if any(
                        k in sheet_lower for k in ["master", "company", "masterdata"]
                    ):
                        for _, row in df.iterrows():
                            key = str(row.iloc[0]).strip()
                            val = str(row.iloc[1]).strip() if len(row) > 1 else ""
                            if (
                                key
                                and key not in ("", "nan")
                                and val not in ("", "nan")
                            ):
                                company_info[key] = val
                    elif any(
                        k in sheet_lower for k in ["director", "signatory", "partner"]
                    ):
                        rows_list = df.values.tolist()
                        header_row_idx = None
                        for idx2, row in enumerate(rows_list):
                            row_strs = [str(c).strip() for c in row]
                            if any(h in row_strs for h in ["Name", "DIN/PAN", "DIN"]):
                                header_row_idx = idx2
                                break
                        if header_row_idx is not None:
                            headers = [
                                str(h).strip() for h in rows_list[header_row_idx]
                            ]
                            for row in rows_list[header_row_idx + 1 :]:
                                row_dict = {
                                    headers[i2]: str(row[i2]).strip()
                                    if i2 < len(row)
                                    else ""
                                    for i2 in range(len(headers))
                                }
                                name = row_dict.get("Name", "").strip()
                                if name and name != "nan":
                                    din = row_dict.get("DIN/PAN", "") or row_dict.get(
                                        "DIN", ""
                                    )
                                    directors.append(
                                        {
                                            "name": name,
                                            "designation": row_dict.get(
                                                "Designation", "Director"
                                            )
                                            or "Director",
                                            "email": None,
                                            "phone": None,
                                            "birthday": None,
                                            "din": din
                                            if din not in ("nan", "-", "")
                                            else None,
                                        }
                                    )

                raw_addr = (
                    company_info.get("Registered Address")
                    or company_info.get("Registered Office Address")
                    or company_info.get("Address")
                    or ""
                ).strip()
                if raw_addr in ("-", "nan"):
                    raw_addr = ""

                mca_city = mca_state = ""
                if raw_addr:
                    addr_parts = [p.strip() for p in raw_addr.split(",") if p.strip()]
                    if len(addr_parts) >= 3:
                        mca_state = addr_parts[-3]
                        mca_city = addr_parts[-4] if len(addr_parts) >= 4 else ""

                raw_doi = (
                    company_info.get("Date of Incorporation")
                    or company_info.get("Incorporation Date")
                    or ""
                )
                mca_doi = ""
                if raw_doi:
                    try:
                        from dateutil import parser as date_parser

                        mca_doi = date_parser.parse(str(raw_doi)).strftime("%Y-%m-%d")
                    except Exception:
                        mca_doi = ""

                mca_company_name = (
                    company_info.get("Company Name")
                    or company_info.get("LLP Name")
                    or ""
                ).strip()

                mca_category = (
                    company_info.get("Company Category")
                    or company_info.get("Class of Company")
                    or company_info.get("Company SubCategory")
                    or company_info.get("Type of Company")
                    or ""
                ).strip()
                mca_client_type = _map_mca_constitution(mca_category)
                if mca_client_type == "other":
                    mca_client_type = _map_mca_constitution(
                        mca_category + " " + mca_company_name
                    )
                if mca_client_type == "other" and (
                    company_info.get("LLPIN") or ""
                ).strip() not in ("", "-", "nan"):
                    mca_client_type = "llp"
                if mca_client_type == "other":
                    mca_client_type = (
                        _detect_entity_type_from_name(mca_company_name) or "other"
                    )

                mca_email = _clean_obfuscated_email(
                    company_info.get("Email Id") or company_info.get("Email") or ""
                )

                mca_data = {
                    "company_name": mca_company_name,
                    "client_type": mca_client_type,
                    "company_category": mca_category,
                    "company_subcategory": company_info.get("Subcategory of the Company") or company_info.get("Company Subcategory") or "",
                    "email": mca_email,
                    "phone": company_info.get("Phone") or company_info.get("Mobile") or "",
                    "date_of_incorporation": mca_doi,
                    "address": raw_addr,
                    "city": mca_city,
                    "state": mca_state,
                    "pin": re.search(r"\b(\d{6})\b", raw_addr).group(1) if re.search(r"\b(\d{6})\b", raw_addr) else "",
                    "pan": company_info.get("PAN") or "",
                    "cin": company_info.get("CIN") or company_info.get("LLPIN") or "",
                    "roc": company_info.get("ROC Name") or company_info.get("ROC (name and office)") or "",
                    "registration_number": company_info.get("Registration Number") or "",
                    "rd_name": company_info.get("RD (name and Region)") or "",
                    "active_compliance": company_info.get("ACTIVE compliance") or "",
                    "listed": str(company_info.get("Listed in Stock Exchange(s) (Y/N)") or "").strip().lower() in ("yes", "y", "true", "1"),
                    "authorized_capital": company_info.get("Authorised Capital (Rs)") or company_info.get("Authorized Capital (Rs)") or "",
                    "paid_up_capital": company_info.get("Paid up Capital (Rs)") or "",
                    "last_agm_date": company_info.get("Date of last AGM") or "",
                    "balance_sheet_date": company_info.get("Date of Balance Sheet") or "",
                    "books_address": company_info.get("Address at which the books of account are to be maintained") or "",
                    "charges": [],
                    "directors": directors,
                    "raw": company_info,
                }
                doc_types_found.append("MCA Master Data (Excel)")
            except Exception as e:
                logger.warning(f"MCA Excel parse failed: {e}")

    if not doc_types_found:
        raise HTTPException(
            status_code=422,
            detail=(
                "No recognizable documents found. Upload a GST Registration Certificate (PDF), "
                "Udyam/MSME Certificate (PDF), or MCA Company Master Data (PDF or Excel .xlsx/.xls)."
            ),
        )

    def _first(*vals):
        return next(
            (v for v in vals if v and str(v).strip() not in ("", "nan", "-")), ""
        )

    # ── Merge: GST > Udyam > MCA ──────────────────────────────────────────────
    merged_name = _first(
        gst_data.get("legal_name"),
        gst_data.get("trade_name"),
        udyam_data.get("enterprise_name"),
        mca_data.get("company_name"),
    )
    merged_name = re.sub(r"(?i)^M[/\.]?S[/\.]?\s+", "", merged_name).strip()

    constitution = gst_data.get("constitution") or ""
    const_raw = gst_data.get("constitution_raw") or ""
    gstin = gst_data.get("gstin") or ""
    udyam_number = udyam_data.get("udyam_number") or ""
    msme_type = udyam_data.get("msme_type") or ""
    pan = _first(mca_data.get("pan"), udyam_data.get("pan"))
    cin = _first(
        mca_data.get("cin"),
        mca_data.get("cin_number"),
        mca_data.get("corporate_identity_number"),
    )

    address = _first(
        gst_data.get("address"), udyam_data.get("address"), mca_data.get("address")
    )
    city = _first(gst_data.get("city"), udyam_data.get("city"), mca_data.get("city"))
    state = _first(
        gst_data.get("state"), udyam_data.get("state"), mca_data.get("state")
    )
    # Primary PIN must also fall back to MCA master data.  When the user
    # uploads only an MCA Company Master Data document, GST/Udyam are empty and
    # the previous merge therefore returned a blank PIN even though the MCA
    # document contained a valid six-digit registered-address PIN.
    pin = _first(
        gst_data.get("pin"),
        udyam_data.get("pin"),
        mca_data.get("pin"),
        mca_data.get("pincode"),
        mca_data.get("postal_code"),
    )
    gst_full_address = gst_data.get("full_address") or ""

    mca_directors = mca_data.get("directors", [])
    gst_partners = [
        {
            "name": p["name"],
            "designation": p.get("designation", "Director"),
            "email": "",
            "phone": "",
            "birthday": "",
            "din": "",
        }
        for p in gst_data.get("partners", [])
    ]
    all_contacts = list(mca_directors)
    existing_names = {c["name"].lower().strip() for c in all_contacts}
    for c in gst_partners:
        if c["name"].lower().strip() not in existing_names:
            all_contacts.append(c)
            existing_names.add(c["name"].lower().strip())
    if not all_contacts:
        all_contacts = [
            {
                "name": "",
                "designation": "",
                "email": "",
                "phone": "",
                "birthday": "",
                "din": "",
            }
        ]

    email = _clean_obfuscated_email(
        _first(udyam_data.get("email"), mca_data.get("email"))
    )
    phone_raw = _first(udyam_data.get("mobile"), mca_data.get("phone"))
    phone_digits = re.sub(r"\D", "", phone_raw or "")
    if len(phone_digits) == 12 and phone_digits.startswith("91"):
        phone_digits = phone_digits[2:]
    phone = phone_digits[:10] if len(phone_digits) >= 10 else phone_digits

    date_of_incorporation = _first(
        udyam_data.get("date_of_incorporation"),
        mca_data.get("date_of_incorporation"),
    )

    # ── client_type: GST constitution > MCA category (Pvt/LLP/Public/etc) > name ──
    mca_client_type = mca_data.get("client_type") or ""
    if constitution and constitution != "other":
        client_type = constitution
    elif mca_client_type and mca_client_type != "other":
        client_type = mca_client_type
    else:
        client_type = _detect_entity_type_from_name(merged_name) or "other"
    company_category = mca_data.get("company_category") or ""

    notes_parts = []
    if cin:
        notes_parts.append(f"CIN/LLPIN: {cin}")
    if udyam_number:
        notes_parts.append(f"Udyam: {udyam_number}")
    if msme_type:
        notes_parts.append(f"MSME Type: {msme_type}")
    notes = "\n".join(notes_parts)

    return {
        "status": "ok",
        "doc_types_found": doc_types_found,
        "company_name": merged_name,
        "constitution": constitution,
        "constitution_raw": const_raw,
        "client_type": client_type,
        "company_category": company_category,
        "company_subcategory": mca_data.get("company_subcategory") or "",
        "registration_number": mca_data.get("registration_number") or "",
        "roc": mca_data.get("roc") or "",
        "rd_name": mca_data.get("rd_name") or "",
        "active_compliance": mca_data.get("active_compliance") or "",
        "listed": mca_data.get("listed"),
        "authorized_capital": mca_data.get("authorized_capital") or "",
        "paid_up_capital": mca_data.get("paid_up_capital") or "",
        "last_agm_date": mca_data.get("last_agm_date") or "",
        "balance_sheet_date": mca_data.get("balance_sheet_date") or "",
        "books_address": mca_data.get("books_address") or "",
        "charges": mca_data.get("charges") or [],
        "gstin": gstin,
        "pan": pan,
        "cin": cin,
        "udyam_number": udyam_number,
        "msme_type": msme_type,
        "address": address,
        "city": city,
        "state": state,
        "pin": pin,
        "gst_address": gst_full_address,
        "email": email,
        "phone": phone,
        "date_of_incorporation": date_of_incorporation,
        "contact_persons": all_contacts,
        "notes": notes,
        "gst_data": gst_data,
        "udyam_data": udyam_data,
    }


# ==============================================================
# MDS (MCA) EXCEL SMART PARSER
# ==============================================================
@api_router.post("/clients/parse-mds-excel")
async def parse_mds_excel_for_client_form(
    file: UploadFile = File(...), current_user: User = Depends(get_current_user)
):
    filename = file.filename.lower()
    if not filename.endswith((".xlsx", ".xls")):
        raise HTTPException(
            status_code=400, detail="Only Excel files (.xlsx / .xls) are supported."
        )
    try:
        content = await file.read()
        excel = pd.ExcelFile(BytesIO(content))
    except Exception as e:
        raise HTTPException(
            status_code=400, detail=f"Could not open Excel file: {str(e)}"
        )

    def clean_email(raw: str) -> str:
        if not raw:
            return ""
        cleaned = raw.replace("[at]", "@").replace("[dot]", ".").strip()
        return cleaned if "@" in cleaned else ""

    def clean_phone(raw: str) -> str:
        digits = re.sub(r"\D", "", str(raw or ""))
        if len(digits) == 12 and digits.startswith("91"):
            digits = digits[2:]
        return digits[:10] if len(digits) >= 10 else digits

    def detect_type(name: str) -> str:
        n = name.lower()
        if any(
            x in n for x in ["private limited", "pvt ltd", "pvt. ltd", "pvt limited"]
        ):
            return "pvt_ltd"
        if any(x in n for x in ["limited liability partnership", "llp"]):
            return "llp"
        if any(x in n for x in [" ltd", " limited"]):
            return "pvt_ltd"
        if "partnership" in n:
            return "partnership"
        if "huf" in n:
            return "huf"
        if "trust" in n:
            return "trust"
        return "proprietor"

    def parse_date(raw: str) -> str:
        if not raw or str(raw).strip() in ("", "-", "N/A"):
            return ""
        try:
            return parser.parse(str(raw).strip()).strftime("%Y-%m-%d")
        except Exception:
            return ""

    company_info: dict = {}
    directors: list = []
    extra_notes_parts: list = []

    for sheet_name in excel.sheet_names:
        df = pd.read_excel(excel, sheet_name=sheet_name, header=None).fillna("")
        sheet_lower = sheet_name.lower().strip()
        if (
            "master" in sheet_lower
            or "company" in sheet_lower
            or sheet_lower == "masterdata"
        ):
            for _, row in df.iterrows():
                key = str(row.iloc[0]).strip()
                value = str(row.iloc[1]).strip() if len(row) > 1 else ""
                if key and key not in ("", "nan") and value not in ("", "nan"):
                    if any(
                        phrase in key
                        for phrase in [
                            "Accounts and Solvency",
                            "Annual Returns",
                            "Filing Information",
                            "Interim Resolution",
                            "Sr. No",
                            "Date of filing",
                        ]
                    ):
                        continue
                    company_info[key] = value
        elif (
            "director" in sheet_lower
            or "signatory" in sheet_lower
            or "partner" in sheet_lower
        ):
            rows_list = df.values.tolist()
            header_row_idx = None
            for idx, row in enumerate(rows_list):
                row_strs = [str(c).strip() for c in row]
                if any(h in row_strs for h in ["Name", "DIN/PAN", "DIN"]):
                    header_row_idx = idx
                    break
            if header_row_idx is None:
                continue
            headers = [str(h).strip() for h in rows_list[header_row_idx]]
            for row in rows_list[header_row_idx + 1 :]:
                row_dict = {
                    headers[i]: str(row[i]).strip() if i < len(row) else ""
                    for i in range(len(headers))
                }
                name = row_dict.get("Name", "").strip()
                if not name or name in ("nan", ""):
                    continue
                din = row_dict.get("DIN/PAN", "") or row_dict.get("DIN", "")
                designation = row_dict.get("Designation", "")
                directors.append(
                    {
                        "name": name,
                        "designation": designation or "Director",
                        "email": None,
                        "phone": None,
                        "birthday": None,
                        "din": din if din not in ("nan", "-", "") else None,
                    }
                )
        else:
            rows_list = df.values.tolist()
            if len(rows_list) >= 2:
                cols = [str(c).strip() for c in rows_list[0]]
                data_rows = []
                for row in rows_list[1:]:
                    vals = [str(v).strip() for v in row]
                    if any(v not in ("", "nan", "-") for v in vals):
                        data_rows.append(dict(zip(cols, vals)))
                if data_rows:
                    extra_notes_parts.append(f"[{sheet_name}]")
                    for r in data_rows[:10]:
                        extra_notes_parts.append(
                            " | ".join(
                                f"{k}: {v}"
                                for k, v in r.items()
                                if v not in ("", "nan", "-")
                            )
                        )

    # Support both Pvt Ltd (MCA) and LLP field naming conventions
    company_name = (
        company_info.get("Company Name")
        or company_info.get("LLP Name")
        or company_info.get("company_name")
        or ""
    ).strip()

    raw_email = (
        company_info.get("Email Id")
        or company_info.get("Email")
        or company_info.get("email")
        or ""
    )
    email = clean_email(raw_email)

    raw_phone = (
        company_info.get("Phone")
        or company_info.get("Mobile")
        or company_info.get("Contact")
        or ""
    )
    phone = clean_phone(raw_phone)

    raw_doi = (
        company_info.get("Date of Incorporation")
        or company_info.get("Incorporation Date")
        or ""
    )
    birthday = parse_date(raw_doi)
    # Use Company Class/Category from master data first; fall back to name-based detection
    raw_mca_class = (
        company_info.get("Company Class")
        or company_info.get("Company Category")
        or company_info.get("Company SubCategory")
        or company_info.get("Class of Company")
        or company_info.get("Type of Company")
        or ""
    ).strip()
    if raw_mca_class and raw_mca_class not in ("-", "nan", ""):
        client_type = _map_mca_constitution(raw_mca_class)
        # If class alone maps to "other", also try combining with company name
        if client_type == "other":
            client_type = _map_mca_constitution(raw_mca_class + " " + company_name)
    else:
        client_type = detect_type(company_name)

    address = (
        company_info.get("Registered Address")
        or company_info.get("Registered Office Address")
        or company_info.get("Address")
        or ""
    ).strip()
    if address in ("-", "nan"):
        address = ""

    city = ""
    state = ""
    if address:
        address_parts = [p.strip() for p in address.split(",") if p.strip()]
        if len(address_parts) >= 3:
            state = address_parts[-3]
            city = address_parts[-4] if len(address_parts) >= 4 else ""
        elif len(address_parts) == 2:
            state = address_parts[-1]
            city = address_parts[-2]

    notes_lines = []

    cin = company_info.get("CIN", "") or company_info.get("LLPIN", "")
    if cin and cin not in ("-", "nan"):
        notes_lines.append(f"CIN/LLPIN: {cin}")

    roc = company_info.get("ROC Name", "") or company_info.get(
        "ROC (name and office)", ""
    )
    if roc and roc not in ("-", "nan"):
        notes_lines.append(f"ROC: {roc}")

    reg_no = company_info.get("Registration Number", "")
    if reg_no and reg_no not in ("-", "nan"):
        notes_lines.append(f"Reg No: {reg_no}")

    auth_cap = company_info.get("Authorised Capital (Rs)", "") or company_info.get(
        "Total Obligation of Contribution", ""
    )
    if auth_cap and auth_cap not in ("-", "nan"):
        notes_lines.append(f"Capital/Contribution: Rs{auth_cap}")

    paid_cap = company_info.get("Paid up Capital (Rs)", "")
    if paid_cap and paid_cap not in ("-", "nan"):
        notes_lines.append(f"Paid-up Capital: Rs{paid_cap}")

    if extra_notes_parts:
        notes_lines.append("\n".join(extra_notes_parts))

    notes = "\n".join(notes_lines)

    status_raw = (
        company_info.get("Company Status", "")
        or company_info.get("LLP Status", "Active")
    ).lower()
    status = "active" if "active" in status_raw else "inactive"
    return {
        "status": "ok",
        "company_name": company_name,
        "client_type": client_type,
        "email": email,
        "phone": phone,
        "birthday": birthday,
        "address": address,
        "city": city,
        "state": state,
        "services": [],
        "notes": notes,
        "status_value": status,
        "contact_persons": directors,
        "dsc_details": [],
        "assigned_to": "unassigned",
        "raw_company_info": company_info,
        "sheets_parsed": excel.sheet_names,
    }


# ==============================================================
# GENERAL CLIENT PDF PARSER  (used by Add-New-Client panel)
# ==============================================================
@api_router.post("/clients/parse-pdf")
async def parse_client_pdf(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """
    Generic client-info extractor from any PDF document.
    Tries GST cert first, then Udyam cert, then falls back to
    heuristic regex across all text.  Returns whichever fields it
    can find (company_name, email, phone, pan, gstin, cin, llpin,
    client_type, address, city, state).
    """
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    content = await file.read()
    if len(content) > 15 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="PDF too large — max 15 MB.")

    result: dict = {}

    try:
        import pdfplumber, re as _re

        with pdfplumber.open(BytesIO(content)) as pdf:
            full_text = "\n".join((page.extract_text() or "") for page in pdf.pages)

        text = full_text

        # ── Helper regexes ──────────────────────────────────────
        def first(pattern, flags=0):
            m = _re.search(pattern, text, flags | _re.IGNORECASE)
            return m.group(1).strip() if m else ""

        # GSTIN  (15-char alphanum starting with 2 digits)
        gstin = first(r"\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b")
        if gstin:
            result["gstin"] = gstin
            # State code → state name
            STATE_CODE_MAP = {
                "01": "Jammu and Kashmir",
                "02": "Himachal Pradesh",
                "03": "Punjab",
                "04": "Chandigarh",
                "05": "Uttarakhand",
                "06": "Haryana",
                "07": "Delhi",
                "08": "Rajasthan",
                "09": "Uttar Pradesh",
                "10": "Bihar",
                "11": "Sikkim",
                "12": "Arunachal Pradesh",
                "13": "Nagaland",
                "14": "Manipur",
                "15": "Mizoram",
                "16": "Tripura",
                "17": "Meghalaya",
                "18": "Assam",
                "19": "West Bengal",
                "20": "Jharkhand",
                "21": "Odisha",
                "22": "Chhattisgarh",
                "23": "Madhya Pradesh",
                "24": "Gujarat",
                "25": "Dadra and Nagar Haveli and Daman and Diu",
                "26": "Dadra and Nagar Haveli and Daman and Diu",
                "27": "Maharashtra",
                "28": "Andhra Pradesh",
                "29": "Karnataka",
                "30": "Goa",
                "31": "Lakshadweep",
                "32": "Kerala",
                "33": "Tamil Nadu",
                "34": "Puducherry",
                "35": "Andaman and Nicobar Islands",
                "36": "Telangana",
                "37": "Andhra Pradesh",
            }
            state_code = gstin[:2]
            if state_code in STATE_CODE_MAP and not result.get("state"):
                result["state"] = STATE_CODE_MAP[state_code]

        # PAN  (10-char: AAAAA0000A)
        pan = first(r"\b([A-Z]{5}[0-9]{4}[A-Z])\b")
        if pan:
            result["pan"] = pan

        # CIN  (21-char company registration)
        cin = first(
            r"\b([UL][0-9]{5}[A-Z]{2}[0-9]{4}(?:PTC|PLC|OPC|FLC|GAP|AAP|MTC|NPL|NPC|GAT|FTC)[0-9]{6})\b"
        )
        if cin:
            result["cin"] = cin

        # LLPIN  (AAA-0000 style)
        llpin = first(r"\b([A-Z]{3}-[0-9]{4,6})\b")
        if llpin:
            result["llpin"] = llpin

        # Email
        email = first(r"\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b")
        if email:
            result["email"] = email.lower()

        # Phone (Indian mobile / landline)
        phone_m = _re.search(r"\b((?:\+91[\s\-]?)?[6-9][0-9]{9})\b", text)
        if phone_m:
            result["phone"] = _re.sub(r"\D", "", phone_m.group(1))[-10:]

        # Company name heuristics
        for pattern in [
            r"(?:Legal Name|Trade Name|Business Name|Name of Business|Company Name)[:\s]+([A-Z][A-Z0-9\s&.,'\-]{3,80})",
            r"(?:M/s\.?|To,\s*)([A-Z][A-Z0-9\s&.,'\-]{3,60}(?:PVT\.?\s*LTD\.?|LLP|LIMITED|PROPRIETOR|PARTNERSHIP|HUF|TRUST))",
        ]:
            name = first(pattern)
            if name:
                result["company_name"] = name.strip().rstrip(".,")
                break

        # Auto-detect entity type from name
        if result.get("company_name") and not result.get("client_type"):
            n = result["company_name"].lower()
            if any(x in n for x in ["private limited", "pvt ltd", "pvt. ltd"]):
                result["client_type"] = "pvt_ltd"
            elif "llp" in n or "limited liability" in n:
                result["client_type"] = "llp"
            elif any(x in n for x in [" limited", " ltd"]):
                result["client_type"] = "public_ltd"
            elif "partnership" in n:
                result["client_type"] = "partnership"
            elif "huf" in n:
                result["client_type"] = "huf"
            elif "trust" in n:
                result["client_type"] = "trust"

        # Address block (rough)
        addr_m = _re.search(
            r"(?:Address|Principal Place of Business|Registered Office)[:\s]+([^\n]{10,120})",
            text,
            _re.IGNORECASE,
        )
        if addr_m:
            result["address"] = addr_m.group(1).strip()

        # City / State from text
        if not result.get("city"):
            city_m = _re.search(
                r"\b(Mumbai|Delhi|Surat|Ahmedabad|Bangalore|Bengaluru|Chennai|Hyderabad|Kolkata|Pune|Jaipur|Lucknow|Indore|Bhopal|Nagpur|Vadodara|Rajkot|Coimbatore|Visakhapatnam|Patna|Chandigarh)\b",
                text,
                _re.IGNORECASE,
            )
            if city_m:
                result["city"] = city_m.group(1).title()

    except Exception as e:
        logger.error(f"parse_client_pdf error: {e}", exc_info=True)
        raise HTTPException(
            status_code=422,
            detail="Could not parse PDF. Please fill in the details manually.",
        )

    if not result:
        raise HTTPException(
            status_code=422, detail="No recognizable client data found in this PDF."
        )

    return result


# ==============================================================
# GENERAL CLIENT EXCEL ROW PARSER  (used by Add-New-Client panel)
# ==============================================================
@api_router.post("/clients/parse-excel-row")
async def parse_client_excel_row(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """
    Smart client-data extractor from Excel / CSV files.
    Handles two layouts automatically:

    1. COLUMN-HEADER format  — first row = headers, second row = data
       (e.g. your own bulk-import template)

    2. VERTICAL KEY-VALUE format — col A = field name, col B = value
       (e.g. MCA MDS export: 'LLP Name' | 'AARIYA SPECTRUM LLP')
       Reads ALL sheets named MasterData / master / company etc.

    Accepts .xlsx, .xls, .csv.
    Returns a dict with whatever it can extract:
      company_name, client_type, email, phone, pan, gstin,
      cin, llpin, address, city, state.
    """
    fname = file.filename.lower()
    if not any(fname.endswith(ext) for ext in (".xlsx", ".xls", ".csv")):
        raise HTTPException(
            status_code=400, detail="Only .xlsx, .xls, or .csv files are supported."
        )

    content = await file.read()

    import re as _re

    # ── Helpers ────────────────────────────────────────────────────────────
    def detect_entity_type(name: str) -> str:
        n = (name or "").lower()
        if any(x in n for x in ["private limited", "pvt ltd", "pvt. ltd", "pvt.ltd"]):
            return "pvt_ltd"
        if "llp" in n or "limited liability" in n:
            return "llp"
        if any(x in n for x in [" limited", " ltd"]):
            return "public_ltd"
        if "partnership" in n:
            return "partnership"
        if "huf" in n:
            return "huf"
        if "trust" in n:
            return "trust"
        return "proprietor"

    def clean_email(raw: str) -> str:
        """Handles obfuscated emails like user[at]gmail[dot]com"""
        v = (raw or "").strip()
        v = (
            v.replace("[at]", "@")
            .replace("[dot]", ".")
            .replace(" at ", "@")
            .replace(" dot ", ".")
        )
        return v.lower() if "@" in v else ""

    def clean_phone(raw: str) -> str:
        digits = _re.sub(r"\D", "", str(raw or ""))
        if len(digits) == 12 and digits.startswith("91"):
            digits = digits[2:]
        return digits[-10:] if len(digits) >= 10 else digits

    def parse_address(raw: str):
        """
        Split a full address string like:
        'Shop 8, XYZ Complex, Varachha Road, Surat, Surat City, Gujarat, India, 395006'
        into address / city / state.
        """
        INDIAN_STATES_SET = {
            "andhra pradesh",
            "arunachal pradesh",
            "assam",
            "bihar",
            "chhattisgarh",
            "goa",
            "gujarat",
            "haryana",
            "himachal pradesh",
            "jharkhand",
            "karnataka",
            "kerala",
            "madhya pradesh",
            "maharashtra",
            "manipur",
            "meghalaya",
            "mizoram",
            "nagaland",
            "odisha",
            "punjab",
            "rajasthan",
            "sikkim",
            "tamil nadu",
            "telangana",
            "tripura",
            "uttar pradesh",
            "uttarakhand",
            "west bengal",
            "andaman and nicobar islands",
            "chandigarh",
            "dadra and nagar haveli",
            "daman and diu",
            "delhi",
            "jammu and kashmir",
            "ladakh",
            "lakshadweep",
            "puducherry",
        }
        # Common Indian cities for positive identification
        KNOWN_CITIES = {
            "mumbai",
            "delhi",
            "surat",
            "ahmedabad",
            "bangalore",
            "bengaluru",
            "chennai",
            "hyderabad",
            "kolkata",
            "pune",
            "jaipur",
            "lucknow",
            "indore",
            "bhopal",
            "nagpur",
            "vadodara",
            "rajkot",
            "coimbatore",
            "visakhapatnam",
            "patna",
            "chandigarh",
            "thane",
            "pimpri",
            "nashik",
            "faridabad",
            "meerut",
            "agra",
            "varanasi",
            "srinagar",
            "ludhiana",
            "amritsar",
            "allahabad",
            "prayagraj",
            "vijayawada",
            "madurai",
            "raipur",
            "kota",
            "aurangabad",
            "dhanbad",
            "jodhpur",
            "guwahati",
            "ranchi",
            "gwalior",
            "jabalpur",
            "tiruchirappalli",
            "tirupur",
            "hubli",
            "mysore",
            "mysuru",
            "bareilly",
            "aligarh",
            "moradabad",
            "noida",
            "gurugram",
            "gurgaon",
            "navi mumbai",
            "kalyan",
            "solapur",
            "jalandhar",
            "bhubaneswar",
            "cuttack",
            "thiruvananthapuram",
            "kozhikode",
            "kochi",
            "ernakulam",
            "mangaluru",
            "belagavi",
            "davangere",
            "bellary",
            "hospet",
            "shimla",
            "dehradun",
            "haridwar",
            "rishikesh",
            "udaipur",
            "ajmer",
            "bikaner",
            "alwar",
            "bhilwara",
            "sikar",
        }
        parts = [
            p.strip()
            for p in raw.split(",")
            if p.strip() and p.strip().lower() not in ("india", "nan", "")
        ]
        # Remove PIN code part
        parts = [p for p in parts if not _re.match(r"^\d{6}$", p)]
        # Remove "X City" duplicates (e.g. "Surat City" when "Surat" already present)
        deduped = []
        seen_lower = set()
        for p in parts:
            pl = p.lower()
            # Remove " city" / " district" suffix for dedup check
            base = _re.sub(r"\s+(city|district|taluka|tehsil)$", "", pl).strip()
            if base not in seen_lower:
                seen_lower.add(base)
                deduped.append(p)
        parts = deduped

        city = ""
        state = ""
        addr_parts = []
        for p in parts:
            pl = _re.sub(r"\s+(city|district|taluka|tehsil)$", "", p.lower()).strip()
            if p.lower() in INDIAN_STATES_SET:
                state = p.title()
            elif pl in KNOWN_CITIES and not city:
                city = pl.title()
            else:
                addr_parts.append(p)
        # Fallback: if no known city found, take second-to-last non-state part
        if not city and len(addr_parts) > 1:
            city = addr_parts.pop()
        address = ", ".join(addr_parts)
        return address, city, state

    def norm_key(k: str) -> str:
        return str(k or "").strip().lower()

    # ── Load workbook (all sheets) ─────────────────────────────────────────
    try:
        if fname.endswith(".csv"):
            sheets = {
                "Sheet1": pd.read_csv(BytesIO(content), dtype=str, header=None).fillna(
                    ""
                )
            }
        elif fname.endswith(".xls"):
            xl = pd.ExcelFile(BytesIO(content), engine="xlrd")
            sheets = {
                s: pd.read_excel(xl, sheet_name=s, dtype=str, header=None).fillna("")
                for s in xl.sheet_names
            }
        else:
            xl = pd.ExcelFile(BytesIO(content), engine="openpyxl")
            sheets = {
                s: pd.read_excel(xl, sheet_name=s, dtype=str, header=None).fillna("")
                for s in xl.sheet_names
            }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read file: {str(e)}")

    if not sheets:
        raise HTTPException(status_code=422, detail="File appears to be empty.")

    # ── Detect layout: vertical KV vs horizontal header ───────────────────
    # Heuristic: if col-0 of row-0 looks like a section header and col-1
    # of row-1 looks like a value (not a typical column name), it's KV.
    def is_kv_sheet(df: pd.DataFrame) -> bool:
        if df.shape[1] < 2 or df.shape[0] < 3:
            return False
        col0_vals = [
            str(v).strip()
            for v in df.iloc[:8, 0]
            if str(v).strip() and str(v).strip().lower() != "nan"
        ]
        # KV sheets have field-name-like strings in col 0 (mixed case, spaces)
        kv_like = sum(1 for v in col0_vals if " " in v or len(v) > 12)
        return kv_like >= 2

    # ── Strategy 1: Vertical KV (MCA MDS, Tally exports, etc.) ───────────
    def extract_from_kv_sheets(sheets: dict) -> dict:
        kv: dict = {}
        # Prefer MasterData sheet; fall back to all sheets
        priority = [
            s
            for s in sheets
            if "master" in s.lower() or "company" in s.lower() or "llp" in s.lower()
        ]
        ordered = priority + [s for s in sheets if s not in priority]
        for sname in ordered:
            df = sheets[sname]
            if not is_kv_sheet(df):
                continue
            for _, row in df.iterrows():
                k = norm_key(row.iloc[0])
                v = str(row.iloc[1]).strip() if df.shape[1] > 1 else ""
                if not k or k == "nan" or not v or v == "nan":
                    continue
                kv[k] = v
        return kv

    kv_data = extract_from_kv_sheets(sheets)

    result: dict = {}

    if kv_data:
        # Map KV keys → client fields
        KV_NAME_KEYS = [
            "llp name",
            "company name",
            "name of company",
            "name of llp",
            "business name",
            "trade name",
            "legal name",
            "firm name",
            "entity name",
        ]
        KV_EMAIL_KEYS = ["email id", "email", "email address", "e-mail", "e mail"]
        KV_PHONE_KEYS = [
            "phone",
            "mobile",
            "contact",
            "phone no",
            "mobile no",
            "telephone",
        ]
        KV_PAN_KEYS = ["pan", "pan no", "pan number", "permanent account number"]
        KV_GSTIN_KEYS = ["gstin", "gst number", "gst no", "gstin no"]
        KV_CIN_KEYS = ["cin", "cin no", "company identification number"]
        KV_LLPIN_KEYS = ["llpin", "llp identification number", "llp in"]
        KV_ADDR_KEYS = [
            "registered address",
            "principal place of business",
            "office address",
            "address",
        ]
        KV_CITY_KEYS = ["city", "town"]
        KV_STATE_KEYS = ["state", "state name"]

        def kv_get(keys: list[str]) -> str:
            for k in keys:
                if k in kv_data:
                    return kv_data[k]
            # partial match
            for search_k in keys:
                for actual_k, v in kv_data.items():
                    if search_k in actual_k:
                        return v
            return ""

        company_name = kv_get(KV_NAME_KEYS)
        email_raw = kv_get(KV_EMAIL_KEYS)
        phone_raw = kv_get(KV_PHONE_KEYS)
        pan = kv_get(KV_PAN_KEYS).upper()
        gstin = kv_get(KV_GSTIN_KEYS).upper()
        cin = kv_get(KV_CIN_KEYS).upper()
        llpin = kv_get(KV_LLPIN_KEYS).upper()
        addr_raw = kv_get(KV_ADDR_KEYS)
        city = kv_get(KV_CITY_KEYS)
        state = kv_get(KV_STATE_KEYS)

        email = clean_email(email_raw)
        phone = clean_phone(phone_raw)

        # If address is a full string (MCA style), split it
        if addr_raw and "," in addr_raw and not city:
            parsed_addr, parsed_city, parsed_state = parse_address(addr_raw)
            if not city:
                city = parsed_city
            if not state:
                state = parsed_state
            addr_raw = parsed_addr or addr_raw

        client_type = detect_entity_type(company_name)
        # Extra hint: if LLPIN is present, it's definitely an LLP
        if llpin and llpin != "-":
            client_type = "llp"

        if company_name:
            result["company_name"] = company_name.strip()
        if client_type:
            result["client_type"] = client_type
        if email:
            result["email"] = email
        if phone:
            result["phone"] = phone
        if pan and pan != "-":
            result["pan"] = pan
        if gstin and gstin != "-":
            result["gstin"] = gstin
        if cin and cin != "-":
            result["cin"] = cin
        if llpin and llpin != "-":
            result["llpin"] = llpin
        if addr_raw:
            result["address"] = addr_raw.strip()
        if city:
            result["city"] = city.strip()
        if state:
            result["state"] = state.strip()

    # ── Strategy 2: Horizontal header row (fallback) ───────────────────────
    if not result:
        # Try each sheet; pick first that looks like column-header format
        for sname, df_raw in sheets.items():
            if df_raw.shape[0] < 2:
                continue
            # Try using first row as header
            df = df_raw.copy()
            df.columns = [str(c).strip() for c in df.iloc[0]]
            df = df.iloc[1:].reset_index(drop=True).fillna("")
            if df.empty:
                continue

            col_map: dict[str, str] = {}
            for col in df.columns:
                norm = col.strip().lower().replace(" ", "_").replace("/", "_")
                col_map[norm] = col

            def get_col(keys: list[str]) -> str:
                for k in keys:
                    if k in col_map:
                        val = str(df.iloc[0][col_map[k]]).strip()
                        if val and val.lower() not in ("nan", "", "-"):
                            return val
                return ""

            company_name = get_col(
                [
                    "company_name",
                    "name",
                    "client_name",
                    "business_name",
                    "entity_name",
                    "llp_name",
                    "company",
                ]
            )
            if not company_name:
                continue  # not the right sheet

            client_type = get_col(
                ["client_type", "entity_type", "type"]
            ) or detect_entity_type(company_name)
            email = clean_email(
                get_col(["email", "email_id", "email_address", "e-mail"])
            )
            phone = clean_phone(
                get_col(["phone", "mobile", "phone_no", "mobile_no", "contact"])
            )
            pan = get_col(["pan", "pan_no", "pan_number"]).upper()
            gstin = get_col(["gstin", "gst", "gst_number", "gstin_no"]).upper()
            cin = get_col(["cin", "cin_no", "company_identification_number"]).upper()
            llpin = get_col(["llpin", "llp_in", "llp_registration"]).upper()
            addr_raw = get_col(
                ["address", "addr", "registered_address", "office_address"]
            )
            city = get_col(["city", "town"])
            state = get_col(["state", "state_name"])

            if addr_raw and "," in addr_raw and not city:
                addr_raw, city, state = parse_address(addr_raw)

            if llpin:
                client_type = "llp"

            if company_name:
                result["company_name"] = company_name
            if client_type:
                result["client_type"] = client_type
            if email:
                result["email"] = email
            if phone:
                result["phone"] = phone
            if pan:
                result["pan"] = pan
            if gstin:
                result["gstin"] = gstin
            if cin:
                result["cin"] = cin
            if llpin:
                result["llpin"] = llpin
            if addr_raw:
                result["address"] = addr_raw
            if city:
                result["city"] = city
            if state:
                result["state"] = state
            break  # found a usable sheet

    if not result:
        raise HTTPException(
            status_code=422,
            detail=(
                "No recognizable client data found in this file. "
                "Expected either an MCA MDS export (key-value format) or a "
                "spreadsheet with column headers: company_name, email, phone, pan, gstin, etc."
            ),
        )

    return result

