"""Final route ownership reconciliation tests."""
import unittest

from backend.modules.route_reconciliation import RECONCILED_OWNERS, unresolved_owners


class RouteReconciliationTests(unittest.TestCase):
    def test_all_declared_route_owners_are_reconciled(self):
        self.assertEqual(unresolved_owners(), [])
        self.assertTrue(RECONCILED_OWNERS)


if __name__ == "__main__":
    unittest.main()
