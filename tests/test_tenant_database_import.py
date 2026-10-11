"""Phase 1 smoke test: tenant database routing imports without a dependency cycle."""


def test_tenant_database_module_imports_without_dependencies_cycle():
    import backend.tenant_database as tenant_database

    assert callable(tenant_database.configure)
    assert callable(tenant_database.tenant_db_name)
    assert callable(tenant_database.provision)
