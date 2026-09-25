"""Regression contract for the first physical model extraction."""
import unittest

from backend.models import HolidayCreate as LegacyHolidayCreate, HolidayResponse as LegacyHolidayResponse
from backend.modules.taskosphere.attendance.models_holidays import HolidayCreate, HolidayResponse


class ModelExtractionTests(unittest.TestCase):
    def test_legacy_exports_preserve_extracted_model_identity(self):
        self.assertIs(LegacyHolidayCreate, HolidayCreate)
        self.assertIs(LegacyHolidayResponse, HolidayResponse)


if __name__ == "__main__":
    unittest.main()
