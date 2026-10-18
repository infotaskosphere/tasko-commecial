// Capital vs expense control on the purchase review, and the compliance tab reading the computed statements.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("the purchase review lets the person choose capital or expense, and sends the choice", () => {
  const d = src("components/purchase/InvoicePreviewDialog.jsx");
  assert.match(d, /preview\?\.capital_suggestion/);
  assert.match(d, /treat_as: treatAs/);
  assert.match(d, /asset_category: assetCategory, useful_life_years/);
  assert.match(d, /treatAs !== 'capital' \? \{ expense_ledger_code/, "an expense head is not sent for a capital bill");
  for (const id of ["treatment", "asset-category-select", "asset-life-input"]) assert.ok(d.includes(`data-testid="${id}"`), id);
  // the categories and lives must match the server's
  for (const cat of ["computers", "furniture", "plant_machinery", "vehicles", "buildings", "software", "intangibles", "other"]) assert.ok(d.includes(`'${cat}'`), cat);
});

test("the compliance tab shows computed figures and can book the tax entries", () => {
  const p = src("pages/AccountingReports.jsx");
  assert.ok(!p.includes("simulated_tax_provision"), "the invented tax figure is gone");
  for (const frag of [
    "pnl?.tax_expense", "tax_still_to_book", "section_43b_exposure", "accumulated_depreciation", "intangible_assets",
    "deferred_tax_liabilities", "trading_account", "cash_flow?.reconciles", "balance_sheet?.balanced", "tax_depreciation_rows",
    "/reports/mis-compliance/", "'deferred-tax'", "'tax-provision'", "tax_rate_pct: taxRatePct",
  ]) assert.ok(p.includes(frag), frag);
  assert.match(p, /The rate is an assumption/);
});
