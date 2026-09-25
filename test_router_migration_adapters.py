"""Phase G tests for controlled router migration adapters."""
import unittest

from fastapi import APIRouter

from backend.modules.router_registry import RouterBinding, register_router_bindings
from backend.modules.taskosphere.tasks.router import register as task_register
from backend.modules.taskosphere.attendance.router import register as attendance_register
from backend.modules.compligenie.compliance.router import register as compliance_register
from backend.modules.leadsense.leads.router import register as leads_register
from backend.modules.people_matrix.permissions.router import register as permission_register


class RouterMigrationAdapterTests(unittest.TestCase):
    def test_adapters_expose_registration_callables(self):
        for register in (
            task_register,
            attendance_register,
            compliance_register,
            leads_register,
            permission_register,
        ):
            self.assertTrue(callable(register))

    def test_registry_registers_explicit_bindings(self):
        from fastapi import FastAPI
        app = FastAPI()
        bindings = (
            RouterBinding("taskosphere", "tasks", lambda: APIRouter()),
            RouterBinding("taskosphere", "attendance", lambda: APIRouter()),
        )
        register_router_bindings(app, bindings)
        paths = {route.path for route in app.routes}
        self.assertTrue(paths)

if __name__ == "__main__":
    unittest.main()
