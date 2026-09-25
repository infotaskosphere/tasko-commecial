"""Taskosphere Tasks route equivalence regression test."""
import unittest

from backend.modules.taskosphere.tasks.route_contract import (
    assert_route_equivalence,
    route_signatures,
)
from backend.server_modules.task_routes import router as legacy_router
from backend.modules.taskosphere.tasks.router import router as migrated_router


class TaskosphereTasksRouteContractTests(unittest.TestCase):
    def test_migrated_adapter_preserves_legacy_routes(self):
        self.assertEqual(route_signatures(legacy_router), route_signatures(migrated_router))
        assert_route_equivalence()


if __name__ == "__main__":
    unittest.main()
