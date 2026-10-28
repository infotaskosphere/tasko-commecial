"""Phase 2 extracted subsystem: task_duplicate_detection.

This is a normal module. It used to be stored as a string (SOURCE) and run
with exec() inside backend.server's namespace. Every name it borrowed from
that shared namespace is now imported explicitly below, from the same
object the shared namespace held. It is loaded (in the original order) by
backend/server_modules/task_duplicate_detection.py via backend.server_modules.routes.load_into().
"""
from backend.dependencies import check_module_permission
from backend.dependencies import db
from backend.dependencies import get_current_user
from backend.dependencies import get_team_user_ids
from backend.dependencies import get_user_permissions
from backend.models import User
from backend.server_modules.task_analytics import get_task_analytics as _get_task_analytics
from fastapi import Depends
from fastapi import HTTPException
import httpx
import os
from backend.server import api_router, logger  # created in backend/server.py before route modules load

@api_router.get("/tasks/analytics")
async def get_task_analytics(
    month: str, current_user: User = Depends(check_module_permission("tasks", "view"))
):
    return await _get_task_analytics(month, current_user)


# ── AI: Detect Duplicate Tasks ─────────────────────────────────────────────────
@api_router.post("/tasks/detect-duplicates")
async def detect_duplicate_tasks(current_user: User = Depends(get_current_user)):
    """
    Use Gemini AI (gemini-2.0-flash) to find duplicate tasks.

    """
    import json as _json, re as _re

    # ── 1. Verify Gemini is configured ────────────────────────────────────
    gemini_key = os.environ.get("GEMINI_API_KEY", "")
    if not gemini_key:
        raise HTTPException(
            status_code=503, detail="GEMINI_API_KEY is not set on the server."
        )

    try:
        import google.generativeai as _genai

        _genai.configure(api_key=gemini_key)
        _model = _genai.GenerativeModel("gemini-2.0-flash")
    except ImportError:
        raise HTTPException(
            status_code=503, detail="google-generativeai package not installed."
        )

    # ── 2. Scope query same as GET /tasks ──────────────────────────────────
    query: dict = {"type": {"$ne": "todo"}}
    if current_user.role != "admin":
        permissions = get_user_permissions(current_user)
        allowed_users = permissions.get("view_other_tasks", []) or []
        if current_user.role == "manager":
            team_ids = await get_team_user_ids(current_user.id)
            allowed_users = list(set(allowed_users + team_ids))
        or_clauses = [
            {"assigned_to": current_user.id},
            {"sub_assignees": current_user.id},
            {"created_by": current_user.id},
        ]
        if allowed_users:
            or_clauses.append({"assigned_to": {"$in": allowed_users}})
        query["$or"] = or_clauses

    # Cap at 50 tasks to stay within free-tier token limits
    tasks = await db.tasks.find(query, {"_id": 0}).to_list(50)

    if not tasks:
        return {"groups": [], "total_tasks_scanned": 0}

    # ── 3. Build minimal payload ───────────────────────────────────────────
    task_summaries = [
        {
            "id": str(t.get("id", "")),
            "title": (t.get("title") or "")[:100],
            "desc": (t.get("description") or "")[:80],
            "cat": t.get("category") or "",
            "cid": t.get("client_id") or "",
        }
        for t in tasks
    ]

    prompt = (
        "Find duplicate or very similar tasks. "
        "Return ONLY a JSON array, no markdown, no explanation. "
        'Format: [{"reason":"brief reason","confidence":"high|medium","task_ids":["id1","id2"]}] '
        "Only groups with 2+ tasks. If none found return []. "
        f"Tasks: {_json.dumps(task_summaries, ensure_ascii=False)}"
    )

    # ── 4. Call Gemini ─────────────────────────────────────────────────────
    try:
        resp = await _model.generate_content_async(prompt)
        raw = _re.sub(r"```[a-zA-Z]*", "", resp.text.strip()).replace("```", "").strip()
        groups = _json.loads(raw)
        if not isinstance(groups, list):
            groups = []
    except Exception as e:
        err_str = str(e)
        if "429" in err_str or "quota" in err_str.lower() or "rate" in err_str.lower():
            raise HTTPException(
                status_code=429,
                detail=(
                    "Gemini API quota exceeded. "
                    "Upgrade at https://ai.google.dev/pricing or wait and retry."
                ),
            )
        logger.warning(f"Gemini duplicate detection failed: {e}")
        raise HTTPException(status_code=500, detail=f"AI error: {err_str[:200]}")

    return {"groups": groups, "total_tasks_scanned": len(tasks)}


# ── AI: Detect Duplicate Tasks via Groq (Llama) ────────────────────────────────
@api_router.post("/tasks/detect-duplicates-grok")
async def detect_duplicate_tasks_grok(
    payload: dict, current_user: User = Depends(get_current_user)
):
    """
    Use Groq API (llama-3.3-70b-versatile) to find duplicate tasks.
    Expects optional body: { "tasks": [...], "exclude_completed": true }
    Falls back to fetching tasks from DB if no tasks provided in payload.
    """
    import json as _json, re as _re

    # ── 1. Verify Groq is configured ──────────────────────────────────────
    groq_key = os.environ.get("GROQ_API_KEY", "")
    if not groq_key:
        raise HTTPException(
            status_code=503,
            detail="GROQ_API_KEY is not set on the server. Add your Groq API key to enable Grok duplicate detection.",
        )

    # ── 2. Get tasks — from payload or DB ────────────────────────────────
    incoming_tasks = payload.get("tasks") if payload else None
    exclude_completed = payload.get("exclude_completed", True) if payload else True

    if incoming_tasks and isinstance(incoming_tasks, list):
        tasks = incoming_tasks
    else:
        query: dict = {"type": {"$ne": "todo"}}
        if current_user.role != "admin":
            permissions = get_user_permissions(current_user)
            allowed_users = permissions.get("view_other_tasks", []) or []
            if current_user.role == "manager":
                team_ids = await get_team_user_ids(current_user.id)
                allowed_users = list(set(allowed_users + team_ids))
            or_clauses = [
                {"assigned_to": current_user.id},
                {"sub_assignees": current_user.id},
                {"created_by": current_user.id},
            ]
            if allowed_users:
                or_clauses.append({"assigned_to": {"$in": allowed_users}})
            query["$or"] = or_clauses
        tasks = await db.tasks.find(query, {"_id": 0}).to_list(50)

    if exclude_completed:
        tasks = [t for t in tasks if t.get("status") != "completed"]

    if not tasks:
        return {"groups": [], "total_tasks_scanned": 0}

    # ── 3. Build minimal task summaries ──────────────────────────────────
    task_summaries = [
        {
            "id": str(t.get("id", "")),
            "title": (t.get("title") or "")[:100],
            "desc": (t.get("description") or "")[:80],
            "cat": t.get("category") or "",
            "cid": str(t.get("client_id") or ""),
        }
        for t in tasks
    ]

    prompt = (
        "Find duplicate or very similar tasks. "
        "Return ONLY a JSON array, no markdown, no explanation. "
        'Format: [{"reason":"brief reason","confidence":"high|medium","task_ids":["id1","id2"]}] '
        "Only groups with 2+ tasks. If none found return []. "
        f"Tasks: {_json.dumps(task_summaries, ensure_ascii=False)}"
    )

    # ── 4. Call Groq API (OpenAI-compatible endpoint) ─────────────────────
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {groq_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "llama-3.3-70b-versatile",
                    "messages": [
                        {
                            "role": "system",
                            "content": "You are a task deduplication assistant. Always respond with valid JSON only — no markdown, no code fences, no explanation.",
                        },
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": 0.1,
                    "max_tokens": 1024,
                },
            )

        if response.status_code == 429:
            raise HTTPException(
                status_code=429,
                detail="Groq API rate limit exceeded. Please wait a moment and try again.",
            )
        if response.status_code == 401:
            raise HTTPException(
                status_code=503,
                detail="Invalid GROQ_API_KEY. Please check your Groq API key on Render.",
            )
        if not response.is_success:
            raise HTTPException(
                status_code=502,
                detail=f"Groq API error: {response.status_code} — {response.text[:200]}",
            )

        data = response.json()
        raw_text = data["choices"][0]["message"]["content"].strip()
        # Strip markdown code fences if model wraps response in them
        raw_text = _re.sub(r"```[a-zA-Z]*", "", raw_text).replace("```", "").strip()
        groups = _json.loads(raw_text)
        if not isinstance(groups, list):
            groups = []

    except HTTPException:
        raise
    except _json.JSONDecodeError as e:
        logger.warning(f"Groq returned non-JSON response: {e}")
        raise HTTPException(
            status_code=500, detail="Groq returned an unparseable response. Try again."
        )
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=504, detail="Groq API timed out. Please try again."
        )
    except Exception as e:
        err_str = str(e)
        logger.warning(f"Groq duplicate detection failed: {e}")
        raise HTTPException(status_code=500, detail=f"Groq error: {err_str[:200]}")

    return {"groups": groups, "total_tasks_scanned": len(tasks)}


# Helper functions
