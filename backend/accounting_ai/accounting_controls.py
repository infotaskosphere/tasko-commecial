"""Shared deterministic accounting controls for Finix."""
from __future__ import annotations
import hashlib, json, uuid
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Iterable, Optional
from fastapi import Depends, HTTPException, Query
from pydantic import BaseModel, Field
from pymongo import ReturnDocument
from backend.dependencies import db, get_current_user
from backend.models import User
SUPPORTED_DOCUMENT_TYPES = frozenset({"PURCHASE","SALE","EXPENSE","PAYMENT","RECEIPT","CONTRA","JOURNAL","PURCHASE_RETURN","SALE_RETURN","DEBIT_NOTE","CREDIT_NOTE","ADVANCE_PAYMENT","ADVANCE_RECEIPT","RCM_PURCHASE","FIXED_ASSET","PREPAID_EXPENSE","ACCRUAL","PROVISION","PAYROLL","DEPRECIATION","LOAN_RECEIPT","LOAN_REPAYMENT","INTEREST","GST_PAYMENT","TDS_PAYMENT","STOCK_JOURNAL","INVENTORY_ADJUSTMENT","BANK_CHARGE","BANK_TRANSFER"})
class AccountingControlError(ValueError): pass

def normalize_document_type(value: Any) -> str:
    if value is None: return "UNCLASSIFIED"
    value = str(value).strip().upper().replace("-","_").replace(" ","_")
    return value if value in SUPPORTED_DOCUMENT_TYPES else "UNCLASSIFIED"

def require_document_type(value: Any) -> str:
    result = normalize_document_type(value)
    if result == "UNCLASSIFIED": raise AccountingControlError("Transaction type could not be determined with sufficient evidence; posting requires human review.")
    return result

def parse_accounting_date(value: Any) -> date:
    if isinstance(value, datetime): return value.date()
    if isinstance(value, date): return value
    text = str(value or "").strip()
    if len(text) != 10: raise AccountingControlError("Accounting date is required in YYYY-MM-DD format.")
    try: return date.fromisoformat(text)
    except ValueError as exc: raise AccountingControlError(f"Invalid accounting date '{text}'. Expected YYYY-MM-DD.") from exc

def money(value: Any) -> Decimal:
    try: amount = Decimal(str(value if value is not None else "0"))
    except (InvalidOperation, ValueError, TypeError) as exc: raise AccountingControlError(f"Invalid monetary value: {value!r}") from exc
    if not amount.is_finite(): raise AccountingControlError("Monetary values must be finite numbers.")
    return amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

def validate_balanced_lines(lines: Iterable[dict[str, Any]], tolerance: Decimal = Decimal("0.00")) -> tuple[Decimal, Decimal]:
    rows=list(lines)
    if not rows: raise AccountingControlError("Journal entry must contain at least one line.")
    debit=Decimal("0.00"); credit=Decimal("0.00")
    for i,line in enumerate(rows,1):
        if not line.get("account_id"): raise AccountingControlError(f"Journal line {i} is missing account_id.")
        d,c=money(line.get("debit",0)),money(line.get("credit",0))
        if d<0 or c<0 or (d>0 and c>0) or (d==0 and c==0): raise AccountingControlError(f"Journal line {i} contains an invalid debit/credit amount.")
        debit+=d; credit+=c
    if debit<=0 or credit<=0 or abs(debit-credit)>tolerance: raise AccountingControlError(f"Journal entry does not balance: debit {debit} != credit {credit}.")
    return debit,credit

def ensure_source_key(source: Any, source_id: Any) -> tuple[str,str|None]:
    s=str(source or "manual").strip().lower()
    if not s: raise AccountingControlError("Posting source is required.")
    sid=str(source_id).strip() if source_id is not None else None
    return s,sid or None

from backend import accounting_lock as _integrity
from backend import accounting_core as _accounting_core

def _perms(user: User)->dict:
    if user.role=="admin": return {"admin":True}
    return user.permissions if isinstance(user.permissions,dict) else (user.permissions.model_dump() if user.permissions else {})
def _can_review(user:User)->bool: return user.role=="admin" or bool(_perms(user).get("can_post_journal_entries"))
def _can_audit(user:User)->bool: return user.role=="admin" or bool(_perms(user).get("can_view_journal_entries"))
def _authorized_company(requested_company_id:str,user:User)->str:
    requested=str(requested_company_id or "").strip(); own=str(getattr(user,"company_id",None) or "").strip()
    if user.role=="admin":
        if not requested: raise HTTPException(400,"company_id is required for accounting administration.")
        return requested
    if not own or requested!=own: raise HTTPException(403,"Accounting data is restricted to your company.")
    return own

def _canonical(value:Any)->str: return json.dumps(value,sort_keys=True,separators=(",",":"),default=str)
def _event_hash(previous_hash:str,event:dict)->str: return hashlib.sha256(f"{previous_hash}|{_canonical(event)}".encode()).hexdigest()

async def _append_audit(company_id:str,event_type:str,actor_id:Optional[str],payload:dict,document_id:Optional[str]=None)->dict:
    company=str(company_id or "")
    # Serialize writers per company through a database lock document. A stale
    # lock is recoverable; the audit chain itself remains the source of truth.
    now=datetime.now(timezone.utc).isoformat(); lock_id=f"audit:{company}"; token=str(uuid.uuid4())
    await db.accounting_audit_locks.update_one({"id":lock_id},{"$setOnInsert":{"id":lock_id,"company_id":company,"locked":False}},upsert=True)
    acquired=False
    for _ in range(40):
        result=await db.accounting_audit_locks.find_one_and_update({"id":lock_id,"locked":False},{"$set":{"locked":True,"token":token,"locked_at":now}},return_document=ReturnDocument.AFTER)
        if result and result.get("token")==token: acquired=True; break
        import asyncio; await asyncio.sleep(0.025)
    if not acquired: raise RuntimeError("Unable to acquire accounting audit lock; audit event blocked.")
    try:
        tail=await db.accounting_audit.find_one({"company_id":company},{"_id":0},sort=[("sequence",-1)])
        sequence=int(tail.get("sequence",0))+1 if tail else 1
        previous_hash=tail.get("event_hash") if tail else "GENESIS"
        event={"id":str(uuid.uuid4()),"company_id":company,"sequence":sequence,"event_type":event_type,"actor_id":actor_id,"document_id":document_id,"payload":payload,"created_at":now,"previous_hash":previous_hash}
        event["event_hash"]=_event_hash(previous_hash,event)
        await db.accounting_audit.insert_one(event)
        await db.accounting_audit_sequences.update_one({"company_id":company},{"$set":{"sequence":sequence,"updated_at":now}},upsert=True)
        return {k:v for k,v in event.items() if k!="_id"}
    finally:
        await db.accounting_audit_locks.update_one({"id":lock_id,"token":token},{"$set":{"locked":False},"$unset":{"token":"","locked_at":""}})

async def _install_failure_capture():
    current=_accounting_core.try_auto_post
    if getattr(current,"_finix_failure_capture",False): return
    async def wrapped(company_id,entry_date,narration,lines,source,source_id,created_by):
        result=await current(company_id,entry_date,narration,lines,source,source_id,created_by)
        if result is None:
            now=datetime.now(timezone.utc).isoformat()
            await db.accounting_posting_failures.update_one({"company_id":str(company_id or ""),"source":str(source or ""),"source_id":source_id},{"$set":{"lines":lines,"entry_date":entry_date,"narration":narration,"status":"PENDING_APPROVAL","approval_required":True,"updated_at":now},"$setOnInsert":{"id":str(uuid.uuid4()),"created_at":now}},upsert=True)
            try: await _append_audit(company_id,"POSTING_FAILURE_CREATED",created_by,{"source":source,"source_id":source_id,"status":"PENDING_APPROVAL"},source_id)
            except Exception: pass
        return result
    wrapped._finix_failure_capture=True; _accounting_core.try_auto_post=wrapped

@_integrity.router.on_event("startup")
async def install_posting_failure_capture(): await _install_failure_capture()

class ApprovalDecision(BaseModel): reason:str=Field(...,min_length=3,max_length=1000)

@_integrity.router.get("/posting-failures")
async def list_posting_failures(company_id:str=Query(""),status:Optional[str]=Query(None),limit:int=Query(100,ge=1,le=500),current_user:User=Depends(get_current_user)):
    company_id=_authorized_company(company_id,current_user)
    if not _can_review(current_user): raise HTTPException(403,"Access denied.")
    q={"company_id":company_id};
    if status:q["status"]=status.upper()
    rows=await db.accounting_posting_failures.find(q,{"_id":0}).sort("created_at",-1).limit(limit).to_list(limit)
    return {"items":rows,"count":len(rows)}

@_integrity.router.get("/approval-summary")
async def approval_summary(company_id:str=Query(""),current_user:User=Depends(get_current_user)):
    company_id=_authorized_company(company_id,current_user)
    if not _can_review(current_user): raise HTTPException(403,"Access denied.")
    rows=await db.accounting_posting_failures.aggregate([{"$match":{"company_id":company_id}},{"$group":{"_id":"$status","count":{"$sum":1}}}]).to_list(50)
    return {"statuses":{str(r.get("_id")):r.get("count",0) for r in rows}}

@_integrity.router.get("/audit-trail")
async def list_accounting_audit(company_id:str=Query(""),document_id:Optional[str]=Query(None),limit:int=Query(200,ge=1,le=1000),current_user:User=Depends(get_current_user)):
    company_id=_authorized_company(company_id,current_user)
    if not _can_audit(current_user): raise HTTPException(403,"Access denied.")
    q={"company_id":company_id};
    if document_id:q["document_id"]=document_id
    return await db.accounting_audit.find(q,{"_id":0}).sort("sequence",-1).limit(limit).to_list(limit)

@_integrity.router.get("/audit-trail/verify")
async def verify_accounting_audit(company_id:str=Query(""),current_user:User=Depends(get_current_user)):
    company_id=_authorized_company(company_id,current_user)
    if not _can_audit(current_user): raise HTTPException(403,"Access denied.")
    events=await db.accounting_audit.find({"company_id":company_id},{"_id":0}).sort("sequence",1).to_list(10000); previous="GENESIS"
    for expected,event in enumerate(events,1):
        if event.get("sequence")!=expected or event.get("previous_hash")!=previous:return {"valid":False,"reason":"Audit sequence/hash-chain mismatch.","sequence":event.get("sequence")}
        copy=dict(event); stored=copy.pop("event_hash",None)
        if _event_hash(previous,copy)!=stored:return {"valid":False,"reason":"Audit event checksum mismatch.","sequence":event.get("sequence")}
        previous=stored
    return {"valid":True,"events_checked":len(events),"last_sequence":len(events)}

@_integrity.router.post("/posting-failures/{failure_id}/reject")
async def reject_posting_failure(failure_id:str,body:ApprovalDecision,current_user:User=Depends(get_current_user)):
    if not _can_review(current_user):raise HTTPException(403,"Access denied.")
    failure=await db.accounting_posting_failures.find_one({"id":failure_id},{"_id":0})
    if not failure:raise HTTPException(404,"Posting failure not found.")
    company_id=_authorized_company(failure.get("company_id",""),current_user)
    result=await db.accounting_posting_failures.update_one({"id":failure_id,"company_id":company_id,"status":{"$in":["PENDING_APPROVAL","POSTING_FAILED"]}},{"$set":{"status":"REJECTED","rejected_by":current_user.id,"rejected_at":datetime.now(timezone.utc).isoformat(),"rejection_reason":body.reason.strip()}})
    if result.modified_count!=1:raise HTTPException(409,"Posting failure was already decided by another reviewer.")
    await _append_audit(company_id,"POSTING_FAILURE_REJECTED",current_user.id,{"failure_id":failure_id,"reason":body.reason.strip()},failure.get("source_id")); return {"success":True,"status":"REJECTED"}

@_integrity.router.post("/posting-failures/{failure_id}/approve")
async def approve_posting_failure(failure_id:str,body:ApprovalDecision,current_user:User=Depends(get_current_user)):
    if not _can_review(current_user):raise HTTPException(403,"Access denied.")
    failure=await db.accounting_posting_failures.find_one({"id":failure_id},{"_id":0})
    if not failure:raise HTTPException(404,"Posting failure not found.")
    company_id=_authorized_company(failure.get("company_id",""),current_user)
    if failure.get("status") not in {"PENDING_APPROVAL","POSTING_FAILED"}:raise HTTPException(409,f"Failure is already {failure.get('status')}.")
    lines=failure.get("lines")
    if not isinstance(lines,list) or not lines:raise HTTPException(409,"Saved journal proposal is missing.")
    try: parse_accounting_date(failure.get("entry_date")); validate_balanced_lines(lines)
    except Exception as exc:raise HTTPException(400,f"Approval validation failed: {exc}")
    now=datetime.now(timezone.utc).isoformat()
    claimed=await db.accounting_posting_failures.update_one({"id":failure_id,"company_id":company_id,"status":{"$in":["PENDING_APPROVAL","POSTING_FAILED"]}},{"$set":{"status":"APPROVED","approved_by":current_user.id,"approved_at":now,"approval_reason":body.reason.strip()}})
    if claimed.modified_count!=1:raise HTTPException(409,"Posting failure was already claimed by another reviewer.")
    await _append_audit(company_id,"POSTING_FAILURE_APPROVED",current_user.id,{"failure_id":failure_id,"reason":body.reason.strip()},failure.get("source_id"))
    try: result=await _accounting_core.post_journal_entry(company_id,failure.get("entry_date"),failure.get("narration",""),lines,failure.get("source","manual"),failure.get("source_id"),current_user.id)
    except Exception as exc:
        await db.accounting_posting_failures.update_one({"id":failure_id,"company_id":company_id},{"$set":{"status":"POSTING_FAILED","last_retry_error":str(exc),"updated_at":datetime.now(timezone.utc).isoformat()}})
        await _append_audit(company_id,"POSTING_RETRY_FAILED",current_user.id,{"failure_id":failure_id,"error":str(exc)},failure.get("source_id")); raise HTTPException(409,f"Approved posting could not be completed: {exc}")
    await db.accounting_posting_failures.update_one({"id":failure_id,"company_id":company_id},{"$set":{"status":"POSTED","journal_entry_id":result.get("id"),"posted_at":datetime.now(timezone.utc).isoformat()}})
    await _append_audit(company_id,"POSTING_RETRY_SUCCEEDED",current_user.id,{"failure_id":failure_id,"journal_entry_id":result.get("id")},result.get("id")); return {"success":True,"status":"POSTED","journal_entry":result}

async def create_accounting_approval_indexes():
    await db.accounting_posting_failures.create_index([("company_id",1),("status",1),("created_at",-1)])
    await db.accounting_posting_failures.create_index([("company_id",1),("source",1),("source_id",1)])
    await db.accounting_audit.create_index([("company_id",1),("sequence",1)],unique=True)
    await db.accounting_audit.create_index([("company_id",1),("document_id",1),("sequence",-1)])
    await db.accounting_audit_sequences.create_index("company_id",unique=True)
    await db.accounting_audit_locks.create_index("id",unique=True)
_original_integrity_index_creator=_integrity.create_accounting_integrity_indexes
async def _create_all_accounting_integrity_indexes():
    await _original_integrity_index_creator(); await create_accounting_approval_indexes()
_integrity.create_accounting_integrity_indexes=_create_all_accounting_integrity_indexes
