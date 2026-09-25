"""Regression contracts for the controlled runtime switch."""
import unittest

from backend.modules.runtime_switch import RUNTIME_SWITCHES, is_migrated


class RuntimeSwitchTests(unittest.TestCase):
    def test_switches_default_to_legacy_runtime(self):
        self.assertTrue(RUNTIME_SWITCHES)
        self.assertTrue(all(value is False for value in RUNTIME_SWITCHES.values()))

    def test_unknown_subsystem_is_not_migrated(self):
        self.assertFalse(is_migrated("unknown.subsystem"))


if __name__ == "__main__":
    unittest.main()
