"""Regression tests for the central commercial hardening boundary."""
import os
import sys
import types
import unittest

os.environ.setdefault("ENV_MODE", "test")
os.environ.setdefault("JWT_SECRET", "test-secret-for-regression-suite")


class HardeningStaticContractTests(unittest.TestCase):
    def test_hardening_module_is_present_and_documented(self):
        path = os.path.join(os.path.dirname(__file__), "backend", "production_hardening.py")
        self.assertTrue(os.path.exists(path))
        text = open(path, encoding="utf-8").read()
        self.assertIn("TENANT_COLLECTIONS.update", text)
        self.assertIn("An active commercial license is required", text)
        self.assertIn("Cross-company access is not permitted", text)
        self.assertIn("User account is inactive", text)

    def test_production_hardening_is_bootstrapped_before_server(self):
        init_path = os.path.join(os.path.dirname(__file__), "backend", "__init__.py")
        text = open(init_path, encoding="utf-8").read()
        marker = "import backend.production_hardening as _production_hardening"
        self.assertIn(marker, text)
        self.assertLess(text.index(marker), text.index("import backend.server")) if "import backend.server" in text else None

    def test_strict_license_wrapper_accepts_guard_call_signature(self):
        """commercial_module_guard calls _commercial_license(user, path, method).

        The hardening wrapper must accept those extra arguments, otherwise every
        authenticated licensed-user request fails with TypeError -> HTTP 500.
        """
        import ast

        path = os.path.join(os.path.dirname(__file__), "backend", "production_hardening.py")
        tree = ast.parse(open(path, encoding="utf-8").read())
        func = next(
            node for node in ast.walk(tree)
            if isinstance(node, ast.AsyncFunctionDef) and node.name == "_strict_commercial_license"
        )
        self.assertIsNotNone(func.args.vararg, "wrapper must accept *args")
        self.assertIsNotNone(func.args.kwarg, "wrapper must accept **kwargs")


if __name__ == "__main__":
    unittest.main()

    def test_hardened_auth_passes_request_before_credentials(self):
        source_text = source("production_hardening.py")
        self.assertIn(
            "user = await _PRE_HARDENED_GET_CURRENT_USER(request, credentials)",
            source_text,
        )
        self.assertNotIn(
            "user = await _PRE_HARDENED_GET_CURRENT_USER(credentials)",
            source_text,
        )
