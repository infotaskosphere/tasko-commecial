from backend.tenant_database_manager import (
    TENANT_DB_PREFIX,
    tenant_database_for_customer,
    tenant_database_name,
    validate_tenant_database_name,
)


def test_tenant_database_name_is_stable_and_does_not_expose_customer_id():
    customer_id = "cus-private-company-123"
    first = tenant_database_name(customer_id)
    assert first == tenant_database_name(customer_id)
    assert first.startswith(TENANT_DB_PREFIX)
    assert customer_id not in first
    assert len(first) == len(TENANT_DB_PREFIX) + 32


def test_tenant_database_mapping_requires_ready_registry_and_exact_derived_name():
    customer_id = "cus-123"
    name = tenant_database_name(customer_id)
    assert validate_tenant_database_name(customer_id, name)
    assert not validate_tenant_database_name("cus-other", name)
    assert tenant_database_for_customer(customer_id, {"tenant_database_name": name}) is None
    assert tenant_database_for_customer(
        customer_id,
        {"tenant_database_name": name, "tenant_database_status": "ready"},
    ) == name


def test_tenant_database_mapping_rejects_untrusted_or_malformed_database_names():
    customer_id = "cus-123"
    for value in ["admin", "taskosphere_tenant_../../other", "taskosphere_tenant_" + "a" * 32]:
        assert not validate_tenant_database_name(customer_id, value)
