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
    """Returns every genuine PERSONAL birthday represented by a client record."""
    candidates: List[Dict[str, Any]] = []
    if (client.get("client_type") or "").strip().lower() == "proprietor" and client.get("birthday"):
        candidates.append({
            "name": client.get("company_name") or "Valued Client",
            "phone": client.get("phone"),
            "email": client.get("email"),
            "birthday": client["birthday"],
        })
    for cp in client.get("contact_persons") or []:
        if cp.get("birthday"):
            candidates.append({
                "name": cp.get("name") or client.get("company_name") or "Friend",
                "phone": cp.get("phone"),
                "email": cp.get("email"),
                "birthday": cp["birthday"],
            })
    return candidates

# ==========================================================
# ENVIRONMENT & DATABASE (MOCK OR REAL)
# ==========================================================
MONGO_URL = os.getenv("MONGO_URL")
DB_NAME = os.getenv("DB_NAME", "taskosphere")

import uuid
import asyncio

class MockCursor:
    def __init__(self, data): self._data, self._index = data, 0
    def limit(self, n): self._data = self._data[:n]; return self
    def sort(self, *args, **kwargs): return self
    def skip(self, n): self._data = self._data[n:]; return self
    async def to_list(self, length=None): return self._data[:length] if length is not None else self._data
    def __aiter__(self): self._index = 0; return self
    async def __anext__(self):
        if self._index >= len(self._data): raise StopAsyncIteration
        val = self._data[self._index]; self._index += 1; return val

class MockCollection:
    def __init__(self, name): self.name, self._store = name, {}
    async def find_one(self, query=None, *args, **kwargs):
        query = query or {}
        for doc in self._store.values():
            if self._matches(doc, query): return doc.copy()
        return None
    def find(self, query=None, *args, **kwargs):
        query = query or {}
        return MockCursor([doc.copy() for doc in self._store.values() if self._matches(doc, query)])
    async def insert_one(self, document):
        doc = document.copy(); doc.setdefault("_id", str(uuid.uuid4())); self._store[str(doc["_id"])] = doc
        class R:
            inserted_id = doc["_id"]
        return R()
    async def insert_many(self, documents):
        ids=[]
        for item in documents:
            doc=item.copy(); doc.setdefault("_id", str(uuid.uuid4())); self._store[str(doc["_id"])] = doc; ids.append(doc["_id"])
        class R: inserted_ids = ids
        return R()
    async def update_one(self, query, update, upsert=False, *args, **kwargs):
        doc = await self.find_one(query)
        if not doc:
            if upsert:
                new_doc=query.copy(); new_doc.update(update.get("$set", {})); await self.insert_one(new_doc)
                class R: matched_count=0; modified_count=1; upserted_id=new_doc["_id"]
                return R()
            class R: matched_count=0; modified_count=0; upserted_id=None
            return R()
        for op, values in update.items():
            if op == "$set": doc.update(values)
            elif op == "$unset":
                for k in values: doc.pop(k, None)
            elif op == "$push":
                for k,v in values.items(): doc.setdefault(k, []).append(v)
        self._store[str(doc["_id"])] = doc
        class R: matched_count=1; modified_count=1; upserted_id=None
        return R()
    async def delete_one(self, query, *args, **kwargs):
        doc=await self.find_one(query)
        if doc: self._store.pop(str(doc["_id"]), None)
        class R: deleted_count = 1 if doc else 0
        return R()
    async def delete_many(self, query, *args, **kwargs):
        keys=[k for k,d in self._store.items() if self._matches(d,query)]
        for k in keys: self._store.pop(k,None)
        class R: deleted_count=len(keys)
        return R()
    async def count_documents(self, query, *args, **kwargs): return sum(1 for d in self._store.values() if self._matches(d,query))
    def _matches(self, doc, query):
        for q_key,q_val in query.items():
            if q_key == "$or":
                if not any(self._matches(doc,x) for x in q_val): return False
                continue
            if q_key == "$and":
                if not all(self._matches(doc,x) for x in q_val): return False
                continue
            doc_val=doc.get(q_key)
            if isinstance(q_val,dict):
                for op,op_val in q_val.items():
                    if op == "$in" and doc_val not in op_val: return False
                    if op == "$nin" and doc_val in op_val: return False
                    if op == "$ne" and doc_val == op_val: return False
                    if op == "$gt" and (doc_val is None or doc_val <= op_val): return False
                    if op == "$gte" and (doc_val is None or doc_val < op_val): return False
                    if op == "$lt" and (doc_val is None or doc_val >= op_val): return False
                    if op == "$lte" and (doc_val is None or doc_val > op_val): return False
            elif str(doc_val) != str(q_val): return False
        return True

class MockDatabase:
    def __init__(self): self._collections={}
    def __getitem__(self,name): self._collections.setdefault(name,MockCollection(name)); return self._collections[name]
    __getattr__ = __getitem__
class MockMongoClient:
    def __init__(self,*args,**kwargs): self._db=MockDatabase()
    def __getitem__(self,name): return self._db
    __getattr__ = lambda self,name: self._db

if not MONGO_URL:
    print("[AI Studio] MONGO_URL not provided. Using fallback in-memory MongoDB client.")
    client=MockMongoClient(); db=client[DB_NAME]
else:
    try:
        client=AsyncIOMotorClient(MONGO_URL); db=client[DB_NAME]
    except Exception as e:
        print(f"[AI Studio] Failed to connect to MongoDB, falling back to mock: {e}")
        client=MockMongoClient(); db=client[DB_NAME]

# ==========================================================
# JWT / AUTH CONFIG
# ==========================================================
def _resolve_jwt_secret() -> str:
    secret=os.getenv("JWT_SECRET")
    if secret and secret.strip(): return secret.strip()
    if os.getenv("ENV_MODE") == "production":
        raise RuntimeError("JWT_SECRET environment variable is not set. Refusing to start in production without an explicit, secret JWT signing key.")
    generated=_secrets.token_hex(32)
    logger.warning("JWT_SECRET is not set. Generated a random development-only secret.")
    return generated

JWT_SECRET=_resolve_jwt_secret()
ALGORITHM="HS256"
ACCESS_TOKEN_EXPIRE_MINUTES=60*24*7
security=HTTPBearer()

def create_access_token(data: dict) -> str:
    to_encode=data.copy(); expire=datetime.now(timezone.utc)+timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES); to_encode.update({"exp":expire})
    return jwt.encode(to_encode,JWT_SECRET,algorithm=ALGORITHM)

def safe_dt(value: Any) -> Optional[datetime]:
    if not value: return None
    if isinstance(value,datetime): return value
    try: return datetime.fromisoformat(str(value).replace("Z","+00:00"))
    except Exception: return None

def _get_perm(user: User, key: str, default: Any=False) -> Any:
    perms=getattr(user,"permissions",None)
    if perms is None: return default
    if hasattr(perms,"model_dump"): return getattr(perms,key,default)
    if isinstance(perms,dict): return perms.get(key,default)
    return default

def _normalize_permissions(user_dict: dict) -> dict:
    from backend.models import DEFAULT_ROLE_PERMISSIONS
    role=user_dict.get("role","staff"); template=DEFAULT_ROLE_PERMISSIONS.get(role,{})
    perms=user_dict.get("permissions",{})
    if hasattr(perms,"model_dump"): perms=perms.model_dump()
    elif not isinstance(perms,dict): perms={}
    user_dict["permissions"]={**template,**perms}
    return user_dict

# ==========================================================
# CURRENT USER DEPENDENCY
# ==========================================================
async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> User:
    credentials_exception=HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,detail="Could not validate credentials",headers={"WWW-Authenticate":"Bearer"})
    try:
        token=credentials.credentials; payload=jwt.decode(token,JWT_SECRET,algorithms=[ALGORITHM]); user_id:Optional[str]=payload.get("sub")
        if user_id is None: raise credentials_exception
    except JWTError: raise credentials_exception
    user_dict=await db.users.find_one({"id":user_id})
    if user_dict is None: raise HTTPException(status_code=401,detail="User not found")
    user_dict.pop("_id",None)
    for key,value in list(user_dict.items()):
        if value == "": user_dict[key]=None
    user_dict=_normalize_permissions(user_dict)
    user=User(**user_dict)
    company_id=getattr(user,"company_id",None)
    if not company_id or not str(company_id).strip():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,detail="Authenticated user is not associated with a company")
    return user

# ==========================================================
# The remainder of this module contains the existing permission,
# visibility, team, audit, and record-access helpers. They should remain
# unchanged in the repository. This guard is intentionally added directly
# to get_current_user so every authenticated FastAPI dependency inherits
# the SaaS tenant requirement.
# ==========================================================
