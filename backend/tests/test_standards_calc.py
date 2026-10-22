"""The standards arithmetic, checked against hand-worked figures."""
from datetime import date

import pytest

from backend.standards_calc import (
    MATRIX_AS, MATRIX_IND_AS, ageing, borrowing_cost, eps, fx_difference, gratuity, lease_schedule, leave_encashment, present_value,
    service_years, treatment, weighted_average_shares,
)

FY = (date(2026, 4, 1), date(2027, 3, 31))


def ev(day, type, shares=0, ratio=0):
    return {"date": day, "type": type, "shares": shares, "ratio": ratio}


# ── AS 20 / Ind AS 33 ──
def test_weighted_average_counts_new_shares_only_from_their_issue_date():
    w = weighted_average_shares([ev("2026-04-01", "opening", 100000), ev("2026-10-01", "issue", 20000)], *FY)
    assert round(w["weighted"], 2) == round(100000 + 20000 * 182 / 365, 2) and w["closing"] == 120000 and w["days"] == 365


def test_a_bonus_issue_is_restated_back_to_the_start_of_the_period():
    w = weighted_average_shares([ev("2026-04-01", "opening", 100000), ev("2026-10-01", "issue", 20000), ev("2027-01-01", "bonus", ratio=0.5)], *FY)
    assert round(w["weighted"], 1) == round((183 * 150000 + 92 * 180000 + 90 * 180000) / 365, 1) and w["closing"] == 180000


def test_a_split_restates_every_earlier_share_and_a_buyback_reduces_from_its_date():
    split = weighted_average_shares([ev("2026-04-01", "opening", 100000), ev("2026-10-01", "split", ratio=10)], *FY)
    assert round(split["weighted"], 2) == 1_000_000 and split["closing"] == 1_000_000
    bb = weighted_average_shares([ev("2026-04-01", "opening", 100000), ev("2026-10-01", "buyback", 10000)], *FY)
    assert round(bb["weighted"], 2) == round(100000 - 10000 * 182 / 365, 2)


def test_shares_issued_in_earlier_years_count_for_the_whole_year():
    w = weighted_average_shares([ev("2020-04-01", "opening", 50000)], *FY)
    assert w["weighted"] == 50000


def test_basic_and_diluted_eps_with_options_and_convertibles():
    base = eps(1_000_000, 100_000)
    assert base["basic"] == 10.0 and base["diluted"] == 10.0
    opt = eps(1_000_000, 100_000, [{"instrument": "option", "shares": 10000, "exercise_price": 50}], avg_price=100)
    assert opt["diluted"] == 9.52 and opt["instruments"][0]["incremental_shares"] == 5000
    out = eps(1_000_000, 100_000, [{"instrument": "option", "shares": 10000, "exercise_price": 120}], avg_price=100)
    assert out["diluted"] == 10.0 and out["instruments"][0]["included"] is False
    anti = eps(1_000_000, 100_000, [{"instrument": "convertible", "shares": 20000, "earnings_addback": 300_000}])
    assert anti["diluted"] == 10.0 and anti["instruments"][0]["included"] is False                 # 15 per share is above 10
    dil = eps(1_000_000, 100_000, [{"instrument": "convertible", "shares": 20000, "earnings_addback": 100_000}])
    assert dil["diluted"] == 9.17 and dil["instruments"][0]["included"] is True                    # 1.1m / 120k
    loss = eps(-500_000, 100_000, [{"instrument": "option", "shares": 10000, "exercise_price": 50}], avg_price=100)
    assert loss["basic"] == -5.0 and loss["diluted"] == -5.0


# ── AS 19 / Ind AS 116 ──
def test_lease_liability_is_the_present_value_and_the_schedule_runs_down_to_zero():
    s = lease_schedule(10000, 12, "monthly", 12, date(2026, 4, 1))
    assert s["present_value"] == 112550.77 and s["rows"][0]["interest"] == 1125.51 and s["rows"][-1]["closing"] == 0
    assert round(sum(r["interest"] for r in s["rows"]), 0) == round(120000 - 112550.77, 0)
    assert s["rows"][0]["start"] == "2026-04-01" and s["rows"][0]["end"] == "2026-04-30" and s["rows"][-1]["end"] == "2027-03-31"
    assert s["depreciation_per_period"] == round(112550.77 / 12, 2)
    adv = lease_schedule(10000, 12, "monthly", 12, date(2026, 4, 1), in_advance=True)
    assert adv["present_value"] == 113676.28 and adv["rows"][-1]["closing"] == 0


def test_escalating_rent_is_levelled_by_the_straight_line_figure():
    s = lease_schedule(1000, 24, "monthly", 10, date(2026, 4, 1), escalation_pct=10)
    assert s["total_payments"] == 25200 and s["straight_line_per_period"] == 1050 and s["rows"][12]["payment"] == 1100
    q = lease_schedule(30000, 4, "quarterly", 8, date(2026, 4, 1))
    assert q["rows"][1]["start"] == "2026-07-01" and q["rows"][3]["end"] == "2027-03-31"


# ── AS 15 / Ind AS 19 ──
def test_gratuity_follows_the_statutory_formula_and_eligibility():
    assert service_years(date(2018, 4, 1), date(2026, 9, 30)) == 8
    assert service_years(date(2018, 4, 1), date(2026, 10, 30)) == 9          # more than six months into the year
    g = gratuity(50000, date(2018, 4, 1), date(2026, 9, 30))
    assert g["eligible"] and g["amount"] == round(15 / 26 * 50000 * 8, 2)
    assert gratuity(50000, date(2023, 6, 1), date(2026, 9, 30))["amount"] == 0                   # under five years
    assert gratuity(500000, date(1996, 1, 1), date(2026, 9, 30))["amount"] == 2_000_000          # statutory ceiling
    assert leave_encashment(26000, 13) == 13000


# ── AS 11 / Ind AS 21 ──
def test_unrealised_exchange_difference_has_the_right_sign_for_assets_and_liabilities():
    assert fx_difference("receivable", 1000, 80, 83) == 3000       # dollars owed to us are worth more
    assert fx_difference("payable", 1000, 80, 83) == -3000         # dollars we owe cost more
    assert fx_difference("payable", 1000, 80, 78) == 2000
    assert fx_difference("bank", 500, 82, 82) == 0


# ── AS 29 / Ind AS 37 ──
def test_probability_and_measurability_decide_how_an_obligation_is_treated():
    assert treatment("probable", True) == "recognise" and treatment("probable", False) == "disclose"
    assert treatment("possible", True) == "disclose" and treatment("remote", True) == "ignore"
    assert treatment("probable", True, is_asset=True) == "disclose" and treatment("possible", True, is_asset=True) == "ignore"
    assert present_value(100000, 10, 2) == 82644.63 and present_value(100000, 0, 2) == 100000


# ── AS 16 / Ind AS 23 ──
def test_borrowing_cost_is_interest_for_the_days_less_temporary_investment_income():
    b = borrowing_cost(1_000_000, 10, date(2026, 4, 1), date(2026, 6, 12), temp_income=1500)
    assert b["days"] == 73 and b["interest"] == 20000 and b["capitalisable"] == 18500


# ── receivables ──
def test_ageing_buckets_and_the_two_provision_matrices():
    invs = [{"due_date": "2026-10-10", "amount": 2000}, {"due_date": "2026-10-30", "amount": 1000},      # 8 days over / not yet due
            {"due_date": "2026-08-20", "amount": 3000},                                                    # 59 days
            {"due_date": "2026-06-20", "amount": 6000},                                                    # 120 days
            {"due_date": "2026-03-01", "amount": 4000},                                                    # 231 days
            {"due_date": "2025-06-01", "amount": 5000}, {"due_date": "2026-09-01", "amount": 0}]
    today = date(2026, 10, 18)
    a = ageing(invs, today, MATRIX_IND_AS)
    by = {r["bucket"]: r["outstanding"] for r in a["rows"]}
    assert by == {"Not yet due": 1000, "1-30 days": 2000, "31-90 days": 3000, "91-180 days": 6000, "181-365 days": 4000, "Over 365 days": 5000}
    assert a["total_outstanding"] == 21000
    assert a["provision_required"] == round(1000 * .005 + 2000 * .01 + 3000 * .03 + 6000 * .10 + 4000 * .35 + 5000 * .75, 2)
    assert ageing(invs, today, MATRIX_AS)["provision_required"] == 4000 * .25 + 5000 * .5
    assert ageing(invs, today, MATRIX_AS, forward_looking_pct=20)["provision_required"] == round(4000 * .30 + 5000 * .6, 2)
