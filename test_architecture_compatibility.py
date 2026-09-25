"""Regression contracts for legacy compatibility during migration."""
import unittest

from backend.modules.compatibility import LEGACY_OWNERSHIP
from backend.modules.migration_status import FINAL_RUNTIME_MIGRATION_ENABLED, MIGRATION_STATUS


class ArchitectureCompatibilityTests(unittest.TestCase):
    def test_legacy_sources_have_explicit_owners(self):
        self.assertIn("backend.models", LEGACY_OWNERSHIP)
        self.assertIn("backend.server_modules", LEGACY_OWNERSHIP)

    def test_final_runtime_migration_is_not_enabled_early(self):
        self.assertFalse(FINAL_RUNTIME_MIGRATION_ENABLED)

    def test_domains_have_migration_status(self):
        expected = {"taskosphere", "finix_ai", "aiweave", "compligenie", "leadsense", "people_matrix", "records", "trademark"}
        self.assertEqual(set(MIGRATION_STATUS), expected)


if __name__ == "__main__":
    unittest.main()
