"""Owner / licensee / Commercial Console company-context isolation."""
import asyncio
from types import SimpleNamespace

import pytest


def _match(q, d):
    if not q:
        return True
    if "$and" in q and not all(_match(i, d) for i in q["$and"]):
        return False
    if "$or" in q and not any(_match(i, d) for i in q["$or"]):
        return False
    for k, v in q.items():
        if k in ("$and", "$or"):
            continue
        a = d.get(k)
        if isinstance(v, dict):
            if "$in" in v and a not in v["$in"]:
                return False
            if "$nin" in v and a in v["$nin"]:
                return False
        elif a != v:
            return False
    return True


class Cur:
    def __init__(self, rows): self.rows = rows
    def sort(self, f, d=1): self.rows.sort(key=lambda r: str(r.get(f) or "")); return self
    async def to_list(self, n=None): return [dict(r) for r in self.rows]


class Col:
    def __init__(self, rows): self.rows = rows
    def find(self, q=None, proj=None): return Cur([r for r in self.rows if _match(q or {}, r)])
    async def find_one(self, q=None, proj=None):
        return next((dict(r) for r in self.rows if _match(q or {}, r)), None)
    async def update_one(self, q, u):
        for r in self.rows:
            if _match(q, r):
                r.update(u.get("$set", {})); return


class DB:
    def __init__(self, companies, users, licenses):
        self.companies, self.users, self.commercial_licenses = Col(companies), Col(users), Col(licenses)


OWNER = SimpleNamespace(id="owner-1", email="info.taskosphere@gmail.com", role="admin",
                        company_id=None, commercial_customer_id=None, license_id=None)
LIC_ADMIN = SimpleNamespace(id="u-admin", email="manthan.mda@gmail.com", role="admin",
                            company_id="cust-1", commercial_customer_id="cust-1", license_id="lic-1")
LIC_USER = SimpleNamespace(id="u-mgr", email="info.msadvisory@gmail.com", role="manager",
                           company_id="cust-1", commercial_customer_id="cust-1", license_id="lic-1")


@pytest.fixture
def q(monkeypatch):
    from backend import quotations
    companies = [
        {"id": "own-a", "name": "Owner Firm A", "created_by": "owner-1"},
        {"id": "own-b", "name": "Owner Firm B", "created_by": "owner-1", "commercial_customer_id": ""},
        # license-generated record (legacy: company id == customer id)
        {"id": "cust-1", "name": "Manthan Desai", "source": "commercial-license",
         "commercial_customer_id": "cust-1", "license_id": "lic-1"},
        # legacy companies created by the licensee's admin, NO markers
        {"id": "legacy-1", "name": "Manthan Desai And Associates", "created_by": "u-admin"},
        {"id": "legacy-2", "name": "Manthan Desai And Associates 2", "created_by": "u-admin"},
        # another tenant
        {"id": "cust-2", "name": "Other Licensee", "source": "commercial-license",
         "commercial_customer_id": "cust-2", "license_id": "lic-2"},
    ]
    users = [
        {"id": "u-admin", "commercial_customer_id": "cust-1"},
        {"id": "u-mgr", "commercial_customer_id": "cust-1"},
        {"id": "u-other", "commercial_customer_id": "cust-2"},
        {"id": "owner-1"},
    ]
    licenses = [{"id": "lic-1", "customer_id": "cust-1"}, {"id": "lic-2", "customer_id": "cust-2"}]
    fake = DB(companies, users, licenses)
    monkeypatch.setattr(quotations, "_tenant_raw_db", lambda: fake)
    monkeypatch.setattr(quotations, "is_platform_owner", lambda u: u.id == "owner-1")

    async def _bank(c): return c
    monkeypatch.setattr(quotations, "_hydrate_company_bank", _bank)
    return quotations


def names(rows): return sorted(r["id"] for r in rows)


def test_platform_owner_sees_only_own_companies(q):
    rows = asyncio.run(q.get_companies(OWNER))
    assert names(rows) == ["own-a", "own-b"]


def test_owner_dropdown_never_exposes_licensee_companies(q):
    rows = asyncio.run(q.list_companies(OWNER))
    assert names(rows) == ["own-a", "own-b"]


def test_licensee_admin_sees_own_tenant_incl_legacy_unmarked(q):
    rows = asyncio.run(q.get_companies(LIC_ADMIN))
    assert names(rows) == ["cust-1", "legacy-1", "legacy-2"]
    assert "cust-2" not in names(rows) and "own-a" not in names(rows)


def test_licensee_user_sees_only_attached_company(q):
    rows = asyncio.run(q.get_companies(LIC_USER))
    assert names(rows) == ["cust-1"]


def test_legacy_records_are_stamped_and_then_hidden_from_owner(q):
    asyncio.run(q.get_companies(LIC_ADMIN))          # heals markers
    rows = asyncio.run(q.get_companies(OWNER))
    assert names(rows) == ["own-a", "own-b"]


def test_owner_cannot_open_licensee_company_by_id(q):
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as e:
        asyncio.run(q.get_company("cust-1", OWNER))
    assert e.value.status_code == 404


def test_licensee_cannot_open_other_tenant_company(q):
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        asyncio.run(q.get_company("cust-2", LIC_ADMIN))
    assert asyncio.run(q.get_company("cust-1", LIC_ADMIN))["id"] == "cust-1"


def test_owner_marker_companies_stay_visible_to_owner(q):
    q._tenant_raw_db().companies.rows.append(
        {"id": "own-c", "name": "Owner Practice", "created_by": "owner-1",
         "commercial_customer_id": "platform-owner", "license_id": "platform-owner-license"}
    )
    assert "own-c" in names(asyncio.run(q.get_companies(OWNER)))
    assert "own-c" not in names(asyncio.run(q.get_companies(LIC_ADMIN)))


# ---- one test per row of the agreed visibility matrix -------------------

def test_matrix_licensee_user_sees_only_attached_company_even_if_creator(q):
    q._tenant_raw_db().companies.rows.append(
        {"id": "mgr-made", "name": "Made by manager", "created_by": "u-mgr",
         "commercial_customer_id": "cust-1"}
    )
    assert names(asyncio.run(q.get_companies(LIC_USER))) == ["cust-1"]
    assert names(asyncio.run(q.list_companies(LIC_USER))) == ["cust-1"]


def test_matrix_admin_includes_auto_generated_license_company(q):
    assert "cust-1" in names(asyncio.run(q.get_companies(LIC_ADMIN)))


def test_matrix_licensee_blocked_from_other_licensee_and_owner_companies(q):
    from fastapi import HTTPException
    for cid in ("cust-2", "own-a", "own-b"):
        for user in (LIC_ADMIN, LIC_USER):
            with pytest.raises(HTTPException):
                asyncio.run(q.get_company(cid, user))
    listed = names(asyncio.run(q.get_companies(LIC_ADMIN)))
    assert not ({"cust-2", "own-a", "own-b"} & set(listed))


def test_matrix_licensee_cannot_edit_or_delete_foreign_company(q):
    from fastapi import HTTPException
    for cid in ("cust-2", "own-a"):
        with pytest.raises(HTTPException):
            asyncio.run(q.update_company(cid, {"name": "x"}, LIC_ADMIN))
        with pytest.raises(HTTPException):
            asyncio.run(q.delete_company(cid, LIC_ADMIN))


def test_matrix_owner_cannot_edit_or_delete_licensee_company_from_operational_api(q):
    from fastapi import HTTPException
    for cid in ("cust-1", "cust-2"):
        with pytest.raises(HTTPException):
            asyncio.run(q.update_company(cid, {"name": "x"}, OWNER))
        with pytest.raises(HTTPException):
            asyncio.run(q.delete_company(cid, OWNER))


def test_matrix_user_without_tenant_link_fails_closed(q):
    stray = SimpleNamespace(id="stray", email="x@y.z", role="manager",
                            company_id="", commercial_customer_id="", license_id="")
    assert names(asyncio.run(q.get_companies(stray))) == []


def test_matrix_commercial_console_directory_still_reaches_licensee_companies():
    from backend.commercial_company_master import _is_licensee_company
    assert _is_licensee_company({"id": "cust-1", "source": "commercial-license",
                                 "commercial_customer_id": "cust-1"})


def test_owner_created_company_visible_even_if_owner_login_is_stamped(q):
    """Owner's own login record may carry customer/licence stamps; companies the
    owner created must still show in the owner's Master Data."""
    db = q._tenant_raw_db()
    for u in db.users.rows:
        if u["id"] == "owner-1":
            u["commercial_customer_id"] = "cust-x"
            u["email"] = "info.taskosphere@gmail.com"
    db.companies.rows.append({"id": "own-new", "name": "Just Added", "created_by": "owner-1"})
    rows = names(asyncio.run(q.get_companies(OWNER)))
    assert "own-new" in rows and "own-a" in rows
    assert "cust-1" not in rows and "legacy-1" not in rows and "cust-2" not in rows


def test_owner_created_company_appears_in_dropdown_list_too(q):
    db = q._tenant_raw_db()
    db.companies.rows.append({"id": "own-new", "name": "Just Added", "created_by": "owner-1"})
    assert "own-new" in names(asyncio.run(q.list_companies(OWNER)))


def test_platform_owner_auth_uses_unique_canonical_workspace(monkeypatch):
    """Legacy owner company_id must not override the marked Master Data workspace."""
    from backend import dependencies as deps

    class Cursor:
        def __init__(self, rows): self.rows = rows
        def limit(self, n): self.rows = self.rows[:n]; return self
        async def to_list(self, n=None): return self.rows[:n] if n is not None else self.rows

    class Companies:
        def find(self, query, projection=None):
            rows = [
                {"id": "owner-workspace", "name": "Prodigist Ventures P Ltd",
                 "is_platform_owner_workspace": True, "status": "active"},
                {"id": "legacy-practice", "name": "Manthan Desai And Associates",
                 "status": "active"},
            ]
            return Cursor([r for r in rows if all(r.get(k) == v for k, v in query.items())])

    class FakeDB:
        companies = Companies()

    class FakeUser:
        def __init__(self, company_id):
            self.company_id = company_id
        def model_dump(self):
            return {"id": "owner-1", "role": "admin", "company_id": self.company_id}
        @classmethod
        def model_validate(cls, data):
            return cls(data.get("company_id"))

    fake_db = FakeDB()
    async def owner_companies(_user):
        return [
            {"id": "owner-workspace", "name": "Prodigist Ventures P Ltd",
             "is_platform_owner_workspace": True, "status": "active"},
            {"id": "legacy-practice", "name": "Manthan Desai And Associates", "status": "active"},
        ]
    monkeypatch.setattr(deps, "_owner_operational_companies", owner_companies)
    monkeypatch.setattr(deps, "is_platform_owner", lambda user: True)
    monkeypatch.setattr(deps, "db", fake_db)
    monkeypatch.setattr(deps, "_raw_db", fake_db, raising=False)
    monkeypatch.setattr(deps, "User", FakeUser)

    resolved = asyncio.run(deps._canonicalize_platform_owner_company(FakeUser("legacy-practice")))
    assert resolved.company_id == "owner-workspace"


def test_platform_owner_auth_does_not_guess_between_duplicate_workspaces(monkeypatch):
    """Duplicate canonical markers fail closed instead of selecting an arbitrary company."""
    from backend import dependencies as deps

    class Cursor:
        def __init__(self, rows): self.rows = rows
        def limit(self, n): self.rows = self.rows[:n]; return self
        async def to_list(self, n=None): return self.rows[:n] if n is not None else self.rows

    class Companies:
        def find(self, query, projection=None):
            return Cursor([
                {"id": "owner-a", "is_platform_owner_workspace": True, "status": "active"},
                {"id": "owner-b", "is_platform_owner_workspace": True, "status": "active"},
            ])

    class FakeDB:
        companies = Companies()

    class FakeUser:
        def __init__(self, company_id): self.company_id = company_id
        def model_dump(self): return {"id": "owner-1", "role": "admin", "company_id": self.company_id}
        @classmethod
        def model_validate(cls, data): return cls(data.get("company_id"))

    fake_db = FakeDB()
    async def owner_companies(_user):
        return [
            {"id": "owner-a", "is_platform_owner_workspace": True, "status": "active"},
            {"id": "owner-b", "is_platform_owner_workspace": True, "status": "active"},
        ]
    monkeypatch.setattr(deps, "_owner_operational_companies", owner_companies)
    monkeypatch.setattr(deps, "is_platform_owner", lambda user: True)
    monkeypatch.setattr(deps, "db", fake_db)
    monkeypatch.setattr(deps, "_raw_db", fake_db, raising=False)
    monkeypatch.setattr(deps, "User", FakeUser)

    resolved = asyncio.run(deps._canonicalize_platform_owner_company(FakeUser("legacy-practice")))
    assert resolved.company_id == "legacy-practice"


def test_platform_owner_guard_allows_only_server_resolved_owner_companies():
    from backend import tenant_runtime as tr
    from fastapi import HTTPException

    company_token = tr.set_authenticated_company("owner-a")
    owner_token = tr.set_platform_owner(True)
    allowed_token = tr.set_platform_owner_company_ids({"owner-a", "owner-b"})
    try:
        assert tr._scope_query({"company_id": "owner-b"}) == {"company_id": "owner-b"}
        assert tr._scope_query({"company_id": {"$in": ["owner-a", "owner-b"]}}) == {
            "company_id": {"$in": ["owner-a", "owner-b"]}
        }
        with pytest.raises(HTTPException) as exc:
            tr._scope_query({"company_id": "licensee-company"})
        assert exc.value.status_code == 403
        with pytest.raises(HTTPException):
            tr._scope_query({"company_id": {"$in": ["owner-a", "licensee-company"]}})
    finally:
        tr.reset_platform_owner_company_ids(allowed_token)
        tr.reset_platform_owner(owner_token)
        tr.reset_authenticated_company(company_token)


def test_platform_owner_updates_keep_the_selected_owned_company():
    from backend import tenant_runtime as tr

    company_token = tr.set_authenticated_company("owner-a")
    owner_token = tr.set_platform_owner(True)
    allowed_token = tr.set_platform_owner_company_ids({"owner-a", "owner-b"})
    try:
        scoped_query = tr._scope_query({"company_id": "owner-b"})
        update = tr._scope_update({"$set": {"memo": "updated"}}, scoped_query)
        assert update == {"$set": {"memo": "updated"}}
        replacement = tr._scope_replacement({"memo": "replacement"}, scoped_query)
        assert replacement["company_id"] == "owner-b"

        # Ownership of both companies does not permit silently moving an
        # existing operational record between company ledgers.
        from fastapi import HTTPException
        with pytest.raises(HTTPException):
            tr._scope_update({"$set": {"company_id": "owner-a"}}, scoped_query)
        with pytest.raises(HTTPException):
            tr._scope_replacement({"company_id": "owner-a"}, scoped_query)
    finally:
        tr.reset_platform_owner_company_ids(allowed_token)
        tr.reset_platform_owner(owner_token)
        tr.reset_authenticated_company(company_token)


def test_platform_owner_legacy_id_alias_maps_to_canonical_owner_company_only():
    from backend import tenant_runtime as tr
    from fastapi import HTTPException

    company_token = tr.set_authenticated_company("owner-a")
    owner_token = tr.set_platform_owner(True)
    allowed_token = tr.set_platform_owner_company_ids({"owner-a", "owner-b"})
    alias_token = tr.set_platform_owner_company_aliases({"verified-old-owner-id": "owner-b"})
    try:
        assert tr._scope_query({"company_id": "verified-old-owner-id"}) == {
            "company_id": "owner-b"
        }
        assert tr._scope_query({
            "company_id": {"$in": ["owner-a", "verified-old-owner-id"]}
        }) == {"company_id": {"$in": ["owner-a", "owner-b"]}}
        with pytest.raises(HTTPException) as exc:
            tr._scope_query({"company_id": "licensee-company"})
        assert exc.value.status_code == 403
    finally:
        tr.reset_platform_owner_company_aliases(alias_token)
        tr.reset_platform_owner_company_ids(allowed_token)
        tr.reset_platform_owner(owner_token)
        tr.reset_authenticated_company(company_token)


def test_configured_legacy_owner_company_id_normalizes_only_with_resolved_allow_list(monkeypatch):
    from backend import tenant_runtime as tr

    monkeypatch.setenv("PLATFORM_OWNER_WORKSPACE_ID", "owner-b")
    monkeypatch.setenv("PLATFORM_OWNER_LEGACY_COMPANY_IDS", "old-owner-id")
    company_token = tr.set_authenticated_company("owner-a")
    owner_token = tr.set_platform_owner(True)
    allowed_token = tr.set_platform_owner_company_ids({"owner-a", "owner-b"})
    alias_token = tr.set_platform_owner_company_aliases({"old-owner-id": "owner-b"})
    try:
        assert tr._scope_query({"company_id": "old-owner-id"}) == {"company_id": "owner-b"}
        with pytest.raises(Exception):
            tr._scope_query({"company_id": "unconfigured-unknown-id"})
    finally:
        tr.reset_platform_owner_company_aliases(alias_token)
        tr.reset_platform_owner_company_ids(allowed_token)
        tr.reset_platform_owner(owner_token)
        tr.reset_authenticated_company(company_token)


def test_configured_legacy_owner_alias_fails_closed_without_resolved_allow_list(monkeypatch):
    from backend import tenant_runtime as tr
    from fastapi import HTTPException

    monkeypatch.setenv("PLATFORM_OWNER_WORKSPACE_ID", "owner-b")
    monkeypatch.setenv("PLATFORM_OWNER_LEGACY_COMPANY_IDS", "old-owner-id")
    company_token = tr.set_authenticated_company("platform-owner-synthetic")
    owner_token = tr.set_platform_owner(True)
    allowed_token = tr.set_platform_owner_company_ids(set())
    alias_token = tr.set_platform_owner_company_aliases({})
    try:
        with pytest.raises(HTTPException) as exc:
            tr._scope_query({"company_id": "old-owner-id"})
        assert exc.value.status_code == 403
    finally:
        tr.reset_platform_owner_company_aliases(alias_token)
        tr.reset_platform_owner_company_ids(allowed_token)
        tr.reset_platform_owner(owner_token)
        tr.reset_authenticated_company(company_token)


def test_configured_owner_workspace_recovers_when_creator_id_differs_from_session_user(monkeypatch):
    """A legacy owner session may differ from the verified account that created its workspace."""
    from backend import dependencies as deps
    from backend import tenant_runtime as tr

    workspace_id = "74e30915-e7a8-47ec-a596-53361094bc19"
    stale_id = "b03f8228-679b-422a-9d18-0e21ad66c41b"
    creator_id = "e8defc06-cdc0-40c6-af36-edd88b8a9a89"
    monkeypatch.setenv("PLATFORM_OWNER_WORKSPACE_ID", workspace_id)
    monkeypatch.setenv("PLATFORM_OWNER_WORKSPACE_NAME", "Prodigist Ventures Private Limited")
    monkeypatch.setenv("PLATFORM_OWNER_LEGACY_COMPANY_IDS", stale_id)

    owner_company = {
        "id": workspace_id,
        "name": "Prodigist Ventures Private Limited",
        "created_by": creator_id,
        "is_platform_owner_workspace": True,
        "status": "active",
    }
    creator_doc = {
        "id": creator_id,
        "email": "csmanthandesai@gmail.com",
        "role": "admin",
        "status": "active",
    }
    current_user = {
        "id": "platform-owner-48fe785fdd75127f",
        "email": "info.taskosphere@gmail.com",
        "role": "admin",
        "company_id": "platform-owner-48fe785fdd75127f",
    }

    def matches(query, doc):
        if not query:
            return True
        if "$or" in query and not any(matches(q, doc) for q in query["$or"]):
            return False
        if "$and" in query and not all(matches(q, doc) for q in query["$and"]):
            return False
        for key, expected in query.items():
            if key in {"$or", "$and"}:
                continue
            actual = doc.get(key)
            if isinstance(expected, dict):
                if "$nin" in expected and actual in expected["$nin"]:
                    return False
                if "$in" in expected and actual not in expected["$in"]:
                    return False
            elif actual != expected:
                return False
        return True

    class Cursor:
        def __init__(self, rows):
            self.rows = rows
        def sort(self, *_args, **_kwargs):
            return self
        def limit(self, n):
            self.rows = self.rows[:n]
            return self
        async def to_list(self, n=None):
            return self.rows[:n] if n is not None else self.rows

    class Collection:
        def __init__(self, rows):
            self.rows = rows
        def find(self, query=None, projection=None):
            return Cursor([dict(row) for row in self.rows if matches(query or {}, row)])
        async def find_one(self, query=None, projection=None, **_kwargs):
            return next((dict(row) for row in self.rows if matches(query or {}, row)), None)
        async def update_one(self, query, update, **_kwargs):
            for row in self.rows:
                if matches(query, row):
                    row.update(update.get("$set", {}))
                    for key in update.get("$unset", {}):
                        row.pop(key, None)
                    return
        async def update_many(self, query, update, **_kwargs):
            for row in self.rows:
                if matches(query, row):
                    row.update(update.get("$set", {}))
                    for key in update.get("$unset", {}):
                        row.pop(key, None)

    fake_db = type("FakeDB", (), {})()
    fake_db.companies = Collection([owner_company])
    fake_db.users = Collection([creator_doc])
    fake_db.commercial_licenses = Collection([])

    class FakeUser:
        def __init__(self, data):
            self.id = data.get("id")
            self.email = data.get("email")
            self.role = data.get("role")
            self.company_id = data.get("company_id")
            self.company_name = data.get("company_name")
        def model_dump(self):
            return {
                "id": self.id, "email": self.email, "role": self.role,
                "company_id": self.company_id, "company_name": self.company_name,
            }
        @classmethod
        def model_validate(cls, data):
            return cls(data)

    user = FakeUser(current_user)
    async def no_visible_companies(_user):
        # Reproduce the live failure: the regular selector filtered every row.
        return []

    def is_owner(value):
        email = value.get("email", "") if isinstance(value, dict) else getattr(value, "email", "")
        return email in {"info.taskosphere@gmail.com", "csmanthandesai@gmail.com"}

    monkeypatch.setattr(deps, "_owner_operational_companies", no_visible_companies)
    monkeypatch.setattr(deps, "is_platform_owner", is_owner)
    monkeypatch.setattr(deps, "_raw_db", fake_db, raising=False)
    monkeypatch.setattr(deps, "db", fake_db)
    monkeypatch.setattr(deps, "User", FakeUser)

    async def scenario():
        resolved = await deps._canonicalize_platform_owner_company(user)
        assert resolved.company_id == workspace_id
        assert workspace_id in tr.platform_owner_company_ids()
        assert tr.platform_owner_company_aliases()[stale_id] == workspace_id
        normalized = tr._scope_query({"company_id": stale_id})
        assert normalized == {"company_id": workspace_id}

    asyncio.run(scenario())
