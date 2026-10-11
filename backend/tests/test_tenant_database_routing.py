from backend.tenant_runtime import (
    TenantAwareDatabase,
    reset_authenticated_tenant_database,
    set_authenticated_tenant_database,
)
from backend.tenant_database_manager import tenant_database_name


class FakeDatabase:
    def __init__(self, name):
        self.name = name
        self.collections = {}

    def __getitem__(self, name):
        self.collections.setdefault(name, FakeCollection(self.name, name))
        return self.collections[name]


class FakeCollection:
    def __init__(self, database_name, collection_name):
        self.database_name = database_name
        self.collection_name = collection_name


class FakeClient:
    def __init__(self):
        self.databases = {}

    def __getitem__(self, name):
        self.databases.setdefault(name, FakeDatabase(name))
        return self.databases[name]


def test_tenant_business_collections_route_to_the_authenticated_tenant_database():
    client = FakeClient()
    central = client["central"]
    facade = TenantAwareDatabase(central, mongo_client=client)
    token = set_authenticated_tenant_database(tenant_database_name("cus-a"))
    try:
        assert facade["tasks"]._collection.database_name == tenant_database_name("cus-a")
        assert facade["todos"]._collection.database_name == tenant_database_name("cus-a")
        assert facade["users"]._collection.database_name == "central"
        assert facade["commercial_licenses"]._collection.database_name == "central"
    finally:
        reset_authenticated_tenant_database(token)


def test_without_verified_tenant_mapping_legacy_routing_stays_central():
    client = FakeClient()
    facade = TenantAwareDatabase(client["central"], mongo_client=client)
    token = set_authenticated_tenant_database(None)
    try:
        assert facade["tasks"]._collection.database_name == "central"
    finally:
        reset_authenticated_tenant_database(token)
