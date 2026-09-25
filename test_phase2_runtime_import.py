"""Phase 2 runtime smoke test for the real backend import path.

This intentionally imports backend.server exactly as the ASGI application does
(backend.server:app). It verifies that the extracted route modules execute their
registration path successfully and that FastAPI receives the API routes.
"""

import os
import unittest


os.environ.setdefault("ENV_MODE", "test")
os.environ.setdefault("JWT_SECRET", "test-secret-for-phase2-runtime")


class Phase2RuntimeImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import backend.server as server

        cls.server = server

    def test_application_imports_and_exposes_fastapi_app(self):
        from fastapi import FastAPI

        self.assertIsInstance(self.server.app, FastAPI)
        self.assertTrue(hasattr(self.server, "api_router"))

    def test_extracted_route_registration_reached_fastapi(self):
        api_routes = [
            route
            for route in self.server.app.routes
            if getattr(route, "path", "").startswith("/api/")
        ]

        self.assertGreater(len(api_routes), 20)

        paths = {route.path for route in api_routes}
        self.assertIn("/api/auth/me", paths)

    def test_all_phase2_route_registrars_are_imported(self):
        expected = (
            "register_email_service_routes",
            "register_task_duplicate_detection",
            "register_auth_routes",
            "register_users_todos_admin",
            "register_attendance_routes",
            "register_salary_reports",
            "register_task_routes",
            "register_dsc_routes",
            "register_document_routes",
            "register_compliance_due_dates",
            "register_reporting_and_master",
            "register_client_import_parsing",
            "register_client_management",
            "register_dashboard_ops",
            "register_holiday_trademark_misc",
        )

        for name in expected:
            self.assertTrue(callable(getattr(self.server, name, None)), name)


if __name__ == "__main__":
    unittest.main()
