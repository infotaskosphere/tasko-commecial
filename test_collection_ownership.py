"""Collection ownership regression contracts."""
import unittest

from backend.modules.collection_reconciliation import unresolved_collection_ownership


class CollectionOwnershipTests(unittest.TestCase):
    def test_no_duplicate_or_mismatched_collection_owners(self):
        report = unresolved_collection_ownership()
        self.assertEqual(report["duplicate_domain_owners"], {})
        self.assertEqual(report["shared_owner_mismatches"], {})


if __name__ == "__main__":
    unittest.main()
