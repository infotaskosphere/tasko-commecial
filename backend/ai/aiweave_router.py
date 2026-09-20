from __future__ import annotations
import base64, hashlib, logging, os, time, uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from backend.dependencies import db, get_current_user

logger = logging.getLogger("aiweave")
router = APIRouter(prefix="/aiweave", tags=["AIWeave"])

PROVIDERS = [
    {"id":"openai","name":"OpenAI / ChatGPT","category":"Frontier Commercial","adapter":"openai"},
    {"id":"gemini","name":"Google Gemini","category":"Frontier Commercial","adapter":"gemini"},
    {"id":"claude","name":"Anthropic Claude","category":"Frontier Commercial","adapter":"claude"},
    {"id":"grok","name":"xAI Grok","category":"Frontier Commercial","adapter":"openai"},
    {"id":"kimi","name":"Moonshot AI / Kimi","category":"Frontier Commercial","adapter":"openai"},
    {"id":"deepseek","name":"DeepSeek","category":"Open Weights & Fast Inference","adapter":"openai"},
    {"id":"qwen","name":"Alibaba Qwen","category":"Open Weights & Fast Inference","adapter":"openai"},
    {"id":"mistral","name":"Mistral AI","category":"Open Weights & Fast Inference","adapter":"openai"},
    {"id":"llama","name":"Meta Llama","category":"Open Weights & Fast Inference","adapter":"openai"},
    {"id":"groq","name":"Groq LPU","category":"Open Weights & Fast Inference","adapter":"openai"},
    {"id":"openrouter","name":"OpenRouter","category":"Model Aggregators & Gateways","adapter":"openai"},
    {"id":"together","name":"Together AI","category":"Model Aggregators & Gateways","adapter":"openai"},
    {"id":"ollama","name":"Ollama (Local)","category":"Local Inference","adapter":"ollama","is_local":True},
    {"id":"replit","name":"Replit Agent","category":"Autonomous Agent Platforms","adapter":None},
    {"id":"lovable","name":"Lovable","category":"Autonomous Agent Platforms","adapter":None},
    {"id":"mulerun","name":"MuleRun","category":"Autonomous Agent Platforms","adapter":None},
]
PROVIDER_MAP={p["id"]:p for p in PROVIDERS}
CAPABILITIES={"chat","reasoning","coding","debugging","vision","document_analysis","image_generation","tool_calling","agent_execution","long_context","structured_output"}
BASES={
 "openai":"https://api.openai.com/v1","grok":"https://api.x.ai/v1","kimi":"https://api.moonshot.ai/v1",
 "deepseek":"https://api.deepseek.com/v1","qwen":"https://dashscope.aliyuncs.com/compatible-mode/v1",
 "mistral":"https://api.mistral.ai/v1","llama":"https://api.groq.com/openai/v1","groq":"https://api.groq.com/openai/v1",
 "openrouter":"https://openrouter.ai/api/v1","together":"https://api.together.xyz/v1"
}
MODELS=[
 {"id":"gpt-5.6-sol","provider":"openai","name":"GPT-5.6 Sol","capabilities":["chat","reasoning","coding","debugging","vision","document_analysis","tool_calling","structured_output"]},
 {"id":"gpt-5.6-terra","provider":"openai","name":"GPT-5.6 Terra","capabilities":["chat","reasoning","coding","debugging","vision","document_analysis","tool_calling","structured_output"]},
 {"id":"gpt-5.6-luna","provider":"openai","name":"GPT-5.6 Luna","capabilities":["chat","coding","vision","document_analysis","structured_output"]},
 {"id":"gemini-3.8-flash","provider":"gemini","name":"Gemini 3.8 Flash","capabilities":["chat","reasoning","coding","vision","document_analysis","tool_calling","long_context","structured_output"]},
 {"id":"gemini-3.1-pro-preview","provider":"gemini","name":"Gemini 3.1 Pro","capabilities":["chat","reasoning","coding","vision","document_analysis","tool_calling","agent_execution","long_context","structured_output"]},
 {"id":"gemini-2.5-flash","provider":"gemini","name":"Gemini 2.5 Flash","capabilities":["chat","reasoning","coding","vision","document_analysis","tool_calling","long_context","structured_output"]},
 {"id":"claude-opus-5","provider":"claude","name":"Claude Opus 5","capabilities":["chat","reasoning","coding","debugging","vision","document_analysis","tool_calling","agent_execution","long_context","structured_output"]},
 {"id":"claude-sonnet-5","provider":"claude","name":"Claude Sonnet 5","capabilities":["chat","reasoning","coding","debugging","vision","document_analysis","tool_calling","structured_output"]},
 {"id":"grok-4.6","provider":"grok","name":"Grok 4.6","capabilities":["chat","reasoning","coding","vision","tool_calling","agent_execution","structured_output"]},
 {"id":"deepseek-reasoner","provider":"deepseek","name":"DeepSeek Reasoner","capabilities":["reasoning","coding","debugging","structured_output"]},
 {"id":"deepseek-chat","provider":"deepseek","name":"DeepSeek Chat","capabilities":["chat","coding","tool_calling","structured_output"]},
 {"id":"qwen-plus","provider":"qwen","name":"Qwen Plus","capabilities":["chat","reasoning","coding","document_analysis","structured_output"]},
 {"id":"mistral-large-latest","provider":"mistral","name":"Mistral Large","capabilities":["chat","reasoning","coding","document_analysis","tool_calling","structured_output"]},
 {"id":"llama-3.3-70b","provider":"llama","name":"Llama 3.3 70B","capabilities":["chat","reasoning","coding","document_analysis","structured_output"]},
 {"id":"llama-3.3-70b-versatile","provider":"groq","name":"Llama 3.3 70B Versatile","capabilities":["chat","reasoning","coding","document_analysis","tool_calling","structured_output"]},
 {"id":"openrouter/auto","provider":"openrouter","name":"OpenRouter Auto","capabilities":["chat","reasoning","coding","vision","document_analysis","tool_calling"]},
 {"id":"qwen2.5-coder:32b","provider":"ollama","name":"Qwen 2.5 Coder 32B (Local)","capabilities":["coding","debugging","tool_calling","structured_output"],"isLocal":True},
 {"id":"llama3.3:70b","provider":"ollama","name":"Llama 3.3 70B (Local)","capabilities":["chat","reasoning","coding","document_analysis","structured_output"],"isLocal":True},
]
DEFAULT_ROUTING={"strategy":"PRIORITY","preferredProvider":"auto","preferredModel":"auto","costPolicy":"FREE_FIRST","allowLocalFallback":True,"maxAccountAttempts":3,"maxProviderAttempts":3,"maxTotalAttempts":5,"retryOnRateLimit":True,"retryOnCapacityExhausted":True,"timeoutMs":60000,"companyIsolationEnabled":True}

def now(): return datetime.now(timezone.utc).isoformat()
def scope(user):
    company=str(getattr(user,"company_id","") or "").strip()
    uid=str(getattr(user,"id","") or "").strip()
    if company:return {"scope_type":"company","scope_id":company,"company_id":company}
    if uid:return {"scope_type":"user","scope_id":uid,"company_id":None}
    raise HTTPException(403,"AIWeave tenant scope is unavailable.")
def admin(user):
    role=str(getattr(user,"role","") or "").lower()
    if role in {"admin","super_admin","platform_admin","platform_owner","owner"}:return True
    p=getattr(user,"permissions",None)
    if hasattr(p,"model_dump"):p=p.model_dump()
    return isinstance(p,dict) and bool(p.get("can_manage_users") or p.get("can_manage_settings") or p.get("is_admin"))
def require_admin(user):
    if not admin(user):raise HTTPException(403,"Administrator permission is required for this AIWeave operation.")
    return user
def fernet():
    raw=os.getenv("AIWEAVE_CREDENTIAL_ENCRYPTION_KEY","").strip()
    if raw:
        try:return Fernet(raw.encode())
        except Exception as e:raise RuntimeError("AIWEAVE_CREDENTIAL_ENCRYPTION_KEY is invalid.") from e
    secret=os.getenv("JWT_SECRET","").strip()
    if not secret:raise RuntimeError("JWT_SECRET is required for AIWeave credential encryption.")
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(("aiweave:"+secret).encode()).digest()))
def enc(s): return fernet().encrypt(s.encode()).decode() if s else ""
def dec(s):
    if not s:return ""
    try:return fernet().decrypt(s.encode()).decode()
    except InvalidToken as e:raise HTTPException(500,"Stored provider credential cannot be decrypted.") from e
def mask(s):
    s=str(s or "")
    if "@" in s:
        a,b=s.split("@",1);return f"{a[:1]}{'*'*min(5,max(1,len(a)-1))}@{b}"
    return "***" if len(s)<7 else s[:2]+"*"*(len(s)-4)+s[-2:]
def safe(a):
    return {"id":str(a.get("id") or a.get("_id")),"provider":a.get("provider"),"name":a.get("name"),
            "maskedIdentity":a.get("masked_identity"),"status":a.get("status"),"health":a.get("health"),
            "capabilities":a.get("capabilities") or [],"priority":int(a.get("priority",1)),
            "weight":int(a.get("weight",100)),"enabled":bool(a.get("enabled",True)),
            "allowedTaskTypes":a.get("allowed_task_types") or ["*"],"allowedUsers":a.get("allowed_users") or ["*"],
            "allowedCompanies":a.get("allowed_companies") or [],"dailyLimit":a.get("daily_limit"),
            "monthlyLimit":a.get("monthly_limit"),"currentUsageTokens":int(a.get("current_usage_tokens",0) or 0),
            "totalRequests":int(a.get("total_requests",0) or 0),"lastUsed":a.get("last_used"),
            "lastChecked":a.get("last_checked"),"lastError":a.get("last_error"),"quota":a.get("quota") or {},
            "usage":a.get("usage") or {}}
def account_query(user):
    s=scope(user);uid=str(getattr(user,"id","") or "")
    return {**s,"$or":[{"allowed_users":{"$in":["*",uid]}},{"allowed_companies":{"$in":["*",s["company_id"] or ""]}}]}
async def get_account(aid,user):
    row=await db.aiweave_provider_accounts.find_one({**account_query(user),"id":str(aid)})
    if not row:raise HTTPException(404,"AIWeave provider account not found.")
    return row

class PError(Exception):
    def __init__(self,kind,msg):self.kind,self.msg=kind,msg;super().__init__(msg)
def classify(code, message=""):
    text=str(message or "").lower()
    if any(x in text for x in ("quota","token limit","tokens exhausted","context window","usage limit","insufficient quota")):
        return "TOKEN_EXHAUSTED" if "token" in text else "QUOTA_EXHAUSTED"
    if code in (401,403):return "AUTH_REQUIRED"
    if code==429:return "RATE_LIMITED"
    if code in (408,409,425,502,503,504):return "RETRYABLE_ACCOUNT_FAILURE"
    if code==413:return "CAPACITY_EXHAUSTED"
    if code>=500:return "PROVIDER_UNAVAILABLE"
    if 400<=code<500:return "NON_RETRYABLE_ACCOUNT_FAILURE"
    return "SUCCESS"
async def req(method,url,headers=None,params=None,json=None,timeout=30):
    async with httpx.AsyncClient(timeout=timeout) as c:return await c.request(method,url,headers=headers,params=params,json=json)
def err(resp):
    try:
        x=resp.json();e=x.get("error") if isinstance(x,dict) else None
        if isinstance(e,dict):return str(e.get("message") or e.get("type") or "Provider error")
        return str(x.get("detail") or x.get("message") or "Provider error")
    except Exception:return (resp.text or "Provider error")[:500]

async def openai_call(provider,key,model,prompt,timeout):
    r=await req("POST",BASES[provider]+"/chat/completions",{"Authorization":f"Bearer {key}","Content-Type":"application/json"},
                json={"model":model,"messages":[{"role":"user","content":prompt}],"temperature":0.2},timeout=timeout)
    if r.status_code!=200:
        msg=err(r);raise PError(classify(r.status_code,msg),msg)
    d=r.json();m=((d.get("choices") or [{}])[0]).get("message") or {};u=d.get("usage") or {}
    return {"output":str(m.get("content") or ""),"input_tokens":int(u.get("prompt_tokens",0) or 0),"output_tokens":int(u.get("completion_tokens",0) or 0),"provider_request_id":d.get("id")}

async def gemini_call(key,model,prompt,timeout):
    r=await req("POST",f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                {"Content-Type":"application/json"},{"key":key},
                {"contents":[{"role":"user","parts":[{"text":prompt}]}],"generationConfig":{"temperature":0.2}},timeout)
    if r.status_code!=200:
        msg=err(r);raise PError(classify(r.status_code,msg),msg)
    d=r.json();parts=(((d.get("candidates") or [{}])[0]).get("content") or {}).get("parts") or [];u=d.get("usageMetadata") or {}
    return {"output":"".join(str(x.get("text") or "") for x in parts if isinstance(x,dict)),"input_tokens":int(u.get("promptTokenCount",0) or 0),"output_tokens":int(u.get("candidatesTokenCount",0) or 0),"provider_request_id":None}

async def claude_call(key,model,prompt,timeout):
    r=await req("POST","https://api.anthropic.com/v1/messages",
                {"x-api-key":key,"anthropic-version":"2023-06-01","content-type":"application/json"},
                json={"model":model,"max_tokens":4096,"messages":[{"role":"user","content":prompt}]},timeout=timeout)
    if r.status_code!=200:raise PError(classify(r.status_code),err(r))
    d=r.json();u=d.get("usage") or {};parts=d.get("content") or []
    return {"output":"".join(str(x.get("text") or "") for x in parts if x.get("type")=="text"),"input_tokens":int(u.get("input_tokens",0) or 0),"output_tokens":int(u.get("output_tokens",0) or 0),"provider_request_id":d.get("id")}

async def ollama_call(base,model,prompt,timeout):
    r=await req("POST",(base or "http://127.0.0.1:11434").rstrip("/")+"/api/chat",
                {"Content-Type":"application/json"},json={"model":model,"messages":[{"role":"user","content":prompt}],"stream":False},timeout=timeout)
    if r.status_code!=200:raise PError(classify(r.status_code),err(r))
    d=r.json();m=d.get("message") or {}
    return {"output":str(m.get("content") or ""),"input_tokens":int(d.get("prompt_eval_count",0) or 0),"output_tokens":int(d.get("eval_count",0) or 0),"provider_request_id":None}

async def test_provider(row,key):
    p=row["provider"]
    if PROVIDER_MAP[p].get("adapter") is None:raise PError("NON_RETRYABLE_ACCOUNT_FAILURE","This provider requires a dedicated agent integration and is not connected by a generic API-key adapter.")
    if p=="ollama":
        r=await req("GET",(row.get("base_url") or "http://127.0.0.1:11434").rstrip("/")+"/api/tags",timeout=10)
    elif p=="gemini":
        r=await req("GET","https://generativelanguage.googleapis.com/v1beta/models",params={"key":key,"pageSize":"1"},timeout=15)
    elif p=="claude":
        r=await req("GET","https://api.anthropic.com/v1/models",
                    {"x-api-key":key,"anthropic-version":"2023-06-01"},timeout=15)
    else:
        r=await req("GET",BASES[p]+"/models",{"Authorization":f"Bearer {key}"},timeout=15)
    if r.status_code!=200:raise PError(classify(r.status_code),err(r))
    try:d=r.json()
    except Exception:d={}
    return {"message":"Provider credentials verified.","discovered":len(d.get("data") or d.get("models") or [])}

async def discover(row,key):
    p=row["provider"]
    try:
        if p in BASES:
            r=await req("GET",BASES[p]+"/models",{"Authorization":f"Bearer {key}"},timeout=20)
            if r.status_code!=200:return []
            return [{"id":str(x.get("id")),"provider":p,"name":str(x.get("id")),"capabilities":[],"availability":"discovered","lastVerified":now()} for x in r.json().get("data",[]) if x.get("id")]
        if p=="gemini":
            r=await req("GET","https://generativelanguage.googleapis.com/v1beta/models",params={"key":key,"pageSize":"1000"},timeout=20)
            if r.status_code!=200:return []
            return [{"id":str(x.get("name","")).replace("models/",""),"provider":p,"name":x.get("displayName") or x.get("name"),"capabilities":[],"availability":"discovered","lastVerified":now()} for x in r.json().get("models",[]) if x.get("name")]
        if p=="claude":
            r=await req("GET","https://api.anthropic.com/v1/models",headers={"x-api-key":key,"anthropic-version":"2023-06-01"},timeout=20)
            if r.status_code!=200:return []
            return [{"id":str(x.get("id")),"provider":p,"name":x.get("display_name") or x.get("id"),"capabilities":[],"availability":"discovered","lastVerified":now()} for x in r.json().get("data",[]) if x.get("id")]
        if p=="ollama":
            r=await req("GET",(row.get("base_url") or "http://127.0.0.1:11434").rstrip("/")+"/api/tags",timeout=20)
            if r.status_code!=200:return []
            return [{"id":str(x.get("name")),"provider":p,"name":str(x.get("name")),"capabilities":[],"availability":"discovered","lastVerified":now(),"isLocal":True} for x in r.json().get("models",[]) if x.get("name")]
    except Exception as e:logger.warning("AIWeave discovery failed for %s: %s",p,e)
    return []

def eligible(a,payload):
    if not a.get("enabled",True) or a.get("status") in {"DISABLED","DISCONNECTED","AUTH_REQUIRED","UNHEALTHY","RATE_LIMITED","CAPACITY_EXHAUSTED","ERROR"}:return False
    if a.get("health") not in {"HEALTHY","DEGRADED"}:return False
    allowed=a.get("allowed_task_types") or ["*"]
    if "*" not in allowed and payload.taskType not in allowed:return False
    caps=a.get("capabilities") or []
    return payload.requiredCapability in caps if caps else False
def rank(rows,strategy):
    if strategy=="LEAST_USED":return sorted(rows,key=lambda a:(int(a.get("current_usage_tokens",0) or 0),int(a.get("total_requests",0) or 0)))
    if strategy=="HEALTH_FIRST":return sorted(rows,key=lambda a:(0 if a.get("health")=="HEALTHY" else 1,int(a.get("priority",1))))
    if strategy=="WEIGHTED":return sorted(rows,key=lambda a:(-int(a.get("weight",100)),int(a.get("priority",1))))
    if strategy=="ROUND_ROBIN":return sorted(rows,key=lambda a:(a.get("last_used") or "",int(a.get("priority",1))))
    return sorted(rows,key=lambda a:(int(a.get("priority",1)), -int(a.get("weight",100))))
def provider_order(cfg,requested):
    default_order=["openai","gemini","claude","grok","kimi","deepseek","qwen","mistral","groq","openrouter","together"]
    x=cfg.get("preferredProvider")
    first=requested if requested and requested!="auto" else (x if x and x!="auto" else None)
    out=([first] if first else [])+[p for p in default_order if p!=first]
    if cfg.get("allowLocalFallback") and "ollama" not in out:out.append("ollama")
    return out
def model_for(provider,preferred,cap,cfg,discovered):
    # Execution uses provider-discovered models only. The static catalog is
    # descriptive UI metadata and is never treated as proof of availability.
    c=[m for m in discovered if m.get("provider")==provider and (not m.get("capabilities") or cap in m.get("capabilities",[]))]
    if preferred and preferred!="auto":
        return next((m for m in c if m.get("id")==preferred),None)
    return next((m for m in c if m.get("isFree")),None) if cfg.get("costPolicy")=="FREE_FIRST" else (c[0] if c else None)
async def routing(user):
    s=scope(user);r=await db.aiweave_routing_rules.find_one(s,{"_id":0});return {**DEFAULT_ROUTING,**(r or {})}
async def touch(a,ok,kind=None,latency=None,inp=0,out=0,error=None):
    usage=a.get("usage") or {};patch={"current_usage_tokens":int(a.get("current_usage_tokens",0) or 0)+inp+out,"total_requests":int(a.get("total_requests",0) or 0)+1,
      "last_used":now(),"last_checked":now(),"last_error":None if ok else (error or a.get("last_error")),
      "health":"HEALTHY" if ok else ("DEGRADED" if kind in {"RATE_LIMITED","RETRYABLE_ACCOUNT_FAILURE"} else "UNHEALTHY"),
      "status":"CONNECTED" if ok else (kind if kind in {"RATE_LIMITED","CAPACITY_EXHAUSTED","AUTH_REQUIRED"} else "ERROR"),
      "usage":{**usage,"last_latency_ms":latency,"last_input_tokens":inp,"last_output_tokens":out}}
    await db.aiweave_provider_accounts.update_one({"id":a["id"]},{"$set":patch})
async def execute_adapter(a,model,prompt,timeout):
    key=dec(a.get("credential_encrypted",""));p=a["provider"];ad=PROVIDER_MAP[p]["adapter"]
    if ad=="openai":return await openai_call(p,key,model,prompt,timeout)
    if ad=="gemini":return await gemini_call(key,model,prompt,timeout)
    if ad=="claude":return await claude_call(key,model,prompt,timeout)
    if ad=="ollama":return await ollama_call(a.get("base_url"),model,prompt,timeout)
    raise PError("NON_RETRYABLE_ACCOUNT_FAILURE","No provider adapter is configured for this provider.")

class Connect(BaseModel):
    providerId:str;name:str=Field(min_length=1,max_length=120);identity:str=Field(min_length=1,max_length=240)
    credentialSecret:str=Field(default="",max_length=20000);priority:int=Field(default=1,ge=1,le=1000);weight:int=Field(default=100,ge=1,le=100)
    dailyLimit:int=Field(default=0,ge=0);monthlyLimit:int=Field(default=0,ge=0);baseUrl:Optional[str]=Field(default=None,max_length=500)
    capabilities:List[str]=Field(default_factory=list)
class AccountUpdate(BaseModel):
    priority:Optional[int]=Field(default=None,ge=1,le=1000);weight:Optional[int]=Field(default=None,ge=1,le=100)
    enabled:Optional[bool]=None;allowedTaskTypes:Optional[List[str]]=None;allowedUsers:Optional[List[str]]=None
    allowedCompanies:Optional[List[str]]=None;dailyLimit:Optional[int]=Field(default=None,ge=0);monthlyLimit:Optional[int]=Field(default=None,ge=0)
class RoutingUpdate(BaseModel):
    strategy:Optional[str]=None;preferredProvider:Optional[str]=None;preferredModel:Optional[str]=None;costPolicy:Optional[str]=None
    allowLocalFallback:Optional[bool]=None;maxAccountAttempts:Optional[int]=Field(default=None,ge=1,le=10)
    maxProviderAttempts:Optional[int]=Field(default=None,ge=1,le=10);maxTotalAttempts:Optional[int]=Field(default=None,ge=1,le=15)
    retryOnRateLimit:Optional[bool]=None;retryOnCapacityExhausted:Optional[bool]=None;timeoutMs:Optional[int]=Field(default=None,ge=5000,le=180000)
class Execute(BaseModel):
    prompt:str=Field(min_length=1,max_length=100000)
    taskType:str="general"
    requiredCapability:str="chat"
    preferredProvider:str="auto"
    preferredModel:str="auto"
    conversationId:Optional[str]=None
    messages:List[Dict[str,Any]]=Field(default_factory=list)
    files:List[Dict[str,Any]]=Field(default_factory=list)
    mockSimulateExhaustion:bool=False

class ConversationCreate(BaseModel):
    title:Optional[str]=Field(default=None,max_length=160)

class ConversationMessage(BaseModel):
    role:str=Field(default="user",max_length=30)
    content:str=Field(min_length=1,max_length=100000)
    attachments:List[Dict[str,Any]]=Field(default_factory=list)

async def create_aiweave_indexes():
    try:
        await db.aiweave_conversations.create_index([("scope_type",1),("scope_id",1),("updated_at",-1)])
        await db.aiweave_conversations.create_index("conversation_id",unique=True)
        await db.aiweave_conversations.create_index([("scope_type",1),("scope_id",1),("pinned",1),("updated_at",-1)])
        await db.aiweave_provider_accounts.create_index([("scope_type",1),("scope_id",1),("provider",1),("status",1)])
        await db.aiweave_provider_accounts.create_index("id",unique=True)
        await db.aiweave_provider_models.create_index([("scope_type",1),("scope_id",1),("provider",1),("id",1)])
        await db.aiweave_routing_rules.create_index([("scope_type",1),("scope_id",1)],unique=True)
        await db.aiweave_executions.create_index([("scope_type",1),("scope_id",1),("timestamp",-1)])
        await db.aiweave_executions.create_index("execution_id",unique=True)
    except Exception as e:logger.warning("AIWeave index creation warning: %s",e)

@router.post("/conversations")
async def create_conversation(payload:ConversationCreate,user=Depends(get_current_user)):
    s=scope(user);cid=f"conv-{uuid.uuid4().hex[:16]}";title=(payload.title or "New conversation").strip()[:160] or "New conversation";ts=now()
    doc={**s,"conversation_id":cid,"id":cid,"title":title,"messages":[],"model_history":[],"provider_history":[],"execution_history":[],"attachments":[],"workspace_references":[],"fallback_history":[],"token_usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0},"status":"ACTIVE","pinned":False,"created_at":ts,"updated_at":ts}
    await db.aiweave_conversations.insert_one(doc);doc.pop("_id",None);return doc

@router.get("/conversations")
async def list_conversations(user=Depends(get_current_user)):
    s=scope(user)
    return await db.aiweave_conversations.find(s,{"_id":0}).sort([("pinned",-1),("updated_at",-1)]).limit(200).to_list(200)

@router.get("/conversations/{conversation_id}")
async def get_conversation(conversation_id:str,user=Depends(get_current_user)):
    s=scope(user);doc=await db.aiweave_conversations.find_one({**s,"conversation_id":conversation_id},{"_id":0})
    if not doc: raise HTTPException(404,"AIWeave conversation not found.")
    return doc

@router.delete("/conversations/{conversation_id}")
async def delete_conversation(conversation_id:str,user=Depends(get_current_user)):
    s=scope(user);result=await db.aiweave_conversations.delete_one({**s,"conversation_id":conversation_id})
    if result.deleted_count==0: raise HTTPException(404,"AIWeave conversation not found.")
    return {"success":True,"conversationId":conversation_id}

@router.post("/conversations/{conversation_id}/messages")
async def add_conversation_message(conversation_id:str,payload:ConversationMessage,user=Depends(get_current_user)):
    s=scope(user);doc=await db.aiweave_conversations.find_one({**s,"conversation_id":conversation_id})
    if not doc: raise HTTPException(404,"AIWeave conversation not found.")
    msg={"id":f"msg-{uuid.uuid4().hex[:12]}","role":payload.role,"content":payload.content,"attachments":payload.attachments or [],"created_at":now()}
    await db.aiweave_conversations.update_one({**s,"conversation_id":conversation_id},{"$push":{"messages":msg},"$set":{"updated_at":msg["created_at"]}})
    return msg

@router.get("/providers")
async def list_providers(user=Depends(get_current_user)):
    s=scope(user);rows=await db.aiweave_provider_accounts.find(s,{"_id":0}).to_list(500);out=[]
    for p in PROVIDERS:
        a=[x for x in rows if x.get("provider")==p["id"]]
        out.append({**p,"accountCount":len(a),"connectedCount":sum(x.get("status")=="CONNECTED" and x.get("enabled",True) for x in a),
          "healthyCount":sum(x.get("status")=="CONNECTED" and x.get("health")=="HEALTHY" and x.get("enabled",True) for x in a),
          "availableModelsCount":len([m for m in MODELS if m["provider"]==p["id"]]),"freeModelsCount":len([m for m in MODELS if m["provider"]==p["id"] and m.get("isFree")])})
    return out

@router.get("/accounts")
async def list_accounts(user=Depends(get_current_user)):
    rows=await db.aiweave_provider_accounts.find(account_query(user),{"_id":0}).to_list(500);return [safe(x) for x in rows]

@router.post("/accounts/connect")
async def connect(payload:Connect,user=Depends(require_admin)):
    p=PROVIDER_MAP.get(payload.providerId)
    if not p:raise HTTPException(400,"Unsupported AI provider.")
    if not p.get("adapter"):raise HTTPException(400,f"{p['name']} requires a dedicated provider integration; it is not simulated.")
    if not payload.credentialSecret and not p.get("is_local"):raise HTTPException(400,"Provider API credential is required.")
    s=scope(user);caps=[x for x in payload.capabilities if x in CAPABILITIES] or list(CAPABILITIES-{"image_generation","agent_execution"})
    row={"id":f"acc-{p['id']}-{uuid.uuid4().hex[:12]}",**s,"provider":p["id"],"name":payload.name.strip(),"masked_identity":mask(payload.identity),
         "credential_encrypted":enc(payload.credentialSecret),"status":"PENDING","health":"UNKNOWN","capabilities":caps,"priority":payload.priority,"weight":payload.weight,
         "enabled":True,"allowed_task_types":["*"],"allowed_users":["*"],"allowed_companies":[s["company_id"]] if s["company_id"] else [],
         "daily_limit":payload.dailyLimit,"monthly_limit":payload.monthlyLimit,"current_usage_tokens":0,"total_requests":0,"last_used":None,
         "last_checked":None,"last_error":None,"quota":{},"usage":{},"base_url":payload.baseUrl if p["id"]=="ollama" else None,"created_at":now(),"updated_at":now()}
    try:
        result=await test_provider(row,payload.credentialSecret)
        row.update(status="CONNECTED",health="HEALTHY",last_checked=now(),last_error=None)
        found=await discover(row,payload.credentialSecret)
        if found:
            await db.aiweave_provider_models.delete_many({**s,"provider":p["id"]})
            await db.aiweave_provider_models.insert_many([{**m,**s} for m in found[:500]])
    except PError as e:
        row.update(status=e.kind if e.kind in {"AUTH_REQUIRED","RATE_LIMITED","CAPACITY_EXHAUSTED"} else "ERROR",health="DEGRADED" if e.kind=="RATE_LIMITED" else "UNHEALTHY",last_checked=now(),last_error=e.msg[:500])
    await db.aiweave_provider_accounts.insert_one(row);return safe(row)

@router.post("/accounts/{aid}/test")
async def test(aid:str,user=Depends(require_admin)):
    row=await get_account(aid,user);key=dec(row.get("credential_encrypted",""));t=time.perf_counter()
    try:
        r=await test_provider(row,key);found=await discover(row,key);s=scope(user)
        await db.aiweave_provider_accounts.update_one({"id":aid},{"$set":{"status":"CONNECTED","health":"HEALTHY","last_checked":now(),"last_error":None,"updated_at":now()}})
        if found:
            await db.aiweave_provider_models.delete_many({**s,"provider":row["provider"]});await db.aiweave_provider_models.insert_many([{**m,**s} for m in found[:500]])
        return {"success":True,"accountId":aid,"status":"CONNECTED","health":"HEALTHY","latencyMs":int((time.perf_counter()-t)*1000),"message":r.get("message","Connection verified.")}
    except PError as e:
        st=e.kind if e.kind in {"RATE_LIMITED","AUTH_REQUIRED","CAPACITY_EXHAUSTED"} else "ERROR"
        await db.aiweave_provider_accounts.update_one({"id":aid},{"$set":{"status":st,"health":"DEGRADED" if st=="RATE_LIMITED" else "UNHEALTHY","last_checked":now(),"last_error":e.msg[:500],"updated_at":now()}})
        raise HTTPException(422,e.msg)

@router.post("/accounts/{aid}/toggle")
async def toggle(aid:str,user=Depends(require_admin)):
    row=await get_account(aid,user);enabled=not bool(row.get("enabled",True));st="CONNECTED" if enabled else "DISABLED"
    await db.aiweave_provider_accounts.update_one({"id":aid},{"$set":{"enabled":enabled,"status":st,"health":"HEALTHY" if enabled else row.get("health","UNKNOWN"),"updated_at":now()}})
    row.update(enabled=enabled,status=st);return safe(row)

@router.patch("/accounts/{aid}")
async def update(aid:str,payload:AccountUpdate,user=Depends(require_admin)):
    row=await get_account(aid,user);m={"priority":"priority","weight":"weight","enabled":"enabled","allowedTaskTypes":"allowed_task_types","allowedUsers":"allowed_users","allowedCompanies":"allowed_companies","dailyLimit":"daily_limit","monthlyLimit":"monthly_limit"}
    patch={m[k]:v for k,v in payload.model_dump(exclude_none=True).items() if k in m}
    if "enabled" in patch:patch["status"]="CONNECTED" if patch["enabled"] else "DISABLED"
    patch["updated_at"]=now();await db.aiweave_provider_accounts.update_one({"id":aid},{"$set":patch});row.update(patch);return safe(row)

@router.delete("/accounts/{aid}")
async def remove(aid:str,user=Depends(require_admin)):
    row=await get_account(aid,user);await db.aiweave_provider_accounts.delete_one({"id":aid})
    remaining=await db.aiweave_provider_accounts.count_documents({**scope(user),"provider":row["provider"]})
    if not remaining:await db.aiweave_provider_models.delete_many({**scope(user),"provider":row["provider"]})
    return {"success":True,"accountId":aid}

@router.get("/models")
async def models(user=Depends(get_current_user)):
    s=scope(user);found=await db.aiweave_provider_models.find(s,{"_id":0}).to_list(1000)
    out=[{**m,"availability":"catalog","lastVerified":None} for m in MODELS]
    for m in found:
        out=[x for x in out if (x.get("provider"),x.get("id"))!=(m.get("provider"),m.get("id"))];out.append(m)
    return out

@router.get("/routing-config")
async def get_routing(user=Depends(get_current_user)):return await routing(user)

@router.put("/routing-config")
async def set_routing(payload:RoutingUpdate,user=Depends(require_admin)):
    s=scope(user);cur=await routing(user);p=payload.model_dump(exclude_none=True)
    if p.get("preferredProvider") not in (None,"auto") and p["preferredProvider"] not in PROVIDER_MAP:raise HTTPException(400,"Unknown preferred provider.")
    if p.get("strategy") not in (None,"PRIORITY","ROUND_ROBIN","LEAST_USED","HEALTH_FIRST","WEIGHTED","CUSTOM"):raise HTTPException(400,"Unknown routing strategy.")
    if p.get("costPolicy") not in (None,"FREE_FIRST","LOWEST_COST","BALANCED","PERFORMANCE_FIRST","ADMIN_CUSTOM"):raise HTTPException(400,"Unknown cost policy.")
    merged={**cur,**p,"updated_at":now()};await db.aiweave_routing_rules.update_one(s,{"$set":{**s,**merged}},upsert=True);return merged

@router.get("/executions")
async def executions(user=Depends(get_current_user)):
    s=scope(user);return await db.aiweave_executions.find(s,{"_id":0}).sort("timestamp",-1).limit(200).to_list(200)

@router.post("/execute")
async def execute(payload:Execute,user=Depends(get_current_user)):
    if payload.requiredCapability not in CAPABILITIES: raise HTTPException(400,"Unsupported capability.")
    s=scope(user);cfg=await routing(user)
    accounts=await db.aiweave_provider_accounts.find(account_query(user),{"_id":0}).to_list(500)
    discovered=await db.aiweave_provider_models.find(s,{"_id":0}).to_list(1000)
    maxa=int(cfg.get("maxAccountAttempts",3));maxp=int(cfg.get("maxProviderAttempts",3));maxt=int(cfg.get("maxTotalAttempts",5));timeout=float(cfg.get("timeoutMs",60000))/1000
    trail=[];attempts=0;provider_attempts=0;chosen=None;chosen_model=None;result=None;started=time.perf_counter()
    # Preserve conversation context across every provider fallback.
    context_messages=[m for m in (payload.messages or []) if isinstance(m,dict) and m.get("role") in {"system","user","assistant"} and m.get("content")]
    context_text=""
    if context_messages:
        context_text="\n\n".join(f"{m.get('role','user').upper()}: {str(m.get('content'))[:30000]}" for m in context_messages[-30:])
    execution_prompt=payload.prompt
    if context_text:
        execution_prompt=f"Conversation context:\n{context_text}\n\nCURRENT USER REQUEST:\n{payload.prompt}"
    for pid in provider_order(cfg,payload.preferredProvider):
        if provider_attempts>=maxp or attempts>=maxt: break
        provider_attempts+=1;provider_seen=0
        for a in rank([x for x in accounts if x.get("provider")==pid],str(cfg.get("strategy","PRIORITY"))):
            if attempts>=maxt or provider_seen>=maxa: break
            if not eligible(a,payload): continue
            provider_seen+=1
            model=model_for(pid,payload.preferredModel,payload.requiredCapability,cfg,discovered)
            if not model:
                trail.append({"attempt":attempts+1,"provider":pid,"accountId":a.get("id"),"accountName":a.get("name"),"status":"MODEL_UNAVAILABLE","reason":"No compatible discovered model is available."});continue
            attempts+=1;t=time.perf_counter()
            if payload.mockSimulateExhaustion:
                e=PError("TOKEN_EXHAUSTED","Simulated token/quota exhaustion for fallback testing.")
                await touch(a,False,e.kind,latency=int((time.perf_counter()-t)*1000),error=e.msg)
                trail.append({"attempt":attempts,"provider":pid,"accountId":a.get("id"),"accountName":a.get("name"),"model":model["id"],"status":e.kind,"reason":e.msg})
                continue
            try:
                result=await execute_adapter(a,model["id"],execution_prompt,timeout);chosen=a;chosen_model=model
                await touch(a,True,latency=int((time.perf_counter()-t)*1000),inp=int(result.get("input_tokens",0) or 0),out=int(result.get("output_tokens",0) or 0));break
            except PError as e:
                await touch(a,False,e.kind,latency=int((time.perf_counter()-t)*1000),error=e.msg)
                trail.append({"attempt":attempts,"provider":pid,"accountId":a.get("id"),"accountName":a.get("name"),"model":model["id"],"status":e.kind,"reason":e.msg})
            except httpx.TimeoutException as e:
                kind="TIMEOUT";msg="Provider request timed out."
                await touch(a,False,kind,latency=int((time.perf_counter()-t)*1000),error=msg)
                trail.append({"attempt":attempts,"provider":pid,"accountId":a.get("id"),"accountName":a.get("name"),"model":model["id"],"status":kind,"reason":msg})
            except Exception as e:
                kind="NETWORK_ERROR" if isinstance(e,(httpx.NetworkError,httpx.ConnectError)) else "UNKNOWN_ERROR";msg=str(e)[:500] or "Provider execution failed."
                await touch(a,False,kind,latency=int((time.perf_counter()-t)*1000),error=msg)
                trail.append({"attempt":attempts,"provider":pid,"accountId":a.get("id"),"accountName":a.get("name"),"model":model["id"],"status":kind,"reason":msg})
        if result is not None: break
    if not result or not chosen or not chosen_model:
        raise HTTPException(503,"AIWeave could not complete this request because no configured AI provider is currently available.")
    inp=int(result.get("input_tokens",0) or 0);out=int(result.get("output_tokens",0) or 0);eid=f"exec-{uuid.uuid4().hex[:12]}"
    record={"id":eid,"execution_id":eid,"timestamp":now(),"user":str(getattr(user,"full_name",None) or getattr(user,"email",None) or getattr(user,"id","Current User")),"user_id":str(getattr(user,"id","")),"tenant_id":s["scope_id"],"company_id":s["company_id"],"conversation_id":payload.conversationId,"task_type":payload.taskType,"capability":payload.requiredCapability,"prompt":payload.prompt[:500],"provider":chosen["provider"],"providerName":PROVIDER_MAP[chosen["provider"]]["name"],"accountId":chosen["id"],"accountName":chosen.get("name"),"model":chosen_model["id"],"modelName":chosen_model.get("name"),"status":"SUCCESS","latencyMs":int((time.perf_counter()-started)*1000),"tokens":inp+out,"usage":{"input_tokens":inp,"output_tokens":out,"provider_reported":bool(inp or out)},"cost":None,"strategy":cfg.get("strategy"),"fallbackTrail":trail,"selectionReason":"Automatic fallback was used." if trail else "Primary eligible authorized account selected.","attempt_number":attempts,"provider_attempts":provider_attempts,"provider_request_id":result.get("provider_request_id"),"output":result.get("output","")}
    await db.aiweave_executions.insert_one({**s,**record})
    if payload.conversationId:
        conv=await db.aiweave_conversations.find_one({**s,"conversation_id":payload.conversationId})
        if conv:
            ts=now()
            user_msg={"id":f"msg-{uuid.uuid4().hex[:12]}","role":"user","content":payload.prompt,"created_at":ts,"attachments":payload.files or []}
            assistant_msg={"id":f"msg-{uuid.uuid4().hex[:12]}","role":"assistant","content":result.get("output",""),"created_at":ts,"provider":chosen["provider"],"providerName":PROVIDER_MAP[chosen["provider"]]["name"],"model":chosen_model["id"],"modelName":chosen_model.get("name"),"accountName":chosen.get("name"),"fallbackTrail":trail,"tokens":inp+out,"latencyMs":record["latencyMs"]}
            await db.aiweave_conversations.update_one({**s,"conversation_id":payload.conversationId},{"$push":{"messages":{"$each":[user_msg,assistant_msg]},"model_history":chosen_model["id"],"provider_history":chosen["provider"],"execution_history":eid,"fallback_history":{"$each":trail}},"$inc":{"token_usage.input_tokens":inp,"token_usage.output_tokens":out,"token_usage.total_tokens":inp+out},"$set":{"updated_at":ts,"status":"ACTIVE"}})
    return {k:v for k,v in record.items() if k not in {"tenant_id","company_id"}}

@router.get("/stats")
async def stats(user=Depends(get_current_user)):
    s=scope(user);a=await db.aiweave_provider_accounts.find(s,{"_id":0}).to_list(500);e=await db.aiweave_executions.find(s,{"_id":0}).to_list(500)
    return {"activeProvidersCount":len({x.get("provider") for x in a if x.get("status")=="CONNECTED" and x.get("enabled",True)}),
      "totalAccounts":len(a),"healthyAccounts":sum(x.get("status")=="CONNECTED" and x.get("health")=="HEALTHY" and x.get("enabled",True) for x in a),
      "exhaustedAccounts":sum(x.get("status") in {"CAPACITY_EXHAUSTED","RATE_LIMITED"} for x in a),
      "totalTokensTracked":sum(int(x.get("current_usage_tokens",0) or 0) for x in a),"totalExecutionsCount":len(e),
      "fallbackExecutions":sum(bool(x.get("fallbackTrail")) for x in e),"freeModelsCount":sum(bool(x.get("isFree")) for x in MODELS),"totalModelsCount":len(MODELS)}
