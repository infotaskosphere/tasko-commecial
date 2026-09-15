"""Production voucher numbering and voucher persistence for Finix."""
from __future__ import annotations
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional
import uuid
from backend.dependencies import db
from backend.accounting_ai.accounting_controls import validate_balanced_lines, money
from backend.accounting_ai.posting_storage import PostingStorage
VOUCHER_PREFIXES={"PURCHASE":"PV","SALE":"SV","JOURNAL":"JV","PAYMENT":"PMT","RECEIPT":"RCPT","CONTRA":"CV","EXPENSE":"EV","PURCHASE_RETURN":"PRV","SALE_RETURN":"SRV","DEBIT_NOTE":"DN","CREDIT_NOTE":"CN","ADVANCE_PAYMENT":"APV","ADVANCE_RECEIPT":"ARV","RCM_PURCHASE":"RCM","FIXED_ASSET":"FAV","PAYROLL":"PAY","DEPRECIATION":"DEP","GST_PAYMENT":"GSTP","TDS_PAYMENT":"TDSP","STOCK_JOURNAL":"STJ","BANK_CHARGE":"BCV","BANK_TRANSFER":"BTV"}
def _financial_year(value:Optional[Any]=None)->str:
 if value is None:dt=date.today()
 elif isinstance(value,datetime):dt=value.date()
 elif isinstance(value,date):dt=value
 else:
  text=str(value).strip()
  if len(text)!=10:raise ValueError("Invalid voucher date. Expected YYYY-MM-DD.")
  dt=date.fromisoformat(text)
 start=dt.year if dt.month>=4 else dt.year-1; return f"{start}-{str(start+1)[-2:]}"
class VoucherBuilder:
 @staticmethod
 async def _ensure_sequence_index(): await db.accounting_sequences.create_index([("company_id",1),("voucher_type",1),("financial_year",1)],unique=True,name="uq_accounting_voucher_sequence")
 @classmethod
 async def next_voucher_number(cls,company_id:str,voucher_type:str,voucher_date:Optional[Any]=None)->str:
  if not company_id:raise ValueError("company_id is required.")
  typ=str(voucher_type or "JOURNAL").strip().upper(); fy=_financial_year(voucher_date); await cls._ensure_sequence_index()
  from pymongo import ReturnDocument
  doc=await db.accounting_sequences.find_one_and_update({"company_id":company_id,"voucher_type":typ,"financial_year":fy},{"$inc":{"next_number":1},"$set":{"updated_at":datetime.utcnow().isoformat()},"$setOnInsert":{"id":str(uuid.uuid4()),"company_id":company_id,"voucher_type":typ,"financial_year":fy,"created_at":datetime.utcnow().isoformat()}},upsert=True,return_document=ReturnDocument.AFTER)
  if not doc or not doc.get("next_number"):raise RuntimeError("Unable to allocate voucher sequence.")
  return f"{VOUCHER_PREFIXES.get(typ,'VCH')}/{fy}/{int(doc['next_number']):06d}"
 @staticmethod
 def generate_voucher_number(company_id:str,voucher_type:str,count:int=1,voucher_date:Optional[Any]=None)->str:return f"{VOUCHER_PREFIXES.get(str(voucher_type or 'JOURNAL').upper(),'VCH')}/{_financial_year(voucher_date)}/PENDING"
 @classmethod
 async def create_and_save_voucher(cls,company_id:str,voucher_type:str,document_id:str,journal_entry_id:str,party_name:str,total_amount:float,journal_lines:List[Dict[str,Any]],voucher_date:Optional[Any]=None,status:str="POSTED")->Dict[str,Any]:
  if not company_id or not document_id or not journal_entry_id:raise ValueError("company_id, document_id and journal_entry_id are required.")
  debit,credit=validate_balanced_lines(journal_lines); amount=money(total_amount)
  if amount<=0 or amount!=debit:raise ValueError(f"Voucher total {amount} does not exactly match journal total {debit}.")
  vid=str(uuid.uuid4()); number=await cls.next_voucher_number(company_id,voucher_type,voucher_date)
  data={"voucher_type":str(voucher_type or "JOURNAL").strip().upper(),"voucher_number":number,"document_id":document_id,"journal_entry_id":journal_entry_id,"party_name":(party_name or "").strip() or "Unspecified Party","total_amount":float(amount),"details":{"journal_lines_count":len(journal_lines),"debit_total":float(debit),"credit_total":float(credit),"memo_sample":journal_lines[0].get("memo","") if journal_lines else "","status":str(status or "POSTED").upper()}}
  await PostingStorage.save_voucher_history(vid,company_id,data); data["id"]=vid; return data
