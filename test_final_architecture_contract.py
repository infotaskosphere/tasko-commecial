"""Ensure architecture is never reported complete prematurely."""
import unittest

from backend.modules.final_architecture_contract import (
    ARCHITECTURE_GATES,
    architecture_complete,
)


class FinalArchitectureContractTests(unittest.TestCase):
    def test_incomplete_until_all_gates_pass(self):
        self.assertFalse(architecture_complete())
        self.assertFalse(ARCHITECTURE_GATES["runtime_router_migration"])
        self.assertFalse(ARCHITECTURE_GATES["production_verification"])


if __name__ == "__main__":
    unittest.main()
