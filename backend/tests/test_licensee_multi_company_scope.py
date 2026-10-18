"""A licensee may work in every legal company it keeps in Master Data, and nothing else."""
import pytest
from fastapi import HTTPException

from backend import tenant_runtime as tr
from backend.commercial_module_guard import ANY_OF_FEATURES, FEATURE_PREFIXES


@pytest.fixture
def licensee_scope():
    company = tr.set_authenticated_company("cus-main")
    allowed = tr.set_tenant_company_ids(["cus-main", "co-advisory", "co-ventures"])
    yield
    tr.reset_tenant_company_ids(allowed)
    tr.reset_authenticated_company(company)


def test_default_is_login_company_for_operational_data(licensee_scope):
    assert tr._scope_query({}, "invoices") == {"company_id": "cus-main"}


def test_other_own_company_can_be_selected(licensee_scope):
    assert tr._scope_query({"company_id": "co-advisory"}, "invoices") == {"company_id": "co-advisory"}
    assert tr._scope_query({"company_id": {"$in": ["cus-main", "co-ventures"]}}, "invoices")["company_id"] == {
        "$in": ["cus-main", "co-ventures"]
    }


def test_another_tenant_is_still_refused(licensee_scope):
    with pytest.raises(HTTPException) as exc:
        tr._scope_query({"company_id": "someone-else"}, "invoices")
    assert exc.value.status_code == 403
    with pytest.raises(HTTPException):
        tr._scope_query({"company_id": {"$in": ["cus-main", "someone-else"]}}, "invoices")
    with pytest.raises(HTTPException):
        tr._scope_replacement({"id": "x", "company_id": "someone-else"})


def test_clients_and_users_default_to_all_licensee_companies(licensee_scope):
    for name in ("clients", "users"):
        assert tr._scope_query({}, name) == {"company_id": {"$in": ["co-advisory", "co-ventures", "cus-main"]}}


def test_inserts_keep_the_selected_company(licensee_scope):
    assert tr._scope_replacement({"id": "i1", "company_id": "co-advisory"})["company_id"] == "co-advisory"
    assert tr._scope_replacement({"id": "i2"})["company_id"] == "cus-main"


def test_updates_stay_in_the_record_company(licensee_scope):
    query = tr._scope_query({"id": "i1", "company_id": "co-advisory"}, "invoices")
    update = tr._scope_update({"$set": {"status": "paid"}}, query)
    assert update["$set"]["company_id"] == "co-advisory"
    with pytest.raises(HTTPException):
        tr._scope_update({"$set": {"company_id": "cus-main"}}, query)
    # A multi-company update must not re-stamp every record with one company.
    multi = tr._scope_query({}, "clients")
    assert "company_id" not in tr._scope_update({"$set": {"name": "x"}}, multi)["$set"]


def test_company_in_request_scope(licensee_scope):
    class U:
        company_id = "cus-main"
    assert tr.company_in_request_scope(U(), "co-ventures")
    assert not tr.company_in_request_scope(U(), "someone-else")


def test_bank_master_scope_defaults_to_all_verified_legal_companies(licensee_scope):
    token = tr.set_bank_master_scope(True)
    try:
        expected = {"company_id": {"$in": ["co-advisory", "co-ventures", "cus-main"]}}
        assert tr._scope_query({}, "bank_accounts") == expected
        assert tr._scope_query({"id": "bank-1"}, "bank_transactions") == {
            "id": "bank-1",
            "company_id": {"$in": ["co-advisory", "co-ventures", "cus-main"]},
        }
        with pytest.raises(HTTPException) as exc:
            tr._scope_query({"company_id": "someone-else"}, "bank_accounts")
        assert exc.value.status_code == 403
    finally:
        tr.reset_bank_master_scope(token)


def test_bank_master_scope_does_not_widen_other_operational_modules(licensee_scope):
    token = tr.set_bank_master_scope(True)
    try:
        assert tr._scope_query({}, "invoices") == {"company_id": "cus-main"}
        assert tr._scope_query({}, "purchase_invoices") == {"company_id": "cus-main"}
    finally:
        tr.reset_bank_master_scope(token)


def test_single_company_licensee_unchanged():
    company = tr.set_authenticated_company("solo")
    try:
        assert tr._scope_query({}, "clients") == {"company_id": "solo"}
        with pytest.raises(HTTPException):
            tr._scope_query({"company_id": "other"}, "invoices")
    finally:
        tr.reset_authenticated_company(company)


@pytest.mark.parametrize("path,flag", [
    ("/finix/ai/learning/vendors", "finix_learning_data"),
    ("/finix/ai/learning/accuracy", "finix_learning_data"),
    ("/finix/ai/agent/propose", "finix_ai_workspace_data"),
    ("/finix/ai/ask", "finix_ai_workspace_data"),
    ("/finix/ai/resync", "finix_ai_workspace_data"),
])
def test_finix_ai_paths_map_to_licensable_pages(path, flag):
    best, best_len = None, -1
    for module, features in FEATURE_PREFIXES.items():
        for f, prefixes in features.items():
            for prefix in prefixes:
                if (path == prefix or path.startswith(prefix + "/")) and len(prefix) > best_len:
                    best, best_len = (module, f), len(prefix)
    assert best == ("finix", flag)
    assert ("finix", flag) in ANY_OF_FEATURES
