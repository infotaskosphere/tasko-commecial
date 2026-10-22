// Pure helpers behind the Inventory, Standards and Notes tabs.
import test from "node:test";
import assert from "node:assert/strict";
import { MOVEMENT_KINDS, needsRate, rateMissing, stockStatus } from "../src/lib/inventory.js";
import {
  LEASE_TREATMENT, NOTE_STATUS, PROVISION_TREATMENT, distinctCurrencies, fxSummary, isCapitalLease, leaseNextStep, notesToText, pendingNotes,
} from "../src/lib/standards.js";

test("receipts need a rate, issues do not, and the direction of every kind is known", () => {
  assert.equal(needsRate("purchase"), true);
  assert.equal(needsRate("opening"), true);
  assert.equal(needsRate("sale"), false);
  assert.equal(needsRate("sales_return"), false);
  assert.equal(rateMissing({ kind: "purchase", rate: "" }), true);
  assert.equal(rateMissing({ kind: "purchase", rate: "0" }), false);
  assert.equal(rateMissing({ kind: "sale" }), false);
  assert.deepEqual(Object.keys(MOVEMENT_KINDS).sort(), ["adjustment_in", "adjustment_out", "opening", "purchase", "purchase_return", "sale", "sales_return"]);
  for (const k of ["purchase", "opening", "sales_return", "adjustment_in"]) assert.equal(MOVEMENT_KINDS[k].direction, "in");
  for (const k of ["sale", "purchase_return", "adjustment_out"]) assert.equal(MOVEMENT_KINDS[k].direction, "out");
});

test("stock status shows negative, out of stock, reorder and in stock", () => {
  assert.equal(stockStatus({ quantity: -2 }).label, "Negative");
  assert.equal(stockStatus({ quantity: 0 }).label, "Out of stock");
  assert.equal(stockStatus({ quantity: 3, below_reorder: true }).label, "Reorder");
  assert.deepEqual(stockStatus({ quantity: 30, below_reorder: false }), { label: "In stock", tone: "good" });
});

test("foreign-currency helpers", () => {
  assert.deepEqual(distinctCurrencies([{ currency: "usd" }, { currency: "EUR" }, { currency: "USD" }, {}]), ["EUR", "USD"]);
  assert.deepEqual(fxSummary({ assets_difference: 3000, liabilities_difference: -1200 }), { assets: 3000, liabilities: -1200, net: 1800 });
  assert.equal(fxSummary({}).net, 0);
});

test("a capital lease must be recognised before its periods are posted", () => {
  assert.equal(isCapitalLease({ treatment: "rou" }), true);
  assert.equal(isCapitalLease({ treatment: "finance" }), true);
  assert.equal(isCapitalLease({ treatment: "operating" }), false);
  assert.equal(leaseNextStep({ treatment: "rou", recognised: false }), "recognise");
  assert.equal(leaseNextStep({ treatment: "rou", recognised: true }), "post");
  assert.equal(leaseNextStep({ treatment: "exempt", recognised: false }), "post");
  assert.ok(LEASE_TREATMENT.rou.label && LEASE_TREATMENT.exempt.label);
});

test("every provision treatment and note status has a label and a colour", () => {
  for (const t of ["recognise", "disclose", "ignore"]) assert.ok(PROVISION_TREATMENT[t].label && PROVISION_TREATMENT[t].tone);
  for (const s of ["complete", "needs_input", "not_applicable"]) assert.ok(NOTE_STATUS[s].label && NOTE_STATUS[s].tone);
});

test("notes: pending ones are found and the text copy carries every section", () => {
  const report = {
    financial_year: "2026-27", framework: "IND_AS",
    sections: [
      { no: 1, title: "Policies", standard: "AS 1 / Ind AS 1", status: "complete", kind: "policies", policies: [{ title: "Basis", standard: "AS 1", text: "Accrual." }] },
      { no: 2, title: "Leases", standard: "Ind AS 116", status: "complete", kind: "table", columns: ["Particulars", "Amount"], rows: [["Liability", "100.00"]] },
      { no: 3, title: "Events", standard: "Ind AS 10", status: "needs_input", kind: "text", text: "Management to confirm." },
    ],
  };
  assert.deepEqual(pendingNotes(report.sections).map((s) => s.title), ["Events"]);
  const text = notesToText(report);
  assert.match(text, /Notes to accounts, 2026-27 \(Ind AS\)/);
  assert.match(text, /1\. Policies \[AS 1 \/ Ind AS 1\]\n {2}Basis \(AS 1\): Accrual\./);
  assert.match(text, /Particulars \| Amount\n {2}Liability \| 100\.00/);
  assert.match(text, /3\. Events .*\n {2}Management to confirm\./);
});
