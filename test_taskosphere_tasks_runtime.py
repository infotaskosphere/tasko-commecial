"""Taskosphere Tasks runtime adapter contracts."""
import unittest

from fastapi import APIRouter

from backend.modules.taskosphere.tasks.runtime import TASK_ROUTER_RUNTIME


class TaskosphereTasksRuntimeTests(unittest.TestCase):
    def test_runtime_exposes_fastapi_router(self):
        self.assertIsInstance(TASK_ROUTER_RUNTIME.router, APIRouter)

    def test_runtime_retains_legacy_source_reference(self):
        self.assertEqual(TASK_ROUTER_RUNTIME.legacy_source, "backend.server_modules.task_routes")


if __name__ == "__main__":
    unittest.main()
