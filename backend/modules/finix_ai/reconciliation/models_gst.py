"""Finix domain models extracted from backend/gst_reconciliation.py."""
from datetime import date, datetime
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field, ConfigDict

class ReconciliationSession(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str; period: Optional[str]=None; portal_filename: str; books_filename: str
    created_at: datetime; created_by: str; created_by_name: Optional[str]=None
    summary: Dict[str,Any]=Field(default_factory=dict)

class SessionSaveBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    period: Optional[str]=None; client_id: Optional[str]=None
    client_name: Optional[str]=None; client_gstin: Optional[str]=None
    portal_filename: str=""; books_filename: str=""
    summary: Dict[str,Any]=Field(default_factory=dict)
    full_result: Optional[Dict[str,Any]]=None
    company: Optional[Dict[str,Any]]=None

class GSTR3BBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    period: Optional[str]=None; client_id: Optional[str]=None; client_name: Optional[str]=None
    gstr3b_igst: float=0.0; gstr3b_cgst: float=0.0; gstr3b_sgst: float=0.0
    gstr2b_igst: float=0.0; gstr2b_cgst: float=0.0; gstr2b_sgst: float=0.0

class ITCReversalBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    period: str; reversal_reason: str; client_id: Optional[str]=None; notes: Optional[str]=None
    igst_reversed: float=0.0; cgst_reversed: float=0.0; sgst_reversed: float=0.0

class VendorCommunicationBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    gstin: str; trade_name: Optional[str]=None
    issues: List[str]=Field(default_factory=list); period: Optional[str]=None

# ─── ENDPOINTS ────────────────────────────────────────────────────────────────

@router.get("/clients")
async def list_clients_for_gst(current_user: User=Depends(get_current_user)):
    """Return clients list for GST client-selector. Respects permission filter."""
    query = build_client_query(current_user)
    docs  = await db.clients.find({**query},
        {"_id":0,"id":1,"company_name":1,"gstin":1,"phone":1,"email":1,
         "address":1,"city":1,"state":1,"pan":1,"gst_treatment":1,"contact_persons":1},
    ).sort("company_name",1).to_list(2000)
    return {"clients": docs}


@router.post("/save-session")
async def save_session_from_frontend(body: SessionSaveBody, current_user: User=Depends(get_current_user)):
    """Persist a reconciliation session run in browser."""
    client_name=body.client_name or ""; client_gstin=body.client_gstin or ""
    if body.client_id and (not client_name or not client_gstin):
        doc = await db.clients.find_one({"id":body.client_id},{"_id":0,"company_name":1,"gstin":1})
        if doc:
            client_name  = client_name  or doc.get("company_name","")
            client_gstin = client_gstin or doc.get("gstin","")
    sid = str(uuid.uuid4())
    doc = {"_id":sid,"id":sid,"period":body.period,"client_id":body.client_id,
           "client_name":client_name,"client_gstin":client_gstin,
           "portal_filename":body.portal_filename,"books_filename":body.books_filename,
           "created_at":_now(),"created_by":current_user.id,
           "created_by_name":getattr(current_user,"full_name",""),
           "summary":body.summary,
           "full_result": body.full_result or {},
           "company": body.company or {}}
    await db.gst_reconciliation_sessions.insert_one(doc)
    await _log_audit("save_session", current_user, {"session_id":sid,"client":client_name})
    return {"session_id":sid,"created_at":doc["created_at"]}


@router.post("/reconcile")
async def reconcile_files(
    background_tasks: BackgroundTasks,
    portal_file: UploadFile=File(...), books_file: UploadFile=File(...),
    period:          Optional[str]=Form(None),
    save_session:    bool =Form(False),
    tolerance:       float=Form(TOLERANCE),
    enable_fuzzy:    bool =Form(True),
    fuzzy_threshold: float=Form(0.80),
    current_user: User=Depends(get_current_user),
):
    """Reconcile GSTR-2B vs Purchase Register with AI insights, fuzzy matching & ITC analysis."""
    pb = await portal_file.read(); bb = await books_file.read()
    for name,data in [(portal_file.filename,pb),(books_file.filename,bb)]:
        if len(data) > 20*1024*1024:
            raise HTTPException(400, f"File '{name}' exceeds 20 MB limit.")
    # Extract metadata from portal file header (period, taxpayer GSTIN, trade name)
    portal_meta = _extract_portal_metadata(pb, portal_file.filename or "portal.xlsx")
    # Use auto-detected period if not supplied explicitly by caller
    effective_period = period or portal_meta.get("period") or ""
    portal_df = _parse_portal(pb, portal_file.filename or "portal.xlsx")
    books_df  = _parse_books( bb, books_file.filename  or "books.xls")
    # Auto-fetch business names from GST portal for books rows missing trade_name
    try:
        books_df = await _enrich_books_with_names(books_df)
    except Exception as _exc:
        logger.warning("Books name enrichment failed: %s", _exc)
    # Delegate reconciliation operations to modular GST Intelligence engine
    from backend.gst_ai.gst_reconciliation_engine import GSTReconciliationEngine
    books_list = books_df.to_dict("records") if not books_df.empty else []
    portal_list = portal_df.to_dict("records") if not portal_df.empty else []
    engine_res = GSTReconciliationEngine.reconcile_books_vs_portal(
        books_invoices=books_list,
        portal_invoices=portal_list,
        tolerance=tolerance,
        enable_fuzzy=enable_fuzzy,
        fuzzy_threshold=fuzzy_threshold
    )

    result    = _reconcile(portal_df, books_df,
                           tolerance=tolerance, enable_fuzzy=enable_fuzzy, fuzzy_threshold=fuzzy_threshold)
    # Inject engine analytics and results
    result["engine_summary"] = engine_res["summary"]
    if save_session:
        sid = str(uuid.uuid4())
        await db.gst_reconciliation_sessions.insert_one({
            "_id":sid,"id":sid,"period":effective_period,
            "portal_filename":portal_file.filename or "","books_filename":books_file.filename or "",
            "created_at":_now(),"created_by":current_user.id,
            "created_by_name":getattr(current_user,"full_name",""),
            "summary":result["summary"],
            "full_result":result})
        result["session_id"] = sid
    result["portal_metadata"] = portal_meta
    result["detected_period"]  = effective_period
    background_tasks.add_task(_log_audit,"reconcile",current_user,
        {"period":effective_period,"portal":portal_file.filename,"books":books_file.filename,"summary":result["summary"]})
    return result


# ─── GSTR-3B vs 2B (NEW) ──────────────────────────────────────────────────────

@router.post("/gstr3b-vs-2b")
async def gstr3b_vs_2b(body: GSTR3BBody, current_user: User=Depends(get_current_user)):
    """Compare GSTR-3B ITC vs GSTR-2B auto-populated data. Returns variance + alerts."""
    di = round(body.gstr2b_igst-body.gstr3b_igst,2)
    dc = round(body.gstr2b_cgst-body.gstr3b_cgst,2)
    ds = round(body.gstr2b_sgst-body.gstr3b_sgst,2)
    td = round(di+dc+ds,2)
    alerts=[]
    if abs(td)>100: alerts.append(f"Significant ITC variance of Rs.{abs(td):,.2f} detected")
    if di<0: alerts.append(f"IGST claimed in 3B exceeds 2B by Rs.{abs(di):,.2f} - reversal may be needed")
    if dc<0: alerts.append(f"CGST claimed in 3B exceeds 2B by Rs.{abs(dc):,.2f} - reversal may be needed")
    if ds<0: alerts.append(f"SGST claimed in 3B exceeds 2B by Rs.{abs(ds):,.2f} - reversal may be needed")
    rid = str(uuid.uuid4())
    await db.gst_reconciliation_sessions.insert_one({
        "_id":rid,"id":rid,"type":"gstr3b_vs_2b","period":body.period,
        "client_id":body.client_id,"client_name":body.client_name,
        "gstr3b":{"igst":body.gstr3b_igst,"cgst":body.gstr3b_cgst,"sgst":body.gstr3b_sgst},
        "gstr2b":{"igst":body.gstr2b_igst,"cgst":body.gstr2b_cgst,"sgst":body.gstr2b_sgst},
        "variance":{"igst":di,"cgst":dc,"sgst":ds,"total":td},
        "alerts":alerts,"created_by":current_user.id,"created_at":_now()})
    return {"record_id":rid,"gstr3b":{"igst":body.gstr3b_igst,"cgst":body.gstr3b_cgst,"sgst":body.gstr3b_sgst},
            "gstr2b":{"igst":body.gstr2b_igst,"cgst":body.gstr2b_cgst,"sgst":body.gstr2b_sgst},
            "variance":{"igst":di,"cgst":dc,"sgst":ds,"total":td},
            "alerts":alerts,"requires_reversal":td < -100}


# ─── ITC REVERSAL (NEW) ───────────────────────────────────────────────────────

@router.post("/itc-reversal")
async def record_itc_reversal(body: ITCReversalBody, current_user: User=Depends(get_current_user)):
    """Record an ITC reversal entry."""
    total = round(body.igst_reversed+body.cgst_reversed+body.sgst_reversed,2)
    rid   = str(uuid.uuid4())
    await db.gst_reconciliation_sessions.insert_one({
        "_id":rid,"id":rid,"type":"itc_reversal","period":body.period,"client_id":body.client_id,
        "reversal_reason":body.reversal_reason,"igst_reversed":body.igst_reversed,
        "cgst_reversed":body.cgst_reversed,"sgst_reversed":body.sgst_reversed,
        "total_reversed":total,"notes":body.notes,"created_by":current_user.id,"created_at":_now()})
    await _log_audit("itc_reversal",current_user,{"period":body.period,"total":total})
    return {"record_id":rid,"total_reversed":total}


@router.get("/itc-reversals")
async def list_itc_reversals(client_id: Optional[str]=Query(None),
    skip:int=Query(0,ge=0), limit:int=Query(20,ge=1,le=100),
    current_user: User=Depends(get_current_user)):
    """List ITC reversal entries."""
    query: dict = {"type":"itc_reversal"}
    if client_id: query["client_id"]=client_id
    docs  = await db.gst_reconciliation_sessions.find(query,{"_id":0}).sort("created_at",-1).skip(skip).limit(limit).to_list(limit)
    total = await db.gst_reconciliation_sessions.count_documents(query)
    return {"reversals":docs,"total":total}


# ─── VENDOR RISK (NEW) ────────────────────────────────────────────────────────

@router.get("/vendor-risk")
async def get_vendor_risk_profiles(
    skip:int=Query(0,ge=0), limit:int=Query(50,ge=1,le=200),
    risk_level: Optional[str]=Query(None),
    current_user: User=Depends(get_current_user)):
    """Return saved vendor risk profiles."""
    query: dict = {}
    if risk_level: query["risk_level"]=risk_level
    docs  = await db.gst_vendor_profiles.find(query,{"_id":0}).sort("risk_score",-1).skip(skip).limit(limit).to_list(limit)
    total = await db.gst_vendor_profiles.count_documents(query)
    return {"vendors":docs,"total":total}


# ─── VENDOR COMMUNICATION (NEW) ───────────────────────────────────────────────

@router.post("/vendor-communication")
async def generate_vendor_communication(body: VendorCommunicationBody, current_user: User=Depends(get_current_user)):
    """Generate exportable vendor discrepancy notice template."""
    vendor_name = body.trade_name or body.gstin
    period_str  = body.period or "the current period"
    issues_text = "\n".join(f"  {i+1}. {issue}" for i,issue in enumerate(body.issues)) or "  1. Invoice details do not match between GSTR-2B and books."
    template = f"""GSTIN Reconciliation - Discrepancy Notice
==========================================
Date: {_now().strftime('%d %B %Y')}
To: {vendor_name} ({body.gstin})
Period: {period_str}

Dear Vendor,

During GSTR-2B reconciliation for {period_str}, we identified discrepancies:

{issues_text}

Request for Action:
  * Verify the above invoices and file amendments in GSTR-1 if applicable.
  * Ensure all B2B invoices are correctly reported to avoid ITC mismatch.
  * Respond within 7 working days.

Regards,
{getattr(current_user,'full_name','Accounts Team')}
==========================================
"""
    return {"template":template,"gstin":body.gstin,"vendor":vendor_name}



# ─── GSTIN NAME SCRAPER (own multi-source API) ───────────────────────────────
# In-memory cache: { gstin: {trade_name, legal_name, state, status, ts} }
_GSTIN_CACHE: Dict[str, Dict[str, Any]] = {}
_GSTIN_CACHE_TTL_SEC = 60 * 60 * 24 * 7  # 7 days

def _cache_get(gstin: str) -> Optional[Dict[str, Any]]:
    rec = _GSTIN_CACHE.get(gstin)
    if not rec: return None
    if (datetime.now(timezone.utc).timestamp() - rec.get("ts", 0)) > _GSTIN_CACHE_TTL_SEC:
        _GSTIN_CACHE.pop(gstin, None)
        return None
    return rec

def _cache_set(gstin: str, data: Dict[str, Any]):
    data["ts"] = datetime.now(timezone.utc).timestamp()
    _GSTIN_CACHE[gstin] = data

GSTIN_REGEX = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$")

def _is_valid_gstin(g: str) -> bool:
    return bool(g) and bool(GSTIN_REGEX.match(g.upper().strip()))

async def _scrape_gstin_name(gstin: str) -> Dict[str, Any]:
    """
    Fetch trade/legal name for a GSTIN from multiple public sources.
    Tries (in order):
      1. GST portal public API     (services.gst.gov.in/services/api/public/gstin)
      2. GST search taxpayer       (services.gst.gov.in/services/api/search/taxpayerDetails)
      3. KnowYourGST public scrape (knowyourgst.com/gst-number-search/{gstin})
    Returns dict with trade_name, legal_name, state, status, source. Always returns a dict
    (never raises) — empty strings if all sources fail.
    """
    gstin = gstin.upper().strip()
    if not _is_valid_gstin(gstin):
        return {"gstin": gstin, "trade_name": "", "legal_name": "", "error": "invalid_gstin"}

    cached = _cache_get(gstin)
    if cached:
        return {**cached, "gstin": gstin, "source": cached.get("source", "cache") + "+cache"}

    import httpx as _httpx
    headers_json = {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://services.gst.gov.in/services/searchtp",
    }
    headers_html = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml",
    }

    # Source 1 — public GSTIN endpoint
    try:
        async with _httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
            r = await client.get(
                f"https://services.gst.gov.in/services/api/public/gstin?gstin={gstin}",
                headers=headers_json,
            )
        if r.status_code == 200:
            d = r.json() or {}
            tn = (d.get("tradeNam") or d.get("tradeName") or "").strip()
            ln = (d.get("lgnm") or d.get("legalName") or "").strip()
            if tn or ln:
                out = {"gstin": gstin, "trade_name": tn, "legal_name": ln,
                       "state": (d.get("stj") or "").strip(), "status": (d.get("sts") or "").strip(),
                       "source": "gst_public_api"}
                _cache_set(gstin, out); return out
    except Exception as exc:
        logger.debug("GSTIN src1 failed %s: %s", gstin, exc)

    # Source 2 — taxpayer details
    try:
        async with _httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
            r = await client.get(
                f"https://services.gst.gov.in/services/api/search/taxpayerDetails?gstin={gstin}",
                headers=headers_json,
            )
        if r.status_code == 200:
            d = r.json() or {}
            tn = (d.get("tradeNam") or "").strip()
            ln = (d.get("lgnm") or "").strip()
            if tn or ln:
                out = {"gstin": gstin, "trade_name": tn, "legal_name": ln,
                       "state": (d.get("pradr", {}) or {}).get("addr", {}).get("stcd", "") if isinstance(d.get("pradr"), dict) else "",
                       "status": (d.get("sts") or "").strip(),
                       "source": "gst_taxpayer_api"}
                _cache_set(gstin, out); return out
    except Exception as exc:
        logger.debug("GSTIN src2 failed %s: %s", gstin, exc)

    # Source 3 — knowyourgst public page (regex scrape; brittle but useful fallback)
    try:
        async with _httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            r = await client.get(f"https://www.knowyourgst.com/gst-number-search/{gstin}/", headers=headers_html)
        if r.status_code == 200 and r.text:
            html = r.text
            tn = ""; ln = ""
            m = re.search(r"Trade Name[^<]*</[^>]+>\s*<[^>]+>\s*([^<]+)", html, re.I)
            if m: tn = m.group(1).strip()
            m = re.search(r"Legal Name[^<]*</[^>]+>\s*<[^>]+>\s*([^<]+)", html, re.I)
            if m: ln = m.group(1).strip()
            if not tn and not ln:
                m = re.search(r"<title>([^<]+)</title>", html, re.I)
                if m:
                    title = m.group(1).strip()
                    title = re.sub(r"\s*[\|\-]\s*KnowYourGST.*$", "", title, flags=re.I).strip()
                    if title and gstin not in title.upper():
                        tn = title
            if tn or ln:
                out = {"gstin": gstin, "trade_name": tn, "legal_name": ln,
                       "state": "", "status": "", "source": "knowyourgst_scrape"}
                _cache_set(gstin, out); return out
    except Exception as exc:
        logger.debug("GSTIN src3 failed %s: %s", gstin, exc)

    out = {"gstin": gstin, "trade_name": "", "legal_name": "", "state": "", "status": "",
           "source": "none", "error": "all_sources_failed"}
    return out

async def _enrich_books_with_names(books_df) -> "pd.DataFrame":
    """Best-effort enrich the books DataFrame with `trade_name` for GSTINs missing names.
    Limits to 30 unique lookups per call to stay snappy."""
    if books_df is None or books_df.empty or "trade_name" not in books_df.columns:
        return books_df
    missing = books_df[(books_df["trade_name"].fillna("") == "")]["gstin"].dropna().unique().tolist()
    missing = [g for g in missing if _is_valid_gstin(g)][:30]
    if not missing:
        return books_df
    import asyncio as _asyncio
    results = await _asyncio.gather(*[_scrape_gstin_name(g) for g in missing], return_exceptions=True)
    name_map = {}
    for res in results:
        if isinstance(res, dict) and (res.get("trade_name") or res.get("legal_name")):
            name_map[res["gstin"]] = res.get("trade_name") or res.get("legal_name")
    if name_map:
        books_df["trade_name"] = books_df.apply(
            lambda row: row["trade_name"] if row.get("trade_name") else name_map.get(row.get("gstin"), ""),
            axis=1,
        )
        logger.info("Books enriched with %d trade names from GST scraper", len(name_map))
    return books_df


# ─── GSTIN NAME LOOKUP ────────────────────────────────────────────────────────

@router.get("/gstin-lookup/{gstin}")
async def gstin_name_lookup(gstin: str, current_user: User = Depends(get_current_user)):
    """Fetch trade/legal name for a GSTIN.
    IMPORTANT: This endpoint must NEVER raise an unhandled exception — an
    unhandled 500 loses CORS headers and the browser shows a misleading
    CORS error instead of the real error. Always return a JSON dict."""
    gstin = (gstin or "").upper().strip()
    if not _is_valid_gstin(gstin):
        # Return graceful empty — not a 400, so CORS headers are kept
        return {"gstin": gstin, "trade_name": "", "legal_name": "",
                "state": "", "status": "", "source": "invalid_gstin"}
    try:
        import asyncio as _asyncio
        result = await _asyncio.wait_for(_scrape_gstin_name(gstin), timeout=12.0)
        return result
    except _asyncio.TimeoutError:
        logger.warning("GSTIN lookup timed out for %s", gstin)
        return {"gstin": gstin, "trade_name": "", "legal_name": "",
                "state": "", "status": "", "source": "timeout",
                "error": "lookup_timed_out"}
    except Exception as exc:
        logger.error("GSTIN lookup error for %s: %s", gstin, exc)
        return {"gstin": gstin, "trade_name": "", "legal_name": "",
                "state": "", "status": "", "source": "error",
                "error": str(exc)[:120]}

class GSTINBatchBody(BaseModel):
    gstins: List[str] = Field(default_factory=list)

@router.post("/gstin-lookup-batch")
async def gstin_name_lookup_batch(body: GSTINBatchBody, current_user: User = Depends(get_current_user)):
    """Batch GSTIN lookup. Returns {gstin: {trade_name, legal_name, ...}} for up to 50 GSTINs."""
    items = [g.upper().strip() for g in (body.gstins or []) if g and len(g.strip()) == 15][:50]
    if not items:
        return {"results": {}, "count": 0}
    import asyncio as _asyncio
    out = await _asyncio.gather(*[_scrape_gstin_name(g) for g in items], return_exceptions=True)
    results = {}
    for r in out:
        if isinstance(r, dict) and r.get("gstin"):
            results[r["gstin"]] = r
    return {"results": results, "count": len(results)}


# ─── HISTORY (v1 preserved) ───────────────────────────────────────────────────

@router.get("/history")
async def get_history(
    skip:        int            = Query(0,  ge=0),
    limit:       int            = Query(20, ge=1, le=200),
    client_id:   Optional[str] = Query(None),
    client_name: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    """Return saved reconciliation sessions (most recent first).
    Optional filters: client_id, client_name (substring, case-insensitive)."""
    query: Dict[str, Any] = {"type": {"$exists": False}}
    if client_id:
        query["client_id"] = client_id
    elif client_name:
        query["client_name"] = {"$regex": client_name.strip(), "$options": "i"}
    sessions = await db.gst_reconciliation_sessions.find(
        query, {"_id": 0, "full_result": 0}   # exclude full_result for listing (large)
    ).sort("created_at", -1).skip(skip).limit(limit).to_list(limit)
    total = await db.gst_reconciliation_sessions.count_documents(query)
    return {"sessions": sessions, "total": total}


@router.get("/history/{session_id}")
async def get_session(session_id:str, current_user: User=Depends(get_current_user)):
    doc = await db.gst_reconciliation_sessions.find_one({"id":session_id},{"_id":0})
    if not doc: raise HTTPException(404,"Session not found")
    return doc


@router.delete("/history/{session_id}")
async def delete_session(session_id:str, current_user: User=Depends(get_current_user)):
    doc = await db.gst_reconciliation_sessions.find_one({"id":session_id},{"_id":0,"created_by":1})
    if not doc: raise HTTPException(404,"Session not found")
    if current_user.role!="admin" and doc.get("created_by")!=current_user.id:
        raise HTTPException(403,"Not authorised to delete this session")
    await db.gst_reconciliation_sessions.delete_one({"id":session_id})

    await _log_audit("delete_session",current_user,{"session_id":session_id})
    return {"deleted":True}


# ─── SHARED TRADE NAMES (NEW) — one user updates = all users see it ───────────

class TradeNameBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    gstin: str
    name: str

class TradeNamesBatchBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    names: Dict[str, str] = Field(default_factory=dict)

@router.get("/trade-names")
async def get_trade_names(current_user: User = Depends(get_current_user)):
    """Return all shared GSTIN→party name mappings (shared across all users in the org)."""
    docs = await db.gst_trade_names.find({}, {"_id": 0, "gstin": 1, "name": 1}).to_list(10000)
    return {"names": {d["gstin"]: d["name"] for d in docs if d.get("gstin") and d.get("name")}}


@router.post("/trade-names")
async def save_trade_name(body: TradeNameBody, current_user: User = Depends(get_current_user)):
    """Upsert a single GSTIN→name mapping. Shared: all users will see this update."""
    gstin = body.gstin.strip().upper()
    name  = body.name.strip()
    if not gstin or not name:
        raise HTTPException(400, "gstin and name are required")
    await db.gst_trade_names.update_one(
        {"gstin": gstin},
        {"$set": {"gstin": gstin, "name": name, "updated_at": _now(), "updated_by": current_user.id,
                  "updated_by_name": getattr(current_user, "full_name", "")}},
        upsert=True,
    )
    await _log_audit("save_trade_name", current_user, {"gstin": gstin, "name": name})
    return {"ok": True, "gstin": gstin, "name": name}


@router.post("/trade-names/batch")
async def save_trade_names_batch(body: TradeNamesBatchBody, current_user: User = Depends(get_current_user)):
    """Bulk-upsert GSTIN→name mappings (up to 500 entries). Used on first load to sync localStorage → backend."""
    import pymongo as _pymongo
    entries = [
        (k.strip().upper(), v.strip())
        for k, v in (body.names or {}).items()
        if k and k.strip() and v and v.strip()
    ][:500]
    if not entries:
        return {"ok": True, "count": 0}
    ops = [
        _pymongo.UpdateOne(
            {"gstin": g},
            {"$set": {"gstin": g, "name": n, "updated_at": _now(), "updated_by": current_user.id,
                      "updated_by_name": getattr(current_user, "full_name", "")}},
            upsert=True,
        )
        for g, n in entries
    ]
    await db.gst_trade_names.bulk_write(ops)
    return {"ok": True, "count": len(entries)}


# ─── UPDATE SESSION METADATA ─────────────────────────────────────────────────

class SessionUpdateBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    period:       Optional[str]          = None
    client_id:    Optional[str]          = None
    client_name:  Optional[str]          = None
    client_gstin: Optional[str]          = None
    company:      Optional[Dict[str,Any]]= None
    portal_filename: Optional[str]       = None
    books_filename:  Optional[str]       = None
    # NEW: allow the frontend "Update" button to overwrite the saved snapshot
    # with the latest edited reconciliation result.
    summary:      Optional[Dict[str,Any]]= None
    full_result:  Optional[Dict[str,Any]]= None


@router.patch("/history/{session_id}")
async def update_session(session_id: str, body: SessionUpdateBody,
                         current_user: User = Depends(get_current_user)):
    """Update editable metadata on an existing reconciliation session.
    Allowed fields: period, client_id, client_name, client_gstin, company,
                    portal_filename, books_filename.
    The full_result (invoice data) is never mutated here."""
    doc = await db.gst_reconciliation_sessions.find_one(
        {"id": session_id}, {"_id": 0, "created_by": 1}
    )
    if not doc:
        raise HTTPException(404, "Session not found")

    # If client_id provided and name/gstin are missing, auto-fill from client record
    client_name  = body.client_name
    client_gstin = body.client_gstin
    if body.client_id and (not client_name or not client_gstin):
        cdoc = await db.clients.find_one(
            {"id": body.client_id}, {"_id": 0, "company_name": 1, "gstin": 1}
        )
        if cdoc:
            client_name  = client_name  or cdoc.get("company_name", "")
            client_gstin = client_gstin or cdoc.get("gstin", "")

    updates: Dict[str, Any] = {"updated_at": _now(), "updated_by": current_user.id,
                                "updated_by_name": getattr(current_user, "full_name", "")}
    if body.period       is not None: updates["period"]           = body.period
    if body.client_id    is not None: updates["client_id"]        = body.client_id
    if client_name       is not None: updates["client_name"]      = client_name
    if client_gstin      is not None: updates["client_gstin"]     = client_gstin
    if body.company      is not None: updates["company"]          = body.company
    if body.portal_filename is not None: updates["portal_filename"] = body.portal_filename
    if body.books_filename  is not None: updates["books_filename"]  = body.books_filename
    if body.summary         is not None: updates["summary"]         = body.summary
    if body.full_result     is not None: updates["full_result"]     = body.full_result

    await db.gst_reconciliation_sessions.update_one({"id": session_id}, {"$set": updates})
    await _log_audit("update_session", current_user,
                     {"session_id": session_id, "fields": list(updates.keys())})
    return {"ok": True, "session_id": session_id,
            "client_name": client_name, "client_gstin": client_gstin}


# ─── AUDIT LOG (NEW) ──────────────────────────────────────────────────────────

@router.get("/audit-log")
async def get_audit_log(skip:int=Query(0,ge=0), limit:int=Query(50,ge=1,le=200),
    current_user: User=Depends(get_current_user)):
    """Return GST audit log (admin only)."""
    if current_user.role!="admin": raise HTTPException(403,"Admin only")
    logs  = await db.gst_audit_logs.find({},{"_id":0}).sort("timestamp",-1).skip(skip).limit(limit).to_list(limit)
    total = await db.gst_audit_logs.count_documents({})
    return {"logs":logs,"total":total}


# ─── CLIENTS SUMMARY ─────────────────────────────────────────────────────────

@router.get("/clients-summary")
async def clients_summary(current_user: User = Depends(get_current_user)):
    """Return all unique clients that have reconciliation sessions, with aggregated stats.
    Groups by (client_id OR client_name) so unnamed sessions still appear.
    Returns: list of {client_id, client_name, client_gstin, session_count,
                       last_period, last_date, total_matched, total_books_only,
                       total_portal_only, total_mismatch}."""
    sessions = await db.gst_reconciliation_sessions.find(
        {"type": {"$exists": False}},
        {"_id": 0, "id": 1, "client_id": 1, "client_name": 1, "client_gstin": 1,
         "period": 1, "created_at": 1, "summary": 1, "company": 1}
    ).sort("created_at", -1).to_list(5000)

    groups: Dict[str, Dict[str, Any]] = {}
    # Build a reverse index: gstin → gkey, so sessions without client_id but with
    # the same GSTIN are folded into an already-created group (prevents duplication
    # when different users start sessions for the same client).
    gstin_to_gkey: Dict[str, str] = {}
    for s in sessions:
        # Group key: prefer client_id, fall back to GSTIN (normalised), then name, then "unknown"
        s_gstin = (s.get("client_gstin") or "").strip().upper()
        raw_gkey = s.get("client_id") or s_gstin or (s.get("client_name") or "").strip().lower() or "unknown"
        # If this session has no client_id but its GSTIN already maps to a group, use that group
        if not s.get("client_id") and s_gstin and s_gstin in gstin_to_gkey:
            gkey = gstin_to_gkey[s_gstin]
        else:
            gkey = raw_gkey
            if s_gstin and s_gstin not in gstin_to_gkey:
                gstin_to_gkey[s_gstin] = gkey
        sm   = s.get("summary") or {}
        if gkey not in groups:
            co = s.get("company") or {}
            groups[gkey] = {
                "client_id":    s.get("client_id")   or "",
                "client_name":  s.get("client_name") or co.get("name") or "Unknown Client",
                "client_gstin": s.get("client_gstin") or co.get("gstin") or "",
                "session_count":      0,
                "last_period":        None,
                "last_date":          None,
                "total_matched":      0,
                "total_books_only":   0,
                "total_portal_only":  0,
                "total_mismatch":     0,
                "total_matched_value":0.0,
                "sessions":           [],
            }
        g = groups[gkey]
        g["session_count"]      += 1
        g["total_matched"]      += sm.get("matched_count", 0) or 0
        g["total_books_only"]   += sm.get("books_only_count", 0) or 0
        g["total_portal_only"]  += sm.get("portal_only_count", 0) or 0
        g["total_mismatch"]     += sm.get("mismatch_count", 0) or 0
        g["total_matched_value"]+= sm.get("matched_value", 0.0) or 0.0
        if g["last_date"] is None:
            g["last_period"] = s.get("period") or ""
            g["last_date"]   = s.get("created_at")
        g["sessions"].append({
            "id":           s["id"],
            "period":       s.get("period") or "",
            "created_at":   s.get("created_at"),
            "matched":      sm.get("matched_count", 0) or 0,
            "mismatch":     sm.get("mismatch_count", 0) or 0,
            "portal_only":  sm.get("portal_only_count", 0) or 0,
            "books_only":   sm.get("books_only_count", 0) or 0,
            "matched_value":sm.get("matched_value", 0.0) or 0.0,
            "books_only_value": sm.get("books_only_value", 0.0) or 0.0,
        })

    result = sorted(groups.values(), key=lambda x: x["last_date"] or "", reverse=True)
    # Remove sessions list from top-level (available via history endpoint)
    for g in result:
        del g["sessions"]
    return {"clients": result, "total": len(result)}


@router.get("/client-sessions/{client_key}")
async def client_sessions(client_key: str, current_user: User = Depends(get_current_user)):
    """Return all sessions for a specific client (by client_id or normalised name key).
    Sessions are returned sorted by created_at desc so newest month is first."""
    import urllib.parse
    decoded = urllib.parse.unquote(client_key)
    # Try client_id first, then name match
    query: Dict[str, Any] = {"type": {"$exists": False}}
    # If the key looks like a UUID, match by client_id; otherwise match by name
    import re as _re
    if _re.match(r'^[0-9a-f-]{8,}$', decoded, _re.I):
        query["client_id"] = decoded
    else:
        name_lower = decoded.lower()
        all_sessions = await db.gst_reconciliation_sessions.find(
            {"type": {"$exists": False}},
            {"_id": 0, "id": 1, "client_id": 1, "client_name": 1, "client_gstin": 1,
             "period": 1, "created_at": 1, "summary": 1, "company": 1,
             "portal_filename": 1, "books_filename": 1, "created_by_name": 1}
        ).sort("created_at", -1).to_list(500)
        matched = [
            s for s in all_sessions
            if (s.get("client_name") or "").strip().lower() == name_lower
            or (s.get("client_id") or "") == decoded
        ]
        return {"sessions": matched, "total": len(matched)}

    docs = await db.gst_reconciliation_sessions.find(
        query,
        {"_id": 0, "id": 1, "client_id": 1, "client_name": 1, "client_gstin": 1,
         "period": 1, "created_at": 1, "summary": 1, "company": 1,
         "portal_filename": 1, "books_filename": 1, "created_by_name": 1}
    ).sort("created_at", -1).to_list(500)
    return {"sessions": docs, "total": len(docs)}


# ─── DASHBOARD SUMMARY (NEW) ──────────────────────────────────────────────────

@router.get("/dashboard-summary")
async def dashboard_summary(current_user: User=Depends(get_current_user)):
    """Aggregated stats for the GST dashboard."""
    total_sessions = await db.gst_reconciliation_sessions.count_documents({"type":{"$exists":False}})
    recent = await db.gst_reconciliation_sessions.find(
        {"type":{"$exists":False},"summary":{"$exists":True}},
        {"_id":0,"period":1,"summary":1,"created_at":1}
    ).sort("created_at",-1).limit(5).to_list(5)
    total_high_risk = await db.gst_vendor_profiles.count_documents({"risk_level":"high"})
    total_reversals = await db.gst_reconciliation_sessions.count_documents({"type":"itc_reversal"})
    return {"total_sessions":total_sessions,"total_high_risk_vendors":total_high_risk,
            "total_itc_reversals":total_reversals,"recent_sessions":recent}



# ─── AI INSIGHTS ENDPOINT (Grok / xAI) ───────────────────────────────────────

class AIInsightBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    summary: Dict[str, Any] = Field(default_factory=dict)
    mismatch_count: int = 0
    portal_only_count: int = 0
    books_only_count: int = 0
    high_risk_vendors: int = 0
    itc_eligible_total: float = 0.0
    itc_at_risk_total: float = 0.0
    period: Optional[str] = None
    top_mismatches: Optional[List[Dict[str, Any]]] = None

