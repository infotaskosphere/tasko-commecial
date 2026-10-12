"""Guards against NameError 500s in the license-issuing path."""


def test_licensee_admin_module_imports_os():
    import backend.commercial_licensee_admin as m
    assert hasattr(m, "os")  # os.getenv("DEFAULT_TENANT_ADMIN_PASSWORD") is used


def test_licensing_api_defines_logger_for_email_failure_handler():
    import backend.licensing_api as m
    assert hasattr(m, "logger")
    m.logger.warning("logger is usable")


def test_trial_license_is_valid_until_expiry():
    from datetime import datetime, timedelta, timezone
    from backend.licensing_api import _expiry_reason

    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    expired = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    assert _expiry_reason({"status": "trial", "expires_at": future}) is None
    assert _expiry_reason({"status": "trial", "expires_at": expired}) == "License expired"
    assert _expiry_reason({"status": "suspended"}) == "License is suspended"


def test_stale_deleted_licensee_email_link_can_be_released():
    import asyncio
    from backend.identity_hierarchy import release_stale_licensee_email_link

    class Result:
        def __init__(self, deleted_count=0):
            self.deleted_count = deleted_count

    def matches(document, query):
        for key, wanted in query.items():
            if key == "$or":
                if not any(matches(document, branch) for branch in wanted):
                    return False
                continue
            actual = document.get(key)
            if isinstance(wanted, dict):
                for op, value in wanted.items():
                    if op == "$ne" and actual == value:
                        return False
                    if op == "$ne" and actual is None and value is not None:
                        continue
                    if op == "$in" and actual not in value:
                        return False
                    if op == "$regex":
                        import re
                        flags = re.IGNORECASE if wanted.get("$options") == "i" else 0
                        if not re.search(value, str(actual or ""), flags):
                            return False
            elif actual != wanted:
                return False
        return True

    class Collection:
        def __init__(self, rows=None):
            self.rows = list(rows or [])

        async def find_one(self, query=None, *args, **kwargs):
            return next((row.copy() for row in self.rows if matches(row, query or {})), None)

        async def delete_one(self, query):
            for index, row in enumerate(self.rows):
                if matches(row, query):
                    del self.rows[index]
                    return Result(1)
            return Result(0)

    class DB:
        def __init__(self):
            self.identity_email_links = Collection([{
                "email_normalized": "admin@old-company.example",
                "identity_uid": "L-000007",
                "identity_type": "licensee",
            }])
            self.commercial_license_customers = Collection([])
            self.commercial_licenses = Collection([])
            self.users = Collection([{
                "id": "old-admin",
                "identity_org_uid": "L-000007",
                "status": "deleted",
            }])

        def __getitem__(self, name):
            return getattr(self, name)

    db = DB()
    link = db.identity_email_links.rows[0].copy()
    released = asyncio.run(
        release_stale_licensee_email_link(db, "admin@old-company.example", link)
    )
    assert released is True
    assert db.identity_email_links.rows == []


def test_license_generation_requires_invoice_company_before_creating_records():
    import asyncio
    from types import SimpleNamespace
    from fastapi import HTTPException
    from backend.commercial_onboarding_extensions import generate_custom_license
    import backend.commercial_onboarding as onboarding

    # A missing invoice issuer is rejected before license/customer creation.
    original_create = onboarding.create_license_record
    async def fail_if_called(*args, **kwargs):
        raise AssertionError("license records must not be created before invoice preflight")
    onboarding.create_license_record = fail_if_called

    try:
        asyncio.run(generate_custom_license(
            {"company_name": "Example Co", "admin_name": "Example Admin", "validity_months": 12},
            SimpleNamespace(id="platform-owner"),
        ))
    except HTTPException as exc:
        assert exc.status_code == 400
        assert "invoice company" in str(exc.detail).lower() or "company master company" in str(exc.detail).lower()
    else:
        raise AssertionError("Issuance must stop before creating records when invoice company is missing")
    finally:
        onboarding.create_license_record = original_create



def test_deleted_user_email_can_be_reused_while_old_licensee_still_exists():
    import asyncio
    from backend.identity_hierarchy import release_stale_licensee_email_link

    class Collection:
        def __init__(self, rows=None):
            self.rows = list(rows or [])

        async def find_one(self, query=None, *args, **kwargs):
            return next((row.copy() for row in self.rows if matches(row, query or {})), None)

        async def delete_one(self, query):
            return type("Result", (), {"deleted_count": 1})()

    def matches(document, query):
        for key, wanted in query.items():
            if key == "$or":
                if not any(matches(document, branch) for branch in wanted):
                    return False
                continue
            if key == "$and":
                if not all(matches(document, branch) for branch in wanted):
                    return False
                continue
            actual = document.get(key)
            if isinstance(wanted, dict):
                for op, value in wanted.items():
                    if op == "$ne" and actual == value:
                        return False
                    if op == "$regex":
                        import re
                        flags = re.IGNORECASE if wanted.get("$options") == "i" else 0
                        if not re.search(value, str(actual or ""), flags):
                            return False
            elif actual != wanted:
                return False
        return True

    class DB:
        def __init__(self):
            self.identity_email_links = Collection([{
                "email_normalized": "former-staff@example.com",
                "identity_uid": "L-000007",
                "identity_type": "licensee",
            }])
            self.commercial_license_customers = Collection([{
                "id": "cus-old",
                "licensee_uid": "L-000007",
                "email": "admin@old-company.example",
                "email_normalized": "admin@old-company.example",
            }])
            self.commercial_licenses = Collection([{
                "id": "lic-old",
                "customer_id": "cus-old",
                "licensee_uid": "L-000007",
                "status": "active",
            }])
            self.users = Collection([])

        def __getitem__(self, name):
            return getattr(self, name)

    db = DB()
    link = db.identity_email_links.rows[0].copy()
    released = asyncio.run(
        release_stale_licensee_email_link(db, "former-staff@example.com", link)
    )
    assert released is True


def test_customer_contact_email_stays_reserved_until_customer_is_removed():
    import asyncio
    from backend.identity_hierarchy import release_stale_licensee_email_link

    class Collection:
        def __init__(self, rows=None):
            self.rows = list(rows or [])

        async def find_one(self, query=None, *args, **kwargs):
            return next((row.copy() for row in self.rows if matches(row, query or {})), None)

        async def delete_one(self, query):
            return type("Result", (), {"deleted_count": 1})()

    def matches(document, query):
        for key, wanted in query.items():
            if key == "$or":
                if not any(matches(document, branch) for branch in wanted):
                    return False
                continue
            if key == "$and":
                if not all(matches(document, branch) for branch in wanted):
                    return False
                continue
            actual = document.get(key)
            if isinstance(wanted, dict):
                for op, value in wanted.items():
                    if op == "$ne" and actual == value:
                        return False
                    if op == "$regex":
                        import re
                        flags = re.IGNORECASE if wanted.get("$options") == "i" else 0
                        if not re.search(value, str(actual or ""), flags):
                            return False
            elif actual != wanted:
                return False
        return True

    class DB:
        identity_email_links = Collection([{
            "email_normalized": "admin@old-company.example",
            "identity_uid": "L-000007",
        }])
        commercial_license_customers = Collection([{
            "id": "cus-old",
            "licensee_uid": "L-000007",
            "email": "Admin@Old-Company.Example",
        }])
        commercial_licenses = Collection([])
        users = Collection([])

        def __getitem__(self, name):
            return getattr(self, name)

    db = DB()
    released = asyncio.run(
        release_stale_licensee_email_link(
            db, "admin@old-company.example", db.identity_email_links.rows[0]
        )
    )
    assert released is False
