"""Only the login route may mint user JWTs: it binds each to a session (sid),
so logout and revocation can end it. Endpoints that create another user's
account used to hand the creator a session-less token for that account."""
import re
from pathlib import Path

ALLOWED = {
    "dependencies.py",                       # the definition
    "server_modules/routes/auth_routes.py",  # login (token carries sid)
    "platform_owner_sessions.py",            # SaaS login tuple; login discards it
}


def test_create_access_token_is_only_used_by_login():
    backend = Path(__file__).resolve().parents[1]
    users = sorted(
        str(p.relative_to(backend)) for p in backend.rglob("*.py")
        if "tests" not in p.parts and re.search(r"create_access_token\(", p.read_text(encoding="utf-8"))
    )
    assert set(users) <= ALLOWED, users
