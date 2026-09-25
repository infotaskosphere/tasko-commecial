"""Architecture-only regression tests for the domain module boundaries."""
import unittest

from backend.modules.dependency_guard import find_violations
from backend.modules.registry import MODULE_REGISTRATIONS


class ModuleArchitectureTests(unittest.TestCase):
    def test_all_registered_domains_have_packages(self):
        for registration in MODULE_REGISTRATIONS:
            package = registration.package.replace(".", "/")
            self.assertTrue(__import__(registration.package))
            self.assertTrue(__import__(registration.package).__name__)
            self.assertTrue((__import__("pathlib").Path(package) / "__init__.py").exists())

    def test_declared_module_dependencies_are_clean(self):
        self.assertEqual(find_violations(), [])


if __name__ == "__main__":
    unittest.main()
