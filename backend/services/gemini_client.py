"""
Reusable Google Gemini client for Taskosphere.

Uses Google's latest GenAI SDK (``google-genai``) — install with:

    pip install google-genai

Requires the GEMINI_API_KEY environment variable.

Public API
──────────
- ``get_gemini_client()``     → cached ``genai.Client`` instance
- ``gemini_extract_json``     → async, returns parsed dict from a Gemini vision
                                extraction using Gemini 2.5 Flash with strict
                                JSON output. Raises HTTPException(500) on
                                failure (never crashes the process).

Design notes
────────────
The client is intentionally minimal and does NOT touch any business logic,
accounting logic, journal generation, or database models. It only performs
the "AI document extraction" step. Downstream code continues to consume the
resulting Python dict exactly as before.
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Optional

from fastapi import HTTPException

logger = logging.getLogger(__name__)

_GEMINI_MODEL_NAME = os.environ.get("GEMINI_VISION_MODEL", "gemini-2.5-flash").strip() or "gemini-2.5-flash"

_client_instance = None  # cached genai.Client


def _get_api_key() -> str:
    """Read the Gemini API key from environment.

    Only ``GEMINI_API_KEY`` is used, per project convention.
    """
    key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    return key


def get_gemini_client():
    """Return a cached ``google.genai.Client`` instance.

    Raises HTTPException(500) if either the SDK isn't installed or the
    ``GEMINI_API_KEY`` env var is missing.
    """
    global _client_instance
    if _client_instance is not None:
        return _client_instance

    api_key = _get_api_key()
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="GEMINI_API_KEY is not configured on the server."
        )

    try:
        from google import genai  # type: ignore
    except ImportError as e:
        logger.exception("google-genai SDK not installed")
        raise HTTPException(
            status_code=500,
            detail=(
                "google-genai package is not installed. "
                "Run `pip install google-genai` and redeploy."
            ),
        ) from e

    try:
        _client_instance = genai.Client(api_key=api_key)
    except Exception as e:
        logger.exception("Failed to initialise Gemini client")
        raise HTTPException(status_code=500, detail=f"Failed to initialise Gemini client: {e}") from e
    return _client_instance


def _strip_json_fence(text: str) -> str:
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return text.strip()


async def gemini_extract_json(
    image_b64: str,
    mime_type: str,
    prompt: str,
    *,
    model: Optional[str] = None,
) -> dict:
    """Send an image + prompt to Gemini 2.5 Flash and return the parsed JSON.

    Parameters
    ----------
    image_b64 : str
        Base64-encoded image bytes (JPEG/PNG/etc). PDFs should be
        rasterised by the caller before invoking this function.
    mime_type : str
        e.g. ``"image/jpeg"``.
    prompt : str
        The extraction prompt that instructs Gemini to reply in strict JSON.
    model : str, optional
        Override the default model (``gemini-2.5-flash``).

    Returns
    -------
    dict
        The parsed JSON object returned by Gemini.

    Raises
    ------
    HTTPException(500)
        If the SDK isn't installed, the API key is missing, Gemini itself
        errors out, or the response is not valid JSON. The server is never
        allowed to crash — every exception is caught and re-raised as an
        HTTPException with the original error text.
    """
    client = get_gemini_client()
    model_name = (model or _GEMINI_MODEL_NAME or "gemini-2.5-flash").strip()

    # Build the request using the google-genai SDK. The call is synchronous
    # inside the SDK, so we execute it in a thread pool so the FastAPI event
    # loop is not blocked.
    import asyncio
    try:
        from google.genai import types as genai_types  # type: ignore
    except Exception as e:  # pragma: no cover - defensive
        logger.exception("google-genai types import failed")
        raise HTTPException(status_code=500, detail=f"google-genai import error: {e}") from e

    try:
        image_bytes = _b64_to_bytes(image_b64)
    except Exception as e:
        logger.exception("Bad base64 image payload")
        raise HTTPException(status_code=500, detail=f"Invalid image payload: {e}") from e

    def _call_gemini():
        contents = [
            genai_types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
            prompt,
        ]
        # response_mime_type forces the model into strict JSON output.
        cfg = genai_types.GenerateContentConfig(
            temperature=0,
            max_output_tokens=2048,
            response_mime_type="application/json",
        )
        return client.models.generate_content(
            model=model_name,
            contents=contents,
            config=cfg,
        )

    try:
        response = await asyncio.to_thread(_call_gemini)
    except HTTPException:
        raise
    except Exception as e:
        # Never crash the server — surface as HTTP 500 with the original text.
        logger.exception("Gemini generate_content failed")
        err_text = str(e)
        if "PERMISSION_DENIED" in err_text or "403" in err_text:
            # This specific message ("Your project has been denied access.
            # Please contact support.") comes straight from Google's Gemini
            # API servers rejecting the whole GCP project behind the API
            # key — it is not something this app's code can fix. It has been
            # showing up widely across unrelated Gemini projects/accounts
            # (see https://discuss.ai.google.dev, search "project has been
            # denied access"), including brand-new keys with no usage
            # history, so it isn't necessarily specific to this project's
            # configuration either. The full Google error is still logged
            # above for support/debugging.
            raise HTTPException(
                status_code=503,
                detail=(
                    "Gemini is rejecting every request from this API key's Google Cloud "
                    "project (\"Your project has been denied access. Please contact "
                    "support.\"). This is a block on Google's side, not a bug in "
                    "Taskosphere — generate a fresh API key in a different Google Cloud "
                    "project at aistudio.google.com/apikey, confirm billing is attached, "
                    "and if it persists, report it on the Google AI developer forum "
                    "(discuss.ai.google.dev) as this has been affecting many unrelated "
                    "projects recently."
                ),
            ) from e
        raise HTTPException(status_code=500, detail=f"Gemini API error: {e}") from e

    raw_text = getattr(response, "text", None)
    if not raw_text:
        # Fallback: dig into candidates if .text is empty
        try:
            parts = response.candidates[0].content.parts  # type: ignore[attr-defined]
            raw_text = "".join(getattr(p, "text", "") for p in parts)
        except Exception:
            raw_text = ""

    if not raw_text:
        logger.error("Gemini returned an empty response")
        raise HTTPException(status_code=500, detail="Gemini returned an empty response.")

    try:
        return json.loads(_strip_json_fence(raw_text))
    except json.JSONDecodeError as e:
        logger.error("Gemini returned non-JSON: %s", raw_text[:400])
        raise HTTPException(
            status_code=500,
            detail=f"Gemini did not return valid JSON: {e}. Raw: {raw_text[:300]}",
        ) from e


def _b64_to_bytes(image_b64: str) -> bytes:
    import base64
    return base64.b64decode(image_b64)


async def gemini_text_json(prompt: str, *, model: Optional[str] = None, max_output_tokens: int = 1024) -> dict:
    """Text-only Gemini call in strict-JSON mode (same client, model and error handling as above)."""
    client = get_gemini_client()
    model_name = (model or _GEMINI_MODEL_NAME or "gemini-2.5-flash").strip()
    import asyncio
    from google.genai import types as genai_types  # type: ignore

    def _call():
        cfg = genai_types.GenerateContentConfig(temperature=0, max_output_tokens=max_output_tokens,
                                                response_mime_type="application/json")
        return client.models.generate_content(model=model_name, contents=[prompt], config=cfg)

    try:
        response = await asyncio.to_thread(_call)
    except Exception as e:
        logger.exception("Gemini text call failed")
        raise HTTPException(status_code=503, detail=f"Gemini API error: {e}") from e
    raw_text = getattr(response, "text", None) or ""
    try:
        return json.loads(_strip_json_fence(raw_text))
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=502, detail="Gemini did not return valid JSON.") from e
