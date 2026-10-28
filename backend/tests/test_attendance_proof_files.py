"""Attendance proof files: stored via file_store (not the wiped server disk) and
served only to people allowed to see that attendance."""
import asyncio
import io

import pytest
from fastapi import HTTPException
from starlette.datastructures import Headers, UploadFile

import backend.server  # noqa: F401
from backend import file_store
from backend.models import User
from backend.server_modules.routes import attendance_routes as ar


@pytest.fixture
def env(monkeypatch, tmp_path):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["proof_test"]
    monkeypatch.setattr(ar, "db", raw)
    monkeypatch.setattr(file_store, "_raw_database", lambda: raw)  # no GridFS -> dev store
    monkeypatch.setattr(file_store, "_DEV_DIR", tmp_path / "store")
    monkeypatch.setattr(ar, "PROOF_UPLOAD_DIR", tmp_path / "legacy")
    (tmp_path / "legacy").mkdir()

    async def team(_uid):
        return ["emp1"]

    monkeypatch.setattr(ar, "get_team_user_ids", team)
    return raw, tmp_path


def _user(uid, role="staff", **perms):
    return User(id=uid, email=f"{uid}@example.com", role=role, full_name=uid, company_id="c1", permissions=perms)


def _upload(name, data, ctype):
    return UploadFile(io.BytesIO(data), filename=name, headers=Headers({"content-type": ctype}))


def _body(resp):
    async def read():
        return b"".join([chunk async for chunk in resp.body_iterator])
    return asyncio.run(read())


def test_upload_goes_to_file_store_not_upload_dir(env):
    raw, tmp = env
    emp = _user("emp1")
    out = asyncio.run(ar.upload_attendance_proof(
        note="Client visit", photos=[_upload("site.jpg", b"\xff\xd8jpeg", "image/jpeg")],
        documents=[_upload("memo.pdf", b"%PDF-1", "application/pdf")], current_user=emp,
    ))
    assert out["photos_saved"] == 1 and out["documents_saved"] == 1
    assert list((tmp / "legacy").iterdir()) == []
    rec = asyncio.run(raw.attendance.find_one({"user_id": "emp1"}))
    photo = rec["proof"]["photos"][0]

    resp = asyncio.run(ar.download_attendance_proof(photo, current_user=emp))
    assert _body(resp) == b"\xff\xd8jpeg"
    assert resp.media_type == "image/jpeg"
    assert 'inline; filename="site.jpg"' in resp.headers["content-disposition"]

    doc = rec["proof"]["documents"][0]
    assert _body(asyncio.run(ar.download_attendance_proof(doc, current_user=_user("boss", role="admin")))) == b"%PDF-1"


def test_access_rules(env):
    raw, _ = env
    asyncio.run(ar.upload_attendance_proof(note="", photos=[_upload("a.png", b"png", "image/png")], documents=[], current_user=_user("emp1")))
    name = asyncio.run(raw.attendance.find_one({"user_id": "emp1"}))["proof"]["photos"][0]

    for viewer in (_user("emp2"), _user("mgr", role="manager")):  # colleague; manager without permission
        with pytest.raises(HTTPException) as exc:
            asyncio.run(ar.download_attendance_proof(name, current_user=viewer))
        assert exc.value.status_code == 404
    mgr = _user("mgr", role="manager", can_view_attendance=True)
    assert _body(asyncio.run(ar.download_attendance_proof(name, current_user=mgr))) == b"png"
    for bad in ("../secret", ".env", "x\\y"):
        with pytest.raises(HTTPException):
            asyncio.run(ar.download_attendance_proof(bad, current_user=_user("boss", role="admin")))


def test_legacy_disk_file_still_served_and_svg_not_inline(env):
    raw, tmp = env
    (tmp / "legacy" / "emp1_2026-01-01_doc_abcdef12_old.svg").write_bytes(b"<svg/>")
    asyncio.run(raw.attendance.insert_one({"user_id": "emp1", "date": "2026-01-01", "proof": {"documents": ["emp1_2026-01-01_doc_abcdef12_old.svg"]}}))
    resp = asyncio.run(ar.download_attendance_proof("emp1_2026-01-01_doc_abcdef12_old.svg", current_user=_user("emp1")))
    assert _body(resp) == b"<svg/>"
    assert resp.headers["content-disposition"].startswith("attachment;")
