"""Phase I route-audit regression contracts."""
import unittest

from fastapi import FastAPI

from backend.modules.route_audit import find_duplicate_routes


class RouteAuditTests(unittest.TestCase):
    def test_clean_app_has_no_duplicate_signatures(self):
        app = FastAPI()

        @app.get("/one")
        async def one():
            return {"ok": True}

        self.assertEqual(find_duplicate_routes(app), {})

    def test_duplicate_signatures_are_detected(self):
        app = FastAPI()

        @app.get("/same")
        async def first():
            return {"first": True}

        @app.get("/same")
        async def second():
            return {"second": True}

        duplicates = find_duplicate_routes(app)
        self.assertIn(("/same", ("GET",)), duplicates)
        self.assertEqual(len(duplicates[("/same", ("GET",))]), 2)


if __name__ == "__main__":
    unittest.main()
