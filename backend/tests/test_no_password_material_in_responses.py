"""User responses must never carry password material (hash or salt)."""
import re
import subprocess
from pathlib import Path

import backend.server  # noqa: F401
from backend.models import User


def test_user_model_never_serialises_the_password():
    user = User(id="u1", email="u@example.com", password="$2b$12$secret")
    assert "password" not in user.model_dump()
    assert '"password":' not in user.model_dump_json()
    assert user.password == "$2b$12$secret"  # still readable in code


def test_projections_that_hide_password_also_hide_hash_and_salt():
    backend = Path(__file__).resolve().parents[1]
    offenders = []
    for path in backend.rglob("*.py"):
        if "tests" in path.parts:
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r'"password": 0(?!, "password_hash": 0, "password_salt": 0)', line):
                offenders.append(f"{path.relative_to(backend)}:{number}")
    assert not offenders, offenders
