"""Tenant isolation reconciliation contracts."""
import unittest

from backend.modules.tenant_reconciliation import missing_tenant_coverage


class TenantReconciliationTests(unittest.TestCase):
    def test_operational_owned_collections_are_tenant_scoped(self):
        missing = missing_tenant_coverage()
        self.assertEqual(missing, {})


if __name__ == "__main__":
    unittest.main()
