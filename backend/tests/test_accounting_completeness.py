import pytest

from backend.accounting_ai.accounting_completeness import (
    calculate_inventory_movement,
    weighted_average_cost,
    straight_line_depreciation,
)


def test_inventory_supports_fractional_quantities():
    movement = calculate_inventory_movement("1.1250", "100.00", "IN")
    assert movement["quantity"] == 1.125
    assert movement["value"] == 112.50


def test_weighted_average_inventory_never_allows_negative_stock():
    result = weighted_average_cost(10, 1000, [
        calculate_inventory_movement(5, 120, "IN"),
        calculate_inventory_movement(2, 0, "OUT"),
    ])
    assert result["closing_quantity"] == 13.0
    assert result["closing_value"] > 0

    with pytest.raises(ValueError):
        weighted_average_cost(1, 100, [calculate_inventory_movement(2, 50, "OUT")])


def test_straight_line_depreciation_is_capped_by_depreciable_amount():
    result = straight_line_depreciation(120000, 20000, 5, 12)
    assert result["annual_depreciation"] == 20000.0
    assert result["period_depreciation"] == 20000.0
