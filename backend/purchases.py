"""
Purchases module — "Accounts › Purchase" page.

Lets a user upload a vendor/purchase invoice (PDF or image). The document is
read by the app (Gemini for structured extraction, with a regex fallback for
GSTIN / invoice number / date / amount), the vendor name is fuzzy-matched
against the existing Clients list, and — once the user confirms — the
invoice record is saved and linked to that company so it shows up wherever
that company's purchase history is displayed (e.g. inside the client's
profile in the Clients page).
"""

import re
import json
import uuid
import base64
from io import BytesIO
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from backend.finix_action_permissions import require_finix_action
from backend.dependencies import db, get_current_user
from backend.models import User

# Reuse the vision helpers already built for the AI Document Reader instead
# of duplicating the Groq integration.
from backend.ai_document_reader import _groq_vision, _groq_vision_multipage

router = APIRouter(tags=["Purchases"])

MAX_FILE_BYTES = 8 * 1024 * 1024  # 8 MB

GSTIN_REGEX = re.compile(r"\b\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}Z[A-Z\d]{1}\b")
INVOICE_NO_REGEX = re.compile(r"invoice\s*(?:no\.?|number|#)\s*[:\-]?\s*([A-Za-z0-9\-\/]{2,30})", re.I)
DATE_REGEX = re.compile(r"(?:invoice\s*date|dated?|date)\s*[:\-]?\s*([0-3]?\d[\/\-.][01]?\d[\/\-.]\d{2,4})", re.I)
AMOUNT_REGEX = re.compile(
    r"(?:grand\s*total|total\s*amount|amount\s*payable|net\s*payable|total\s*due|invoice\s*total)"
    r"\s*[:\-]?\s*(?:rs\.?|inr|₹)?\s*([\d,]+\.?\d*)",
    re.I,
)


# ── Models ────────────────────────────────────────────────────────────────
class PurchaseCreate(BaseModel):
    client_id: Optional[str] = None
    client_name: str = ""
    vendor_name: str = ""
    invoice_no: str = ""
    invoice_date: str = ""
    amount: float = 0.0
    gstin: str = ""
    notes: str = ""


class Purchase(PurchaseCreate):
    id: str
    file_name: Optional[str] = None
    file_mime: Optional[str] = None
    created_by: str
    created_at: str


# ── Helpers ───────────────────────────────────────────────────────────────
def _regex_extract(text: str) -> dict:
    data = {}
    if not text:
        return data
    m = GSTIN_REGEX.search(text)
    if m:
        data["gstin"] = m.group(0)
    m = INVOICE_NO_REGEX.search(text)
    if m:
        data["invoice_no"] = m.group(1).strip()
    m = DATE_REGEX.search(text)
    if m:
        data["invoice_date_raw"] = m.group(1).strip()
    m = AMOUNT_REGEX.search(text)
    if m:
        try:
            data["amount"] = float(m.group(1).replace(",", ""))
        except ValueError:
            pass
    return data


def _normalize_date(raw: str) -> str:
    """Best-effort conversion of a dd/mm/yyyy-ish string to YYYY-MM-DD."""
    if not raw:
        return ""
    raw = raw.strip()
    for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%d/%m/%y", "%d-%m-%y", "%Y-%m-%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return raw


def _norm_company(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"\b(pvt\.?|private|ltd\.?|limited|llp|inc\.?|co\.?|company|the|enterprises|traders|industries)\b", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return s


async def _match_clients(vendor_name: str) -> List[dict]:
    if not vendor_name:
        return []
    clients = await db.clients.find({}, {"_id": 0, "id": 1, "company_name": 1}).to_list(5000)
    target = _norm_company(vendor_name)
    if not target:
        return []
    target_tokens = set(target.split())
    scored = []
    for c in clients:
        cn = _norm_company(c.get("company_name"))
        if not cn:
            continue
        tokens = set(cn.split())
        if not tokens:
            continue
        overlap = len(target_tokens & tokens)
        union = len(target_tokens | tokens) or 1
        score = overlap / union
        if cn == target:
            score = 1.0
        elif target in cn or cn in target:
            score = max(score, 0.85)
        if score >= 0.3:
            scored.append({"client_id": c["id"], "company_name": c.get("company_name", ""), "score": round(score, 2)})
    scored.sort(key=lambda x: -x["score"])
    return scored[:5]


async def _extract_text_from_upload(contents: bytes, filename: str) -> str:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if ext == "pdf":
        text_content = ""
        try:
            import pdfplumber

            pages = []
            with pdfplumber.open(BytesIO(contents)) as pdf:
                for page in pdf.pages[:10]:
                    t = page.extract_text()
                    if t and t.strip():
                        pages.append(t.strip())
            text_content = "\n".join(pages)
        except Exception:
            text_content = ""

        if text_content.strip():
            return text_content

        # Scanned PDF — no text layer → render pages to images → Groq vision
        try:
            import pdfplumber

            page_images = []
            with pdfplumber.open(BytesIO(contents)) as pdf:
                for page in pdf.pages[:3]:
                    pil_img = page.to_image(resolution=150).original
                    if pil_img.mode not in ("RGB", "L"):
                        pil_img = pil_img.convert("RGB")
                    buf = BytesIO()
                    pil_img.save(buf, format="JPEG", quality=85)
                    page_images.append((base64.b64encode(buf.getvalue()).decode(), "image/jpeg"))
            if not page_images:
                return ""
            prompt = (
                "Transcribe all readable text from these invoice pages, verbatim. "
                "Preserve numbers, labels, and totals exactly as printed."
            )
            return await _groq_vision_multipage(page_images, prompt)
        except Exception:
            return ""

    if ext in ("jpg", "jpeg", "png", "webp"):
        try:
            from PIL import Image as PILImage

            img = PILImage.open(BytesIO(contents))
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            buf = BytesIO()
            img.save(buf, format="JPEG", quality=85)
            img_b64 = base64.b64encode(buf.getvalue()).decode()
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Could not open image: {e}")
        prompt = (
            "Transcribe all readable text from this invoice image, verbatim. "
            "Preserve numbers, labels, and totals exactly as printed."
        )
        return await _groq_vision(img_b64, "image/jpeg", prompt)

    raise HTTPException(
        status_code=415,
        detail=f"Unsupported file type '.{ext}'. Upload a PDF or image (JPG/PNG/WEBP) of the invoice.",
    )


async def _ai_extract_fields(text_content: str) -> dict:
    import os as _os

    gemini_key = _os.environ.get("GEMINI_API_KEY", "")
    if not gemini_key:
        return {}
    try:
        import google.generativeai as genai

        genai.configure(api_key=gemini_key)
        model = genai.GenerativeModel("gemini-2.0-flash")
        prompt = (
            "You are reading a purchase/vendor invoice. Extract these fields as STRICT JSON only, "
            "no markdown fences, no explanation:\n"
            '{"vendor_name": "", "invoice_no": "", "invoice_date": "YYYY-MM-DD or empty", '
            '"amount": 0, "gstin": "", "notes": "one short line summarising what was purchased"}\n'
            "vendor_name = the company that ISSUED the invoice (the seller/supplier), never the buyer.\n"
            "amount = the final grand total payable, as a plain number with no currency symbol or commas.\n"
            "If a field is not present, use an empty string (or 0 for amount).\n\n"
            f"Invoice text:\n{text_content[:12000]}"
        )
        resp = await model.generate_content_async(prompt)
        raw = re.sub(r"```[a-zA-Z]*", "", resp.text.strip()).replace("```", "").strip()
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


# ── Routes ────────────────────────────────────────────────────────────────
@router.post("/purchases/parse-invoice")
async def parse_purchase_invoice(
    file: UploadFile = File(...), current_user: User = Depends(get_current_user)
):
    """Read an uploaded vendor invoice and return extracted fields + suggested
    company matches from the Clients list. Does NOT save anything yet."""
    contents = await file.read()
    if len(contents) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="File too large — please upload a file under 8 MB.")
    filename = file.filename or "invoice"

    text_content = await _extract_text_from_upload(contents, filename)
    if not text_content or not text_content.strip():
        raise HTTPException(
            status_code=422,
            detail="Could not extract any text from this invoice. Try a clearer scan or a different file.",
        )

    parsed = await _ai_extract_fields(text_content)
    fallback = _regex_extract(text_content)
    for k, v in fallback.items():
        if k == "invoice_date_raw":
            if not parsed.get("invoice_date"):
                parsed["invoice_date"] = _normalize_date(v)
            continue
        if not parsed.get(k):
            parsed[k] = v
    if parsed.get("invoice_date"):
        parsed["invoice_date"] = _normalize_date(str(parsed["invoice_date"]))

    vendor_name = (parsed.get("vendor_name") or "").strip()
    matches = await _match_clients(vendor_name)

    return {
        "filename": filename,
        "vendor_name": vendor_name,
        "invoice_no": (parsed.get("invoice_no") or "").strip(),
        "invoice_date": (parsed.get("invoice_date") or "").strip(),
        "amount": parsed.get("amount") or 0,
        "gstin": (parsed.get("gstin") or "").strip().upper(),
        "notes": (parsed.get("notes") or "").strip(),
        "suggested_matches": matches,
        "raw_text_preview": text_content[:600],
    }


@router.post("/purchases", response_model=Purchase)
async def create_purchase(
    client_id: str = Form(""),
    client_name: str = Form(""),
    vendor_name: str = Form(""),
    invoice_no: str = Form(""),
    invoice_date: str = Form(""),
    amount: float = Form(0.0),
    gstin: str = Form(""),
    notes: str = Form(""),
    file: Optional[UploadFile] = File(None),
    current_user: User = Depends(get_current_user),
):
    """Save a (reviewed/confirmed) purchase invoice, linked to a company in
    the Clients list when one was matched or picked by the user."""
    if client_id:
        client = await db.clients.find_one({"id": client_id}, {"_id": 0, "company_name": 1})
        if not client:
            raise HTTPException(status_code=404, detail="Selected company not found in Clients.")
        if not client_name:
            client_name = client.get("company_name", "")

    doc = {
        "id": str(uuid.uuid4()),
        "client_id": client_id or None,
        "client_name": client_name.strip(),
        "vendor_name": vendor_name.strip(),
        "invoice_no": invoice_no.strip(),
        "invoice_date": invoice_date.strip(),
        "amount": float(amount or 0),
        "gstin": gstin.strip().upper(),
        "notes": notes.strip(),
        "file_name": None,
        "file_mime": None,
        "file_b64": None,
        "created_by": current_user.id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    if file is not None:
        contents = await file.read()
        if len(contents) > MAX_FILE_BYTES:
            raise HTTPException(status_code=413, detail="File too large — please upload a file under 8 MB.")
        if contents:
            doc["file_name"] = file.filename
            doc["file_mime"] = file.content_type or "application/octet-stream"
            doc["file_b64"] = base64.b64encode(contents).decode()

    await db.purchases.insert_one(doc)
    return doc


@router.get("/purchases")
async def list_purchases(
    client_id: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    q: dict = {}
    if client_id:
        q["client_id"] = client_id
    if search:
        rx = {"$regex": re.escape(search), "$options": "i"}
        q["$or"] = [
            {"vendor_name": rx},
            {"client_name": rx},
            {"invoice_no": rx},
            {"gstin": rx},
        ]
    items = await db.purchases.find(q, {"_id": 0, "file_b64": 0}).sort("created_at", -1).to_list(2000)
    return items


@router.get("/purchases/{purchase_id}")
async def get_purchase(purchase_id: str, current_user: User = Depends(get_current_user)):
    doc = await db.purchases.find_one({"id": purchase_id}, {"_id": 0, "file_b64": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Purchase invoice not found")
    return doc


@router.get("/purchases/{purchase_id}/file")
async def download_purchase_file(purchase_id: str, current_user: User = Depends(get_current_user)):
    doc = await db.purchases.find_one({"id": purchase_id}, {"_id": 0})
    if not doc or not doc.get("file_b64"):
        raise HTTPException(status_code=404, detail="No file attached to this purchase invoice.")
    raw = base64.b64decode(doc["file_b64"])
    return Response(
        content=raw,
        media_type=doc.get("file_mime") or "application/octet-stream",
        headers={"Content-Disposition": f'inline; filename="{doc.get("file_name") or "invoice"}"'},
    )


@router.delete("/purchases/{purchase_id}")
async def delete_purchase(purchase_id: str, current_user: User = Depends(get_current_user)):
    require_finix_action(current_user, "can_view_purchase", "delete")
    result = await db.purchases.delete_one({"id": purchase_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Purchase invoice not found")
    return {"success": True}
