"""Stock valuation per AS 2 / Ind AS 2: cost, then the lower of cost and net realisable value.

Pure functions with no database access, so the cost formulas can be tested on their own.

Cost formulas (both standards allow these two; neither allows LIFO):
* ``WEIGHTED_AVG`` - a perpetual moving average: after every receipt the average cost is recomputed, and every issue
  leaves stock at the average in force that day.
* ``FIFO``         - issues consume the oldest receipts first, so closing stock is valued at the latest prices.

Cost of purchase includes duties and freight that are not recoverable, less trade discounts (the caller folds these
into ``other_costs``). Measurement is item by item: carrying value = min(cost, net realisable value x quantity). The
write-down is recomputed at each valuation date from the NRV currently on the item, so it reverses on its own when the
NRV recovers, but never lifts an item above cost.
"""
from __future__ import annotations

from collections import deque
from typing import Dict, Iterable, List, Optional

IN_KINDS = ("opening", "purchase", "sales_return", "adjustment_in")
OUT_KINDS = ("sale", "purchase_return", "adjustment_out")
METHODS = ("WEIGHTED_AVG", "FIFO")
_EPS = 1e-9


def r2(v: float) -> float:
    return round(float(v or 0) + 0.0, 2)


def ordered(movements: Iterable[dict]) -> List[dict]:
    """Active movements in the order they happened: by date, then by when they were recorded."""
    live = [m for m in movements if m.get("status", "active") != "cancelled"]
    return sorted(live, key=lambda m: (str(m.get("date") or ""), str(m.get("created_at") or ""), str(m.get("id") or "")))


def run_item(movements: Iterable[dict], method: str = "WEIGHTED_AVG", as_of: Optional[str] = None) -> dict:
    """Replay one item's movements and return its stock ledger and closing position.

    Returns ``{"quantity", "value", "unit_cost", "rows", "negative_on"}``. ``rows`` has one entry per movement with the
    cost of what moved and the running balance. ``negative_on`` is the first date stock went below zero (an issue of
    more than was on hand), or None.
    """
    if method not in METHODS:
        raise ValueError(f"Unknown inventory method {method}")
    qty, value = 0.0, 0.0
    layers: deque = deque()          # FIFO: [quantity, unit cost]
    last_cost = 0.0
    rows: List[dict] = []
    negative_on: Optional[str] = None

    for m in ordered(movements):
        day = str(m.get("date") or "")
        if as_of and day > as_of:
            break
        q = float(m.get("quantity") or 0)
        if q <= 0:
            continue
        if m.get("direction") == "in":
            rate = m.get("rate")
            unit = float(rate) if rate is not None else (value / qty if qty > _EPS else last_cost)
            amount = q * unit
            qty += q
            value += amount
            last_cost = unit
            if method == "FIFO":
                layers.append([q, unit])
            moved = amount
        else:
            if method == "WEIGHTED_AVG":
                avg = value / qty if qty > _EPS else last_cost
                take = min(q, max(qty, 0.0))
                moved = take * avg + (q - take) * avg      # a shortfall is costed at the last known average
                value -= take * avg
                qty -= q
            else:
                need, moved = q, 0.0
                while need > _EPS and layers:
                    lq, lrate = layers[0]
                    use = min(lq, need)
                    moved += use * lrate
                    value -= use * lrate
                    layers[0][0] -= use
                    need -= use
                    if layers[0][0] <= _EPS:
                        layers.popleft()
                if need > _EPS:                            # issued more than was on hand
                    moved += need * last_cost
                qty -= q
            if qty < -_EPS and negative_on is None:
                negative_on = day
            if abs(qty) <= _EPS:                           # no stock left: drop rounding dust
                qty, value = 0.0, 0.0
                layers.clear()
        rows.append({"id": m.get("id"), "date": day, "kind": m.get("kind"), "direction": m.get("direction"), "quantity": q,
                     "unit_cost": r2(moved / q) if q else 0.0, "amount": r2(moved), "balance_quantity": round(qty, 4),
                     "balance_value": r2(value), "ref_no": m.get("ref_no") or "", "note": m.get("note") or ""})

    unit_cost = value / qty if qty > _EPS else 0.0
    return {"quantity": round(qty, 4), "value": r2(value), "unit_cost": r2(unit_cost), "rows": rows, "negative_on": negative_on}


def goes_negative(movements: Iterable[dict], method: str = "WEIGHTED_AVG") -> Optional[str]:
    """The first date a set of movements would take stock below zero, or None when it never does."""
    return run_item(movements, method)["negative_on"]


def carrying(cost_value: float, quantity: float, nrv_per_unit: Optional[float]) -> dict:
    """Lower of cost and net realisable value for one item."""
    cost_value = float(cost_value or 0)
    if nrv_per_unit is None or quantity <= _EPS:
        return {"cost": r2(cost_value), "nrv": None if nrv_per_unit is None else r2(float(nrv_per_unit) * max(quantity, 0)),
                "carrying": r2(cost_value), "write_down": 0.0}
    nrv_total = float(nrv_per_unit) * quantity
    use = min(cost_value, nrv_total)
    return {"cost": r2(cost_value), "nrv": r2(nrv_total), "carrying": r2(use), "write_down": r2(cost_value - use)}


def value_items(items: List[dict], movements: Iterable[dict], method: str, as_of: str) -> Dict[str, object]:
    """Value every item at ``as_of``. ``items`` need an ``id``; ``nrv_per_unit`` is optional on each."""
    by_item: Dict[str, List[dict]] = {}
    for m in movements:
        by_item.setdefault(str(m.get("item_id")), []).append(m)
    lines, total_cost, total_write_down, total_carrying = [], 0.0, 0.0, 0.0
    for it in items:
        res = run_item(by_item.get(str(it.get("id")), []), method, as_of)
        c = carrying(res["value"], res["quantity"], it.get("nrv_per_unit"))
        lines.append({"item_id": it.get("id"), "name": it.get("name"), "sku": it.get("sku") or "", "unit": it.get("unit") or "Nos",
                      "group": it.get("group") or "", "quantity": res["quantity"], "unit_cost": res["unit_cost"],
                      "nrv_per_unit": it.get("nrv_per_unit"), **c, "negative_on": res["negative_on"]})
        total_cost += c["cost"]
        total_write_down += c["write_down"]
        total_carrying += c["carrying"]
    return {"as_of": as_of, "method": method, "lines": lines, "total_cost": r2(total_cost),
            "total_write_down": r2(total_write_down), "total_carrying": r2(total_carrying)}
