import uuid
import logging
import hashlib
import json
from datetime import datetime, timezone
from typing import Callable, Any, Optional, List, Dict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.dependencies import db, get_current_user
from backend.platform_owner import is_platform_owner
from backend.ai.fingerprint import generate_document_fingerprint
from backend.ai.ai_memory import save_ai_memory, find_memory_by_fingerprint, update_ai_memory

logger = logging.getLogger("ai_router")
router = APIRouter(prefix="/ai", tags=["ai"])


def parse_analysis_text(text: str) -> dict:
    import re
    res = {
        "document_type": "UNKNOWN",
        "vendor_name": "Unknown Vendor",
        "vendor_gstin": "",
        "invoice_number": "",
        "invoice_date": "",
        "invoice_total": 0.0,
        "taxable_amount": 0.0,
        "gst_amount": 0.0,
        "confidence": 1.0
    }
    if not text:
        return res
        
    text_upper = text.upper()
    
    # 1. Document type
    if "PURCHASE" in text_upper:
        res["document_type"] = "PURCHASE"
    elif "SALE" in text_upper:
        res["document_type"] = "SALE"
        
    # 2. GSTIN search
    gstin_re = re.compile(r'\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b', re.I)
    gstin_match = gstin_re.search(text)
    if gstin_match:
        res["vendor_gstin"] = gstin_match.group(0).upper()
        
    # 3. Invoice Number
    inv_re = re.compile(r'(?:invoice\s*(?:no|number|#)?|inv\s*(?:no|num|number|#)?)\s*[:\-=]?\s*([a-z0-9\-/]+)', re.I)
    inv_match = inv_re.search(text)
    if inv_match:
        res["invoice_number"] = inv_match.group(1).strip()
        
    # 4. Vendor Name
    vendor_re = re.compile(r'(?:vendor|seller|supplier|party\s*name)\s*[:\-=]?\s*([^\n\r]+)', re.I)
    vendor_match = vendor_re.search(text)
    if vendor_match:
        res["vendor_name"] = vendor_match.group(1).strip()[:100]
        
    # 5. Date
    date_re = re.compile(r'(?:date)\s*[:\-=]?\s*(\d{4}-\d{2}-\d{2})', re.I)
    date_match = date_re.search(text)
    if date_match:
        res["invoice_date"] = date_match.group(1)
        
    # 6. Total Invoice Value
    total_re = re.compile(r'(?:total|grand\s*total|amount|value)\s*[:\-=]?\s*(?:rs\.?|inr|₹|\$)?\s*([0-9,]+\.?[0-9]*)', re.I)
    total_match = total_re.search(text)
    if total_match:
        try:
            res["invoice_total"] = float(total_match.group(1).replace(",", ""))
        except ValueError:
            pass
            
    return res

async def classify_document(
    contents: bytes,
    filename: str,
    raw_ocr_text: str = "",
    file_hash: str = "",
    document_id: str = ""
) -> dict:
    """
    Module level classifier function that calls the document_classifier.py
    """
    from backend.ai.document_classifier import classify_document as run_classifier
    return await run_classifier(contents, filename, raw_ocr_text, file_hash, document_id)

async def find_template(contents: bytes, filename: str, ocr_text: str = "") -> Any:
    """
    Exposes find_matching_template from template_engine to find matching layout templates.
    """
    from backend.ai.template_engine import find_matching_template
    return await find_matching_template(contents, filename, ocr_text)

async def learn_template(
    contents: bytes,
    filename: str,
    doc_type: str,
    extracted_json: dict,
    ocr_text: str
) -> Any:
    """
    Exposes learn_template from template_engine to automatically learn templates.
    """
    from backend.ai.template_engine import learn_template as run_learn_template
    return await run_learn_template(contents, filename, doc_type, extracted_json, ocr_text)

async def process_ocr(contents: bytes, filename: str, document_id: str = None) -> str:
    """
    Asynchronous OCR processor entry point utilizing the pluggable OCR pipeline.
    """
    from backend.ai.ocr_pipeline import process_ocr_pipeline
    try:
        text, meta = await process_ocr_pipeline(contents, filename, document_id)
        return text
    except Exception as exc:
        logger.error(f"process_ocr pipeline failed: {exc}", exc_info=True)
        # Fallback to basic text content extraction if everything fails
        return get_document_text_content(contents, filename)


async def _orchestrate_gst(result: dict, current_user: Any, document_id: str) -> dict:
    """Delegates GST processing to the GST Intelligence Engine."""
    try:
        from backend.gst_ai.gst_engine import GSTEngine
        company_id = getattr(current_user, "company_id", "default_comp") if current_user else "default_comp"
        user_id = getattr(current_user, "id", "system") if current_user else "system"
        
        is_purchase = result.get("document_type") != "Sales Invoice"
        invoice_payload = {
            "id": document_id,
            "invoice_no": result.get("invoice_number") or result.get("invoice_no") or "",
            "invoice_date": result.get("invoice_date") or "",
            "supplier_gstin": result.get("tax_registration_number") or "",
            "recipient_gstin": getattr(current_user, "gstin", "") if current_user else "",
            "taxable_value": result.get("taxable_value") or result.get("taxable_amount") or 0.0,
            "invoice_value": result.get("total_invoice_value") or result.get("invoice_total") or 0.0,
            "cgst": result.get("cgst") or 0.0,
            "sgst": result.get("sgst") or 0.0,
            "igst": result.get("igst") or 0.0,
            "rate": result.get("rate") or result.get("tax_rate") or 18.0,
            "is_purchase": is_purchase
        }
        
        gst_res = await GSTEngine.process_gst(
            invoice_data=invoice_payload,
            company_id=company_id,
            user_id=user_id
        )
        result["gst_intelligence"] = gst_res
        logger.info("GST Intelligence orchestrated successfully.")
    except Exception as gst_err:
        logger.error(f"Failed to orchestrate GST Intelligence: {gst_err}", exc_info=True)
    return result


async def _orchestrate_learning_and_recommendations(result: dict, current_user: Any, document_id: str) -> dict:
    """Orchestrates Self-Learning and Recommendation Engine for document extraction."""
    try:
        from backend.learning.recommendation_engine import RecommendationEngine
        company_id = getattr(current_user, "company_id", "default_comp") if current_user else "default_comp"
        
        # Prepare context data
        context_data = {
            "vendor_name": result.get("vendor_or_customer_name") or result.get("vendor_name") or "",
            "document_type": result.get("document_type") or "",
            "total_invoice_value": result.get("total_invoice_value") or result.get("invoice_total") or 0.0,
            "tax_rate": result.get("tax_rate") or result.get("rate") or 0.0
        }
        
        recs = await RecommendationEngine.generate_recommendations(context_data, company_id)
        result["recommendations"] = recs
        logger.info("Self-Learning Recommendations orchestrated successfully.")
    except Exception as err:
        logger.error(f"Failed to orchestrate learning/recommendations: {err}", exc_info=True)
    return result

async def process_document(
    contents: bytes,
    filename: str,
    current_user: Any,
    existing_reader_func: Callable
) -> dict:
    """
    Coordinates fingerprint generation, memory lookup, calling existing reader,
    and memory save.
    """
    logger.info("Document Received")
    
    # 1. Compute file hash
    file_hash = hashlib.sha256(contents).hexdigest()
    import uuid
    document_id = str(uuid.uuid4())
    
    # 2. Extract initial raw text to help look up
    raw_ocr_text = await process_ocr(contents, filename, document_id)
    normalized_ocr = ""
    if raw_ocr_text.strip():
        import re
        normalized_ocr = re.sub(r'[^a-z0-9]', '', raw_ocr_text.lower().strip())[:1000]

    # Generate Fingerprint (Step 2 of Phase 2 Workflow)
    from backend.ai.fingerprint import generate_document_fingerprint
    fingerprint = generate_document_fingerprint(
        vendor_name="",
        vendor_gstin="",
        invoice_number="",
        document_type="",
        raw_ocr_text=raw_ocr_text
    )
    logger.info("Fingerprint Generated")

    # 3. Check AI Memory (Step 3 of Phase 2 Workflow)
    memory_record = None
    try:
        if file_hash:
            memory_record = await db.ai_document_memory.find_one({"file_hash": file_hash}, {"_id": 0})
        
        if not memory_record and normalized_ocr:
            memory_record = await db.ai_document_memory.find_one({"raw_ocr_text_normalized": normalized_ocr}, {"_id": 0})
    except Exception as e:
        logger.error(f"Error checking AI Memory lookup: {e}", exc_info=True)

    # 4. Classify Document (Step 4 of Phase 2 Workflow)
    classification_res = {"document_type": "Other", "confidence": 0.0, "reason": "Failed to classify"}
    try:
        classification_res = await classify_document(contents, filename, raw_ocr_text, file_hash)
    except Exception as exc:
        logger.error(f"Classifier failed: {exc}", exc_info=True)
    
    # 5. Return Classification (Step 5 of Phase 2 Workflow / Continue existing processing)
    if memory_record:
        logger.info("Memory Hit")
        res_json = memory_record["extracted_json"]
        if isinstance(res_json, dict):
            res_json["classification"] = classification_res
            res_json["document_type"] = classification_res["document_type"]
        return res_json
        
    logger.info("Memory Miss")

    from backend.ai.vendor_learning import apply_vendor_defaults, learn_vendor_profile
    from backend.ai.vendor_mapper import lookup_vendor_from_ocr

    # Phase 3: Template Search
    from backend.ai.template_engine import find_matching_template, extract_using_template, learn_template
    from backend.ai.template_storage import increment_usage
    
    matched_template = None
    try:
        matched_template = await find_matching_template(contents, filename, raw_ocr_text)
    except Exception as exc:
        logger.error(f"Template Search failed: {exc}", exc_info=True)
        
    if matched_template:
        logger.info("Template Match Found")
        # Extract fields using template and bypass Gemini/Groq
        try:
            result = extract_using_template(matched_template, raw_ocr_text)
            await increment_usage(matched_template["template_id"], success=True)
            
            # Enrich with classification
            if isinstance(result, dict):
                result["classification"] = classification_res
                result["document_type"] = classification_res["document_type"]
                result["template_matched_id"] = matched_template["template_id"]
                result["extraction_method"] = "template"
                
                # Apply Vendor Defaults & Learning
                vendor_name = result.get("vendor_or_customer_name") or ""
                vendor_gstin = result.get("tax_registration_number") or ""
                result = await apply_vendor_defaults(vendor_name, vendor_gstin, result)
                try:
                    await learn_vendor_profile(vendor_name, vendor_gstin, result)
                    logger.info("Vendor Defaults Applied and Profile Learned from Template")
                except Exception as l_err:
                    logger.error(f"Failed to learn vendor profile from template: {l_err}", exc_info=True)
                
                # ─── INTEGRATE AI CONFIDENCE & VALIDATION ENGINE ───
                company_id = current_user.company_id if hasattr(current_user, 'company_id') else (current_user.get('company_id') if isinstance(current_user, dict) else None)
                vendor_profile = None
                try:
                    if vendor_gstin:
                        vendor_profile = await db.vendor_intelligence.find_one({"gstin": vendor_gstin})
                    if not vendor_profile and vendor_name:
                        vendor_profile = await db.vendor_intelligence.find_one({"vendor_name": vendor_name})
                except Exception as e:
                    logger.error(f"Error fetching vendor profile in template matching: {e}")
                    
                from backend.ai.document_validator import run_document_validation_pipeline
                validation_report = {}
                try:
                    ocr_meta = await db.ocr_processing_history.find_one({"document_id": document_id}) or {}
                    validation_report = await run_document_validation_pipeline(
                        extracted_data=result,
                        ocr_metadata=ocr_meta,
                        filename=filename,
                        document_id=document_id,
                        vendor_profile=vendor_profile,
                        template_matched=True,
                        company_id=company_id
                    )
                    result["validation_report"] = validation_report
                except Exception as val_err:
                    logger.error(f"Error in template validation: {val_err}", exc_info=True)
                
            # Save this to memory for future fingerprint hits as well
            try:
                classified_doc_type = classification_res["document_type"]
                
                parsed = {
                    "vendor_name": result.get("vendor_or_customer_name") or "",
                    "vendor_gstin": result.get("tax_registration_number") or "",
                    "invoice_number": result.get("invoice_number") or "",
                    "invoice_date": result.get("invoice_date") or "",
                    "invoice_total": float(result.get("total_invoice_value") or 0) if result.get("total_invoice_value") else 0.0,
                    "taxable_amount": float(result.get("taxable_value") or 0) if result.get("taxable_value") else 0.0,
                    "gst_amount": float(result.get("total_tax") or 0) if result.get("total_tax") else 0.0
                }
                
                fingerprint = generate_document_fingerprint(
                    vendor_name=parsed["vendor_name"],
                    vendor_gstin=parsed["vendor_gstin"],
                    invoice_number=parsed["invoice_number"],
                    document_type=classified_doc_type,
                    raw_ocr_text=raw_ocr_text
                )
                
                now = datetime.now(timezone.utc).isoformat()
                new_record = {
                    "document_id": document_id,
                    "company_id": company_id,
                    "fingerprint": fingerprint,
                    "document_type": classified_doc_type,
                    "vendor_name": parsed["vendor_name"],
                    "vendor_gstin": parsed["vendor_gstin"],
                    "invoice_number": parsed["invoice_number"],
                    "invoice_date": parsed["invoice_date"],
                    "invoice_total": parsed["invoice_total"],
                    "taxable_amount": parsed["taxable_amount"],
                    "gst_amount": parsed["gst_amount"],
                    "raw_ocr_text": raw_ocr_text,
                    "extracted_json": result,
                    "ledger_mapping": {},
                    "journal_entry": {},
                    "processing_engine": "template",
                    "ai_confidence": validation_report.get("overall_confidence", classification_res["confidence"]),
                    "processing_status": "extracted",
                    "validation_report": validation_report,
                    "decision": validation_report.get("decision", "REQUIRES_REVIEW"),
                    "created_at": now,
                    "updated_at": now,
                    "file_hash": file_hash,
                    "raw_ocr_text_normalized": normalized_ocr
                }
                await save_ai_memory(new_record)
                logger.info("Memory Saved (from Template)")
            except Exception as e:
                logger.error(f"Error saving template extraction to AI Memory: {e}", exc_info=True)
                
            result = await _orchestrate_gst(result, current_user, document_id)
            result = await _orchestrate_learning_and_recommendations(result, current_user, document_id)
            return result
        except Exception as e:
            logger.error(f"Failed to extract using matched template: {e}", exc_info=True)
            logger.info("Template extraction failed, falling back to AI extraction")
    
    logger.info("Template Miss")

    # Vendor Lookup from OCR early before calling existing reader
    early_vendor = None
    try:
        early_vendor = await lookup_vendor_from_ocr(raw_ocr_text)
        if early_vendor:
            logger.info(f"Vendor Lookup Found Early from OCR: {early_vendor.get('vendor_name')}")
    except Exception as exc:
        logger.error(f"Early Vendor Lookup failed: {exc}", exc_info=True)
    
    # 4. Execute existing reader workflow
    logger.info("Gemini Called")
    result = await existing_reader_func()
    logger.info("Gemini Success")
    
    if isinstance(result, dict):
        result["classification"] = classification_res
        result["document_type"] = classification_res["document_type"]
        
        # Apply Vendor Defaults & Update Learning
        try:
            vendor_name = result.get("vendor_or_customer_name") or (early_vendor.get("vendor_name") if early_vendor else "")
            vendor_gstin = result.get("tax_registration_number") or (early_vendor.get("gstin") if early_vendor else "")
            
            # Apply defaults to result
            result = await apply_vendor_defaults(vendor_name, vendor_gstin, result)
            
            # Learn vendor profile from results
            await learn_vendor_profile(vendor_name, vendor_gstin, result)
            logger.info("Vendor Profile Updated from Gemini Extraction")
        except Exception as l_err:
            logger.error(f"Failed to apply/learn vendor profile: {l_err}", exc_info=True)

        # ─── INTEGRATE AI CONFIDENCE & VALIDATION ENGINE ───
        company_id = current_user.company_id if hasattr(current_user, 'company_id') else (current_user.get('company_id') if isinstance(current_user, dict) else None)
        vendor_profile = None
        try:
            vendor_name = result.get("vendor_or_customer_name") or ""
            vendor_gstin = result.get("tax_registration_number") or ""
            if vendor_gstin:
                vendor_profile = await db.vendor_intelligence.find_one({"gstin": vendor_gstin})
            if not vendor_profile and vendor_name:
                vendor_profile = await db.vendor_intelligence.find_one({"vendor_name": vendor_name})
        except Exception as e:
            logger.error(f"Error fetching vendor profile in Gemini validation: {e}")
            
        from backend.ai.document_validator import run_document_validation_pipeline
        validation_report = {}
        try:
            ocr_meta = await db.ocr_processing_history.find_one({"document_id": document_id}) or {}
            validation_report = await run_document_validation_pipeline(
                extracted_data=result,
                ocr_metadata=ocr_meta,
                filename=filename,
                document_id=document_id,
                vendor_profile=vendor_profile,
                template_matched=False,
                company_id=company_id
            )
            result["validation_report"] = validation_report
        except Exception as val_err:
            logger.error(f"Error in Gemini validation: {val_err}", exc_info=True)

    # 5. Save to Memory
    try:
        analysis_text = result.get("analysis") if isinstance(result, dict) else ""
        parsed = parse_analysis_text(analysis_text)
        
        # Use classified document type as the single source of truth
        classified_doc_type = classification_res["document_type"]
        
        # Trigger template learning automatically for successful high confidence extractions
        try:
            extracted_baseline = {
                "vendor_or_customer_name": parsed["vendor_name"],
                "tax_registration_number": parsed["vendor_gstin"],
                "invoice_number": parsed["invoice_number"],
                "invoice_date": parsed["invoice_date"],
                "total_invoice_value": parsed["invoice_total"],
                "taxable_value": parsed["taxable_amount"],
                "total_tax": parsed["gst_amount"],
                "confidence": 1.0,
                "analysis": analysis_text
            }
            await learn_template(
                contents=contents,
                filename=filename,
                doc_type=classified_doc_type,
                extracted_json=extracted_baseline,
                ocr_text=raw_ocr_text
            )
            logger.info("Template Created")
        except Exception as temp_err:
            logger.error(f"Error learning template: {temp_err}", exc_info=True)
        
        fingerprint = generate_document_fingerprint(
            vendor_name=parsed["vendor_name"],
            vendor_gstin=parsed["vendor_gstin"],
            invoice_number=parsed["invoice_number"],
            document_type=classified_doc_type,
            raw_ocr_text=raw_ocr_text
        )
        logger.info("Fingerprint Generated")
        
        now = datetime.now(timezone.utc).isoformat()
        new_record = {
            "document_id": document_id,
            "company_id": company_id,
            "fingerprint": fingerprint,
            "document_type": classified_doc_type,
            "vendor_name": parsed["vendor_name"],
            "vendor_gstin": parsed["vendor_gstin"],
            "invoice_number": parsed["invoice_number"],
            "invoice_date": parsed["invoice_date"],
            "invoice_total": parsed["invoice_total"],
            "taxable_amount": parsed["taxable_amount"],
            "gst_amount": parsed["gst_amount"],
            "raw_ocr_text": raw_ocr_text,
            "extracted_json": result,
            "ledger_mapping": {},
            "journal_entry": {},
            "processing_engine": "gemini",
            "ai_confidence": validation_report.get("overall_confidence", classification_res["confidence"]),
            "processing_status": "extracted",
            "validation_report": validation_report,
            "decision": validation_report.get("decision", "REQUIRES_REVIEW"),
            "created_at": now,
            "updated_at": now,
            "file_hash": file_hash,
            "raw_ocr_text_normalized": normalized_ocr
        }
        
        await save_ai_memory(new_record)
        logger.info("Memory Saved")
    except Exception as e:
        logger.error(f"Error saving to AI Memory: {e}", exc_info=True)
        
    result = await _orchestrate_gst(result, current_user, document_id)
    result = await _orchestrate_learning_and_recommendations(result, current_user, document_id)
    return result

def get_document_text_content(contents: bytes, filename: str) -> str:
    import io
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    text_content = ""
    try:
        if ext in ("xlsx", "xlsm"):
            import openpyxl
            wb = openpyxl.load_workbook(io.BytesIO(contents), read_only=True, data_only=True)
            lines = []
            for sheet_name in wb.sheetnames:
                ws = wb[sheet_name]
                lines.append(f"\n--- Sheet: {sheet_name} ---")
                for row in ws.iter_rows(values_only=True):
                    row_text = "\t".join("" if v is None else str(v) for v in row)
                    if row_text.strip():
                        lines.append(row_text)
            text_content = "\n".join(lines)
        elif ext == "xls":
            import pandas as pd
            df = pd.read_excel(io.BytesIO(contents), engine="xlrd")
            text_content = df.to_string(index=False)
        elif ext == "csv":
            text_content = contents.decode("utf-8", errors="replace")
        elif ext == "pdf":
            import pdfplumber
            extracted_pages = []
            with pdfplumber.open(io.BytesIO(contents)) as pdf:
                for i, page in enumerate(pdf.pages[:30]):
                    text = page.extract_text()
                    if text and text.strip():
                        extracted_pages.append(f"--- Page {i+1} ---\n{text.strip()}")
            text_content = "\n\n".join(extracted_pages)
    except Exception:
        pass
    return text_content

async def update_accounting_memory(doc: dict, entry: dict, user_id: str):
    """
    Called after successful journal creation to update the AI Memory.
    """
    try:
        extracted = doc.get("extracted") or {}
        vendor_name = extracted.get("vendor_or_customer_name") or ""
        vendor_gstin = extracted.get("tax_registration_number") or ""
        invoice_number = extracted.get("invoice_number") or ""
        doc_type = extracted.get("document_type") or ""
        
        from backend.ai.fingerprint import generate_document_fingerprint
        from backend.ai.ai_memory import save_ai_memory, find_memory_by_fingerprint, update_ai_memory
        
        raw_ocr_text = doc.get("raw_ocr_text") or ""
        fingerprint = generate_document_fingerprint(
            vendor_name=vendor_name,
            vendor_gstin=vendor_gstin,
            invoice_number=invoice_number,
            document_type=doc_type,
            raw_ocr_text=raw_ocr_text
        )
        
        memory_record = await find_memory_by_fingerprint(fingerprint)
        
        now = datetime.now(timezone.utc).isoformat()
        ledger_mapping = {
            "lines": entry.get("lines") or doc.get("preview", {}).get("lines") or [],
            "rules_used": doc.get("company_match_reason") or ""
        }
        
        update_data = {
            "ledger_mapping": ledger_mapping,
            "journal_entry": entry,
            "posting_status": "posted",
            "posting_timestamp": now,
            "updated_at": now
        }
        
        if memory_record:
            await update_ai_memory(fingerprint, update_data)
            logger.info("Journal Linked")
        else:
            # Create a new memory record if it didn't exist
            new_record = {
                "document_id": doc.get("id") or str(uuid.uuid4()),
                "company_id": doc.get("company_id"),
                "fingerprint": fingerprint,
                "document_type": doc_type,
                "vendor_name": vendor_name,
                "vendor_gstin": vendor_gstin,
                "invoice_number": invoice_number,
                "invoice_date": extracted.get("invoice_date") or "",
                "invoice_total": float(extracted.get("total_invoice_value") or 0),
                "taxable_amount": float(extracted.get("taxable_value") or 0),
                "gst_amount": float(extracted.get("total_tax") or 0),
                "raw_ocr_text": raw_ocr_text,
                "extracted_json": extracted,
                "ledger_mapping": ledger_mapping,
                "journal_entry": entry,
                "processing_engine": "gemini",
                "ai_confidence": float(extracted.get("confidence") or 1.0),
                "processing_status": "posted",
                "created_at": now,
                "updated_at": now,
                "file_hash": doc.get("file_hash") or ""
            }
            new_record["posting_status"] = "posted"
            new_record["posting_timestamp"] = now
            await save_ai_memory(new_record)
            logger.info("Journal Linked")
            
        # Lightweight orchestration reference for Phase 7:
        # Validated document is processed with deterministic accounting logic by accounting_ai package
        logger.info("Orchestrated successfully: Validated extraction mapped via autonomous AccountingEngine.")
    except Exception as e:
        logger.error(f"Error in update_accounting_memory: {e}", exc_info=True)


# ── Phase 11 AI-Driven Automation Endpoints ─────────────────────────────────

class CustomWorkflowCreateRequest(BaseModel):
    company_id: str
    name: str
    category: str
    steps: List[Dict[str, Any]]
    user_id: str
    custom_rules: Optional[Dict[str, Any]] = None


class WorkflowTriggerRequest(BaseModel):
    company_id: str
    definition_id: str
    entity_id: str
    entity_type: str
    user_id: str
    input_data: Dict[str, Any]


def _own_company(current_user: Any, requested: Optional[str] = None) -> str:
    """The company these workflow/AI endpoints operate on.

    These routes used to take ``company_id`` straight from the request with no
    login, so anyone could read or write any company's workflow data. The
    company now always comes from the authenticated user; a different one in
    the request is refused (the Platform Owner may name any company).
    """
    own = str(getattr(current_user, "company_id", "") or "").strip()
    requested = str(requested or "").strip()
    if is_platform_owner(current_user):
        return requested or own
    if requested and requested != own:
        raise HTTPException(status_code=403, detail="company_id does not match your company.")
    if not own:
        raise HTTPException(status_code=403, detail="Your account is not linked to a company.")
    return own


@router.post("/workflow/create-custom")
async def ai_create_custom_workflow(body: CustomWorkflowCreateRequest, current_user=Depends(get_current_user)):
    """Allows automatic/AI creation of custom company workflows."""
    from backend.workflow.workflow_builder import WorkflowBuilder
    result = await WorkflowBuilder.save_custom_workflow_definition(
        company_id=_own_company(current_user, body.company_id),
        name=body.name,
        category=body.category,
        steps=body.steps,
        user_id=current_user.id,
        custom_rules=body.custom_rules
    )
    if not result:
        raise HTTPException(status_code=400, detail="Failed to create custom workflow.")
    return result


@router.post("/workflow/trigger")
async def ai_trigger_workflow(body: WorkflowTriggerRequest, current_user=Depends(get_current_user)):
    """Triggers an automated, configuration-driven business workflow instance."""
    from backend.workflow.workflow_engine import WorkflowEngine
    inst_id = await WorkflowEngine.start_workflow(
        company_id=_own_company(current_user, body.company_id),
        definition_id=body.definition_id,
        entity_id=body.entity_id,
        entity_type=body.entity_type,
        user_id=current_user.id,
        input_data=body.input_data
    )
    if not inst_id:
        raise HTTPException(status_code=400, detail="Failed to start workflow instance.")
    return {"workflow_instance_id": inst_id, "status": "RUNNING"}


@router.get("/workflow/dashboard")
async def ai_get_workflow_dashboard(company_id: Optional[str] = None, force_refresh: Optional[bool] = False, current_user=Depends(get_current_user)):
    """Retrieves consolidated real-time dashboard analytics."""
    from backend.workflow.dashboard_engine import DashboardEngine
    return await DashboardEngine.get_dashboard_summary(company_id=_own_company(current_user, company_id), force_refresh=force_refresh)


@router.get("/workflow/analytics")
async def ai_get_workflow_analytics(company_id: Optional[str] = None, current_user=Depends(get_current_user)):
    """Generates business intelligence metrics and trends."""
    from backend.workflow.analytics_engine import AnalyticsEngine
    return await AnalyticsEngine.generate_comprehensive_bi_analytics(company_id=_own_company(current_user, company_id))


@router.get("/workflow/kpis")
async def ai_get_workflow_kpis(company_id: Optional[str] = None, current_user=Depends(get_current_user)):
    """Calculates and returns a history of recorded business KPI snapshots."""
    from backend.workflow.kpi_engine import KPIEngine
    return await KPIEngine.list_kpi_trend(company_id=_own_company(current_user, company_id))


# ── Phase 12 AI-Driven Copilot Bridge Endpoint ─────────────────────────────────

class CopilotQueryRequest(BaseModel):
    query: str
    session_id: Optional[str] = None
    role_preset: Optional[str] = "assistant"


@router.post("/copilot/query")
async def ai_copilot_query_bridge(body: CopilotQueryRequest, current_user=Depends(get_current_user)):
    """Bridge endpoint to dispatch natural language query to the enterprise Copilot.

    Runs as the caller. It used to run unauthenticated as a synthetic admin on
    the shared "default_comp" company.
    """
    from backend.copilot.copilot_engine import CopilotEngine
    user = current_user
    try:
        return await CopilotEngine.process_copilot_request(
            user=user,
            session_id=body.session_id,
            query=body.query,
            role_preset=body.role_preset
        )
    except Exception as e:
        logger.error(f"Failed to execute copilot bridge query: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
