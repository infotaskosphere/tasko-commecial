"""Phase G tests for controlled router migration adapters."""
import unittest

from fastapi import APIRouter

from backend.modules.router_registry import RouterBinding, register_router_bindings
from backend.modules.taskosphere.tasks.router import router as task_router
from backend.modules.taskosphere.attendance.router import router as attendance_router
from backend.modules.compligenie.compliance.router import router as compliance_router
from backend.modules.leadsense.leads.router import router as leads_router
from backend.modules.people_matrix.permissions.router import router as permission_router


class RouterMigrationAdapterTests(unittest.TestCase):
    def test_adapters_expose_real_fastapi_routers(self):
        for router in (
            task_router,
            attendance_router,
            compliance_router,
            leads_router,
            permission_router,
        ):
            self.assertIsInstance(router, APIRouter)

    def test_registry_registers_explicit_bindings(self):
        from fastapi import FastAPI
        app = FastAPI()
        bindings = (
            RouterBinding("taskosphere", "tasks", lambda: task_router),
            RouterBinding("taskosphere", "attendance", lambda: attendance_router),
        )
        register_router_bindings(app, bindings)
        paths = {route.path for route in app.routes}
        self.assertTrue(paths)

if __name__ == "__main__":
    unittest.main()
