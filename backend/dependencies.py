import os
import logging
import secrets as _secrets
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Dict, Any
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from motor.motor_asyncio import AsyncIOMotorClient
from backend.models import User, AuditLog

logger = logging.getLogger("dependencies")


def personal_birthday_candidates(client: Dict[str, Any]) -> List[Dict[str, Any]]:
    candidates=[]
    if (client.get("client_type") or "").strip().lower()=="proprietor" and client.get("birthday"):
        candidates.append({"name":client.get("company_name") or "Valued Client","phone":client.get("phone"),"email":client.get("email"),"birthday":client["birthday"]})
    for cp in client.get("contact_persons") or []:
        if cp.get("birthday"):
            candidates.append({"name":cp.get("name") or client.get("company_name") or "Friend","phone":cp.get("phone"),"email":cp.get("email"),"birthday":cp["birthday"]})
    return candidates

MONGO_URL=os.getenv("MONGO_URL")
DB_NAME=os.getenv("DB_NAME","taskosphere")
import uuid

class MockCursor:
    def __init__(self,data): self._data,self._index=data,0
    def limit(self,n): self._data=self._data[:n]; return self
    def sort(self,*args,**kwargs): return self
    def skip(self,n): self._data=self._data[n:]; return self
    async def to_list(self,length=None): return self._data[:length] if length is not None else self._data
    def __aiter__(self): self._index=0; return self
    async def __anext__(self):
        if self._index>=len(self._data): raise StopAsyncIteration
        value=self._data[self._index]; self._index+=1; return value

class MockCollection:
    def __init__(self,name): self.name=name; self._store={}
    async def find_one(self,query=None,*args,**kwargs):
        query=query or {}
        for doc in self._store.values():
            if self._matches(doc,query): return doc.copy()
        return None
    def find(self,query=None,*args,**kwargs):
        query=query or {}
        return MockCursor([d.copy() for d in self._store.values() if self._matches(d,query)])
    async def insert_one(self,document):
        doc=document.copy(); doc.setdefault("_id",str(uuid.uuid4())); self._store[str(doc["_id"])]=doc
        class R: pass
        r=R(); r.inserted_id=doc["_id"]; return r
    async def insert_many(self,documents):
        ids=[]
        for item in documents:
            doc=item.copy(); doc.setdefault("_id",str(uuid.uuid4())); self._store[str(doc["_id"])]=doc; ids.append(doc["_id"])
        class R: pass
        r=R(); r.inserted_ids=ids; return r
    async def update_one(self,query,update,upsert=False,*args,**kwargs):
        doc=await self.find_one(query)
        if not doc:
            if upsert:
                new_doc=query.copy(); new_doc.update(update.get("$set",{})); await self.insert_one(new_doc)
                class R: pass
                r=R(); r.matched_count=0; r.modified_count=1; r.upserted_id=new_doc["_id"]; return r
            class R: pass
            r=R(); r.matched_count=0; r.modified_count=0; r.upserted_id=None; return r
        for op,values in update.items():
            if op=="$set": doc.update(values)
            elif op=="$unset":
                for key in values: doc.pop(key,None)
            elif op=="$push":
                for key,value in values.items(): doc.setdefault(key,[]).append(value)
        self._store[str(doc["_id"])]=doc
        class R: pass
        r=R(); r.matched_count=1; r.modified_count=1; r.upserted_id=None; return r
    async def delete_one(self,query,*args,**kwargs):
        doc=await self.find_one(query)
        if doc: self._store.pop(str(doc["_id"]),None)
        class R: pass
        r=R(); r.deleted_count=1 if doc else 0; return r
    async def delete_many(self,query,*args,**kwargs):
        keys=[k for k,d in self._store.items() if self._matches(d,query)]
        for key in keys: self._store.pop(key,None)
        class R: pass
        r=R(); r.deleted_count=len(keys); return r
    async def count_documents(self,query,*args,**kwargs): return sum(1 for d in self._store.values() if self._matches(d,query))
    def _matches(self,doc,query):
        for key,value in query.items():
            if key=="$or":
                if not any(self._matches(doc,q) for q in value): return False
                continue
            if key=="$and":
                if not all(self._matches(doc,q) for q in value): return False
                continue
            actual=doc.get(key)
            if isinstance(value,dict):
                for op,target in value.items():
                    if op=="$in" and actual not in target: return False
                    if op=="$nin" and actual in target: return False
                    if op=="$ne" and actual==target: return False
                    if op=="$gt" and (actual is None or actual<=target): return False
                    if op=="$gte" and (actual is None or actual<target): return False
                    if op=="$lt" and (actual is None or actual>=target): return False
                    if op=="$lte" and (actual is None or actual>target): return False
            elif str(actual)!=str(value): return False
        return True

class MockDatabase:
    def __init__(self): self._collections={}
    def __getitem__(self,name): self._collections.setdefault(name,MockCollection(name)); return self._collections[name]
    def __getattr__(self,name): return self[name]
class MockMongoClient:
    def __init__(self,*args,**kwargs): self._db=MockDatabase()
    def __getitem__(self,name): return self._db
    def __getattr__(self,name): return self._db

if not MONGO_URL:
    print("[AI Studio] MONGO_URL not provided. Using fallback in-memory MongoDB client.")
    client=MockMongoClient(); db=client[DB_NAME]
else:
    try:
        client=AsyncIOMotorClient(MONGO_URL); db=client[DB_NAME]
    except Exception as e:
        print(f"[AI Studio] Failed to connect to MongoDB, falling back to mock: {e}")
        client=MockMongoClient(); db=client[DB_NAME]

def _resolve_jwt_secret() -> str:
    secret=os.getenv("JWT_SECRET")
    if secret and secret.strip(): return secret.strip()
    if os.getenv("ENV_MODE")=="production": raise RuntimeError("JWT_SECRET environment variable is not set. Refusing to start in production without an explicit secret.")
    generated=_secrets.token_hex(32); logger.warning("JWT_SECRET is not set. Generated a development-only secret."); return generated

JWT_SECRET=_resolve_jwt_secret(); ALGORITHM="HS256"; ACCESS_TOKEN_EXPIRE_MINUTES=60*24*7
security=HTTPBearer()

def create_access_token(data:dict)->str:
    payload=data.copy(); payload["exp"]=datetime.now(timezone.utc)+timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    return jwt.encode(payload,JWT_SECRET,algorithm=ALGORITHM)

def safe_dt(value:Any)->Optional[datetime]:
    if not value:return None
    if isinstance(value,datetime):return value
    try:return datetime.fromisoformat(str(value).replace("Z","+00:00"))
    except Exception:return None

def _get_perm(user:User,key:str,default:Any=False)->Any:
    perms=getattr(user,"permissions",None)
    if perms is None:return default
    if hasattr(perms,"model_dump"): return getattr(perms,key,default)
    if isinstance(perms,dict):return perms.get(key,default)
    return default

def _normalize_permissions(user_dict:dict)->dict:
    from backend.models import DEFAULT_ROLE_PERMISSIONS
    role=user_dict.get("role","staff"); template=DEFAULT_ROLE_PERMISSIONS.get(role,{})
    perms=user_dict.get("permissions",{})
    if hasattr(perms,"model_dump"):perms=perms.model_dump()
    elif not isinstance(perms,dict):perms={}
    user_dict["permissions"]={**template,**perms}; return user_dict

async def get_current_user(credentials:HTTPAuthorizationCredentials=Depends(security))->User:
    unauthorized=HTTPException(status_code=401,detail="Could not validate credentials",headers={"WWW-Authenticate":"Bearer"})
    try:
        payload=jwt.decode(credentials.credentials,JWT_SECRET,algorithms=[ALGORITHM]); user_id:Optional[str]=payload.get("sub")
        if user_id is None: raise unauthorized
    except JWTError: raise unauthorized
    user_dict=await db.users.find_one({"id":user_id})
    if user_dict is None: raise HTTPException(status_code=401,detail="User not found")
    user_dict.pop("_id",None)
    for key,value in list(user_dict.items()):
        if value=="":user_dict[key]=None
    user_dict=_normalize_permissions(user_dict)
    try:user=User(**user_dict)
    except Exception as e:
        logger.error("User validation failed for %s: %s",user_id,e); raise HTTPException(status_code=500,detail="User profile data is corrupted")
    company_id=getattr(user,"company_id",None)
    if not company_id or not str(company_id).strip():
        raise HTTPException(status_code=403,detail="Authenticated user is not associated with a company")
    return user

def check_permission(required_permission:str):
    async def checker(current_user:User=Depends(get_current_user))->User:
        if current_user.role=="admin" or _get_perm(current_user,required_permission,False):return current_user
        raise HTTPException(status_code=403,detail=f"Required permission: {required_permission}")
    return checker

def require_admin():
    async def checker(current_user:User=Depends(get_current_user))->User:
        if current_user.role!="admin":raise HTTPException(status_code=403,detail="Admin access required")
        return current_user
    return checker

def require_manager_or_admin():
    async def checker(current_user:User=Depends(get_current_user))->User:
        if current_user.role not in ["admin","manager"]:raise HTTPException(status_code=403,detail="Manager or Admin access required")
        return current_user
    return checker

def can_view_task(user,task):
    return user.role=="admin" or _get_perm(user,"can_view_all_tasks") or task.get("assigned_to") in (_get_perm(user,"view_other_tasks",[]) or []) or task.get("assigned_to")==user.id or task.get("created_by")==user.id or user.id in task.get("sub_assignees",[])
def can_edit_task(user,task):
    return user.role=="admin" or _get_perm(user,"can_edit_tasks") or task.get("created_by")==user.id or task.get("assigned_to")==user.id or user.id in task.get("sub_assignees",[])
def can_delete_task(user,task): return user.role=="admin" or _get_perm(user,"can_delete_tasks") or task.get("created_by")==user.id

def can_view_todo(user,todo): return user.role=="admin" or todo.get("user_id") in (_get_perm(user,"view_other_todos",[]) or []) or todo.get("user_id")==user.id
def can_edit_todo(user,todo): return user.role=="admin" or todo.get("user_id")==user.id

def can_view_client(user,client): return user.role=="admin" or _get_perm(user,"can_view_all_clients") or client.get("id") in (_get_perm(user,"assigned_clients",[]) or []) or client.get("assigned_to")==user.id
def can_edit_client(user,client): return user.role=="admin" or _get_perm(user,"can_edit_clients") or client.get("id") in (_get_perm(user,"assigned_clients",[]) or []) or client.get("assigned_to")==user.id
def can_delete_client(user): return user.role=="admin" or _get_perm(user,"can_edit_clients")
def can_view_report(user,target_user_id): return user.role=="admin" or _get_perm(user,"can_view_reports") or target_user_id in (_get_perm(user,"view_other_reports",[]) or []) or target_user_id==user.id
def can_download_report(user): return user.role=="admin" or _get_perm(user,"can_download_reports")
def can_view_attendance(user,target_user_id): return user.role=="admin" or _get_perm(user,"can_view_attendance") or target_user_id in (_get_perm(user,"view_other_attendance",[]) or []) or target_user_id==user.id
def can_view_activity(user,target_user_id): return user.role=="admin" or _get_perm(user,"can_view_staff_activity") or target_user_id in (_get_perm(user,"view_other_activity",[]) or [])
def can_view_lead(user,lead): return user.role=="admin" or _get_perm(user,"can_view_all_leads") or lead.get("assigned_to")==user.id or lead.get("created_by")==user.id
def can_edit_lead(user,lead): return user.role=="admin" or lead.get("assigned_to")==user.id or lead.get("created_by")==user.id
def can_delete_lead(user): return user.role=="admin" or _get_perm(user,"can_manage_users")
def can_manage_user(user): return user.role=="admin" or _get_perm(user,"can_manage_users")

def build_task_query(user,department_user_ids=None):
    if user.role=="admin" or _get_perm(user,"can_view_all_tasks"):return {}
    ors=[{"assigned_to":user.id},{"created_by":user.id},{"sub_assignees":user.id}]
    view_other=_get_perm(user,"view_other_tasks",[]) or []
    if user.role=="manager" and department_user_ids: ors += [{"assigned_to":{"$in":department_user_ids}},{"created_by":{"$in":department_user_ids}}]
    if view_other: ors.append({"assigned_to":{"$in":view_other}})
    return {"$or":ors}

def build_todo_query(user,target_user_id=None,department_user_ids=None):
    if user.role=="admin":return {"user_id":target_user_id} if target_user_id else {}
    if target_user_id:
        allowed=target_user_id==user.id or target_user_id in (_get_perm(user,"view_other_todos",[]) or []) or (user.role=="manager" and target_user_id in (department_user_ids or []))
        if not allowed:raise HTTPException(status_code=403,detail="You do not have access to this user's todos")
        return {"user_id":target_user_id}
    ors=[{"user_id":user.id}]; view_other=_get_perm(user,"view_other_todos",[]) or []
    if user.role=="manager" and department_user_ids:ors.append({"user_id":{"$in":department_user_ids}})
    if view_other:ors.append({"user_id":{"$in":view_other}})
    return {"$or":ors}

def build_client_query(user):
    if user.role=="admin" or _get_perm(user,"can_view_all_clients"):return {}
    ors=[{"assigned_to":user.id}]; assigned=_get_perm(user,"assigned_clients",[]) or []
    if assigned:ors.append({"id":{"$in":assigned}})
    return {"$or":ors}

def build_attendance_query(user,target_user_id=None,department_user_ids=None):
    if user.role=="admin":return {"user_id":target_user_id} if target_user_id else {}
    if target_user_id:
        if not can_view_attendance(user,target_user_id) and not (user.role=="manager" and target_user_id in (department_user_ids or [])):raise HTTPException(status_code=403,detail="You do not have access to this user's attendance")
        return {"user_id":target_user_id}
    if _get_perm(user,"can_view_attendance"):
        if user.role=="manager" and department_user_ids:return {"user_id":{"$in":[user.id]+department_user_ids}}
        return {}
    ids=[user.id]+(_get_perm(user,"view_other_attendance",[]) or []);return {"user_id":{"$in":ids}} if len(ids)>1 else {"user_id":user.id}

def build_report_query(user,target_user_id=None):
    resolved=target_user_id or user.id
    if not can_view_report(user,resolved):raise HTTPException(status_code=403,detail="You do not have permission to view this report")
    return resolved

async def get_same_department_user_ids(user_id,include_managers=False):
    user=await db.users.find_one({"id":user_id})
    if not user or not user.get("departments"):return []
    roles=["staff"] if not include_managers else ["staff","manager"]
    rows=await db.users.find({"departments":{"$in":user["departments"]},"id":{"$ne":user_id},"role":{"$in":roles}},{"_id":0,"id":1}).to_list(500)
    return [u["id"] for u in rows]
async def get_team_user_ids(manager_id): return []
async def get_cross_visibility_union(user_id):
    user=await db.users.find_one({"id":user_id})
    if not user:return []
    perms=user.get("permissions",{}) or {}; ids=set()
    for key in ("view_other_tasks","view_other_attendance","view_other_visits","view_other_todos","view_other_reports","view_other_activity"):
        value=perms.get(key) or []
        if isinstance(value,list):ids.update(value)
    ids.discard(user_id); return list(ids)

def check_department_data_access(user,resource,dept_user_ids):
    if user.role=="admin":return True
    resource_dept=resource.get("department") or resource.get("departments")
    if resource_dept:
        user_depts=user.departments or []
        if isinstance(resource_dept,list):
            if not any(d in user_depts for d in resource_dept):return False
        elif resource_dept not in user_depts:return False
    resource_user=resource.get("user_id") or resource.get("assigned_to") or resource.get("created_by")
    return resource_user==user.id or (user.role=="manager" and resource_user in dept_user_ids)

async def verify_record_access(current_user,record_owner_id):
    if current_user.role=="admin" or record_owner_id==current_user.id:return True
    raise HTTPException(status_code=403,detail="You do not have access to this resource")
async def verify_client_access(current_user,client):
    if can_view_client(current_user,client):return True
    raise HTTPException(status_code=403,detail="You do not have permission to access this client")
async def verify_activity_access(current_user,activity_user_id):
    if can_view_activity(current_user,activity_user_id):return True
    raise HTTPException(status_code=403,detail="You are not allowed to view this activity")

MODULE_ACTION_MAP={
"tasks.view":"can_view_tasks","tasks.create":"can_edit_tasks","tasks.edit":"can_edit_tasks","tasks.delete":"can_delete_tasks",
"clients.view":"can_view_clients","clients.create":"can_edit_clients","clients.edit":"can_edit_clients","clients.delete":"can_delete_data",
"leads.view":"can_view_all_leads","leads.create":"can_view_all_leads","leads.edit":"can_view_all_leads","leads.delete":"can_manage_users",
"quotations.view":"can_create_quotations","quotations.create":"can_create_quotations","quotations.edit":"can_create_quotations","quotations.delete":"can_create_quotations",
"invoicing.view":"can_manage_invoices","invoicing.create":"can_manage_invoices","invoicing.edit":"can_manage_invoices","invoicing.delete":"can_manage_invoices",
"password_vault.view":"can_view_passwords","password_vault.create":"can_edit_passwords","password_vault.edit":"can_edit_passwords","password_vault.delete":"can_edit_passwords",
"password_reset.view":"can_reset_client_passwords","password_reset.create":"can_reset_client_passwords","password_reset.edit":"can_reset_client_passwords","password_reset.export":"can_reset_client_passwords",
"dsc_register.view":"can_view_all_dsc","dsc_register.create":"can_edit_dsc","dsc_register.edit":"can_edit_dsc","dsc_register.delete":"can_edit_dsc",
"document_register.view":"can_view_documents","document_register.create":"can_edit_documents","document_register.edit":"can_edit_documents","document_register.delete":"can_edit_documents",
"users.view":"can_view_user_page","users.create":"can_manage_users","users.edit":"can_edit_users","users.delete":"can_manage_users",
"task_audit_log.view":"can_view_audit_logs","email_accounts.view":"can_connect_email","email_accounts.create":"can_connect_email","email_accounts.edit":"can_connect_email","email_accounts.delete":"can_connect_email",
"general_settings.view":"can_manage_settings","general_settings.update":"can_manage_settings","attendance.view":"can_view_attendance","attendance.create":"can_view_attendance","reports.view":"can_view_reports","reports.download":"can_download_reports",
"compliance.view":"can_view_compliance","compliance.create":"can_manage_compliance","compliance.edit":"can_manage_compliance","compliance.delete":"can_manage_compliance",
"salary_slips.view":"can_view_salary_slips","salary_slips.create":"can_manage_salary_slips","salary_slips.edit":"can_manage_salary_slips","salary_slips.delete":"can_manage_salary_slips",
"roc_sphere.view":"can_view_roc_sphere","roc_sphere.create":"can_manage_roc_sphere","roc_sphere.edit":"can_manage_roc_sphere","roc_sphere.delete":"can_manage_roc_sphere"}

def check_module_permission(module,action):
    key=f"{module}.{action}"; flag=MODULE_ACTION_MAP.get(key)
    async def checker(current_user=Depends(get_current_user)):
        if current_user.role=="admin":return current_user
        if flag is None:raise HTTPException(status_code=403,detail=f"No permission mapping found for {module}.{action}")
        if _get_perm(current_user,flag,False):return current_user
        raise HTTPException(status_code=403,detail=f"Permission required: {module}.{action} (flag: {flag})")
    return checker

def check_permission_and_visibility(module,action,record_user_field="created_by",assigned_field="assigned_to"): return None

def check_record_visibility(user,record,team_ids=None):
    if user.role=="admin":return True
    uid=user.id; owns=record.get("created_by")==uid or record.get("assigned_to")==uid or record.get("user_id")==uid
    if owns:return True
    return user.role=="manager" and bool(team_ids) and (record.get("assigned_to") in team_ids or record.get("created_by") in team_ids or record.get("user_id") in team_ids)
def assert_record_visibility(user,record,team_ids=None):
    if not check_record_visibility(user,record,team_ids):raise HTTPException(status_code=403,detail="Access denied: record not visible to your account")
def assert_module_permission(user,module,action):
    if user.role=="admin":return
    flag=MODULE_ACTION_MAP.get(f"{module}.{action}")
    if flag is None or not _get_perm(user,flag,False):raise HTTPException(status_code=403,detail=f"Permission required: {module}.{action}" if flag else f"No permission mapping found for {module}.{action}")

async def create_audit_log(current_user,action,module,record_id,old_data=None,new_data=None):
    log_entry=AuditLog(user_id=current_user.id,user_name=getattr(current_user,"full_name","Unknown"),action=action,module=module,record_id=record_id,old_data=old_data,new_data=new_data)
    await db.audit_logs.insert_one(log_entry.model_dump())

def get_user_permissions(current_user:User)->dict:
    perms=getattr(current_user,"permissions",None)
    if perms is None:return {}
    if isinstance(perms,dict):return perms
    if hasattr(perms,"model_dump"):return perms.model_dump()
    return {}

async def get_db(): yield db
admin_required=require_admin
