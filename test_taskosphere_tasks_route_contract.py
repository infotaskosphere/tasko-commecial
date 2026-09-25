"""Taskosphere Tasks route-source regression test."""
import unittest
from backend.modules.taskosphere.tasks.route_contract import assert_route_equivalence, route_signatures

class TaskosphereTasksRouteContractTests(unittest.TestCase):
    def test_task_source_contains_routes(self):
        self.assertTrue(route_signatures())
        assert_route_equivalence()

if __name__ == "__main__":
    unittest.main()
