import test from "node:test";
import assert from "node:assert/strict";
import { errText, fyOptions, isCashBank, journalTotals, particularAccounts, particularsTotal, sortChecklist, todayIso } from "../src/lib/books.js";

test("journal totals treat blanks as nothing and need both sides to agree", () => {
  assert.deepEqual(journalTotals([{ debit: "100.10" }, { credit: 100.1 }]), { debit: 100.1, credit: 100.1, difference: 0, balanced: true });
  assert.equal(journalTotals([{ debit: 100 }, { credit: 99.99 }]).balanced, false);
  assert.equal(journalTotals([{ debit: 0.1 }, { debit: 0.2 }, { credit: 0.3 }]).balanced, true, "floating point noise is not a difference");
  assert.equal(journalTotals([]).balanced, false, "an empty journal is not balanced");
  assert.equal(particularsTotal([{ amount: "10.5" }, { amount: "" }, { amount: 4.5 }]), 15);
});

test("cash and bank ledgers are told apart from everything else", () => {
  const cash = { id: "1", type: "asset", schedule3_head: "Cash and cash equivalents" };
  const debtors = { id: "2", type: "asset", schedule3_head: "Trade receivables" };
  const rent = { id: "3", type: "expense", schedule3_head: "Other expenses" };
  const group = { id: "4", type: "expense", is_group: true };
  assert.ok(isCashBank(cash) && !isCashBank(debtors) && !isCashBank(rent));
  assert.deepEqual(particularAccounts([cash, debtors, rent, group, { id: "5", type: "expense", is_active: false }]).map((a) => a.id), ["2", "3"]);
});

test("financial years run April to March, newest first", () => {
  assert.deepEqual(fyOptions(new Date(2026, 9, 18), 2), ["2026-27", "2025-26", "2024-25"]);
  assert.equal(fyOptions(new Date(2027, 1, 1), 0)[0], "2026-27", "February still belongs to the year that began the previous April");
  assert.equal(fyOptions(new Date(2026, 3, 1), 0)[0], "2026-27");
  assert.equal(fyOptions(new Date(2026, 2, 31), 0)[0], "2025-26");
  assert.equal(todayIso(new Date(2026, 0, 5)), "2026-01-05");
});

test("api errors become readable text whatever shape the detail has", () => {
  const e = (detail) => ({ response: { data: { detail } } });
  assert.equal(errText(e("Choose a company first.")), "Choose a company first.");
  assert.equal(errText(e({ code: "checklist", message: "Resolve these first." })), "Resolve these first.");
  assert.equal(errText(e([{ msg: "Field required" }, { msg: "Too short" }])), "Field required. Too short");
  assert.equal(errText({ message: "Network Error" }), "Network Error");
  assert.match(errText({}), /try again/);
});

test("the year-end checklist lists blockers before warnings before notes", () => {
  const order = sortChecklist([{ severity: "info" }, { severity: "warning" }, { severity: "blocker" }, { severity: "warning" }]).map((i) => i.severity);
  assert.deepEqual(order, ["blocker", "warning", "warning", "info"]);
});
