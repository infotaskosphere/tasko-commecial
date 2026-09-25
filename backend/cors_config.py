"""CORS configuration and middleware for the Taskosphere FastAPI application.

Extracted verbatim from server.py to keep the existing allowed origins,
preview deployment regex and credential handling unchanged.
"""

import os
from fastapi.middleware.cors import CORSMiddleware

# ====================== CORS CONFIG ======================
# Supports:
# - Taskosphere production domains
# - Vercel production and preview deployments
# - Render deployments
# - localhost development
# - Additional domains through CORS_ALLOWED_ORIGINS
#
# IMPORTANT:
# Do NOT use allow_origins=["*"] because credentials are enabled.

CORS_ALLOWED_ORIGINS = [
    # Taskosphere production
    "https://taskosphere.com",
    "https://www.taskosphere.com",

    # Vercel production frontend
    "https://tasko-commercial-frontend.vercel.app",

    # Render frontend / legacy frontend
    "https://final-taskosphere-frontend.onrender.com",

    # Local development
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
]


# --------------------------------------------------------
# Additional origins can be supplied through environment
# variable without modifying this file.
#
# Example:
# CORS_ALLOWED_ORIGINS=https://example.com,https://www.example.com
# --------------------------------------------------------

_extra_cors_origins = os.getenv("CORS_ALLOWED_ORIGINS", "")

if _extra_cors_origins:
    for origin in _extra_cors_origins.split(","):
        origin = origin.strip().rstrip("/")

        if origin and origin not in CORS_ALLOWED_ORIGINS:
            CORS_ALLOWED_ORIGINS.append(origin)


# --------------------------------------------------------
# Deployment / preview URL support
#
# Vercel:
# https://anything.vercel.app
#
# Render:
# https://anything.onrender.com
#
# Local:
# http://localhost:3000
# http://127.0.0.1:5173
# --------------------------------------------------------

CORS_ORIGIN_REGEX = (
    r"^https://[a-zA-Z0-9-]+\.vercel\.app$"
    r"|^https://[a-zA-Z0-9-]+\.onrender\.com$"
    r"|^http://localhost(?::[0-9]+)?$"
    r"|^http://127\.0\.0\.1(?::[0-9]+)?$"
)



def configure_cors(app):
    """Attach the existing CORS middleware with unchanged settings."""
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ALLOWED_ORIGINS,
        allow_origin_regex=CORS_ORIGIN_REGEX,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["*"],
        max_age=3600,
    )
