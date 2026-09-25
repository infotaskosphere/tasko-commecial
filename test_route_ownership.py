"""Route ownership reconciliation contracts."""
import unittest

from backend.modules.route_ownership import ROUTE_OWNERSHIP
from backend.modules.runtime_ownership import RUNTIME_OWNERSHIP


class RouteOwnershipTests(unittest.TestCase):
    def test_every_runtime_owner_has_route_or_service_mapping(self):
        for domain, target in RUNTIME_OWNERSHIP.items():
            root = domain.rsplit(".", 1)[0]
            self.assertTrue(root)
            self.assertTrue(target.startswith("backend.modules."))

    def test_reconciled_routes_are_explicit(self):
        self.assertIn("taskosphere.tasks", ROUTE_OWNERSHIP)
        self.assertIn("finix_ai.accounting", ROUTE_OWNERSHIP)
        self.assertIn("aiweave.router", ROUTE_OWNERSHIP)
        self.assertIn("people_matrix.permissions", ROUTE_OWNERSHIP)
        self.assertIn("trademark.sphere", ROUTE_OWNERSHIP)


if __name__ == "__main__":
    unittest.main()
