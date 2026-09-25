"""Production-safety checks for the one-pass server modularization.

These checks intentionally validate the real backend.server import path and
the extracted application runtime rather than relying only on compileall.
"""

import os
import unittest


os.environ.setdefault("ENV_MODE", "test")
os.environ.setdefault("JWT_SECRET", "test-secret-for-production-runtime")


class ProductionRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import backend.server as server
        from backend.server_modules import application_runtime

        cls.server = server
        cls.application_runtime = application_runtime

    def test_server_is_thin_composition_layer(self):
        source = open("backend/server.py", encoding="utf-8").read()
        self.assertLessEqual(len(source), 15000)
        self.assertNotIn("@api_router.", source)
        self.assertNotIn("@app.", source)

    def test_application_runtime_source_compiles(self):
        compile(
            self.application_runtime.SOURCE,
            "backend/server_modules/application_runtime.py:SOURCE",
            "exec",
        )

    def test_application_runtime_registered_core_endpoints(self):
        paths = {
            route.path
            for route in self.server.app.routes
            if getattr(route, "path", "").startswith("/api/")
        }
        self.assertIn("/api/auth/me", paths)
        self.assertTrue(any(path.startswith("/api/clients/") for path in paths))

    def test_health_and_root_are_registered(self):
        paths = {getattr(route, "path", "") for route in self.server.app.routes}
        self.assertIn("/health", paths)
        self.assertIn("/", paths)

    def test_startup_hook_is_present_and_async(self):
        import inspect

        self.assertTrue(callable(self.server.startup_event))
        self.assertTrue(inspect.iscoroutinefunction(self.server.startup_event))


if __name__ == "__main__":
    unittest.main()
