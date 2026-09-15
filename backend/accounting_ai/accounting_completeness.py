"""Supporting services for inventory and fixed-asset accounting.

These services are deliberately ledger-neutral: they calculate deterministic
movement/depreciation schedules, while actual account posting remains subject
to the central journal and period controls.
"""

from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict

PAISE = Decimal("0.01")


def _money(value: Any) -> Decimal:
    return Decimal(str(value or 0)).quantize(PAISE, rounding=ROUND_HALF_UP)


def calculate_inventory_movement(qty: Any, unit_cost: Any, movement_type: str) -> Dict[str, Any]:
    quantity = _money(qty)
    cost = _money(unit_cost)
    if quantity <= 0 or cost < 0:
        raise ValueError("Inventory quantity must be positive and unit cost cannot be negative.")
    movement = str(movement_type or "").upper()
    if movement not in {"IN", "OUT", "ADJUSTMENT"}:
        raise ValueError("Unsupported inventory movement type.")
    signed_qty = quantity if movement == "IN" else -quantity if movement == "OUT" else quantity
    return {"movement_type": movement, "quantity": float(quantity), "signed_quantity": float(signed_qty), "unit_cost": float(cost), "value": float((quantity * cost).quantize(PAISE))}


def straight_line_depreciation(cost: Any, residual_value: Any, useful_life_years: int, months: int = 12) -> Dict[str, float]:
    gross = _money(cost)
    residual = _money(residual_value)
    if gross <= 0 or residual < 0 or residual >= gross or useful_life_years <= 0:
        raise ValueError("Invalid fixed-asset depreciation inputs.")
    months = int(months)
    if months <= 0 or months > 12:
        raise ValueError("Depreciation months must be between 1 and 12.")
    monthly = (gross - residual) / Decimal(useful_life_years * 12)
    charge = min(monthly * months, gross - residual)
    return {"annual_depreciation": float((monthly * 12).quantize(PAISE)), "monthly_depreciation": float(monthly.quantize(PAISE)), "period_depreciation": float(charge.quantize(PAISE))}


def fixed_asset_register_record(asset_id: str, company_id: str, name: str, acquisition_date: Any, cost: Any, residual_value: Any, useful_life_years: int) -> Dict[str, Any]:
    if not asset_id or not company_id or not name:
        raise ValueError("Asset identity is required.")
    if isinstance(acquisition_date, str):
        acquisition_date = date.fromisoformat(acquisition_date[:10])
    if not isinstance(acquisition_date, date):
        raise ValueError("Valid acquisition date is required.")
    depreciation = straight_line_depreciation(cost, residual_value, useful_life_years)
    return {"asset_id": asset_id, "company_id": company_id, "name": name.strip(), "acquisition_date": acquisition_date.isoformat(), "cost": float(_money(cost)), "residual_value": float(_money(residual_value)), "useful_life_years": int(useful_life_years), "depreciation": depreciation, "status": "ACTIVE"}
