// The Books & Vouchers page is wired in everywhere a Finix page must be, and talks to the endpoints that exist.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const back = (p) => readFileSync(new URL(`../../backend/${p}`, import.meta.url), "utf8");

test("the page has a route, a menu entry, a permission mapping and branding", () => {
  assert.match(src("AppRoutes.jsx"), /path="\/accounting-books" element=\{<ModuleGate module="finix"><AccountingBooks\s*\/>/);
  assert.match(src("components/layout/DashboardLayout.jsx"), /path: '\/accounting-books'.*can_view_extended_accounts_reports/);
  assert.match(src("components/ModuleGate.jsx"), /'can_view_extended_accounts_reports', '\/accounting-books'/);
  assert.match(src("lib/commercialPermissionMatrix.js"), /"can_view_extended_accounts_reports", "\/accounting-books"/);
  assert.match(src("module-branding.js"), /\|accounting-books\|[^\n]*return 'accounts';/, "branded as Finix");
});

test("every endpoint the page calls exists on the backend", () => {
  const page = src("pages/AccountingBooks.jsx");
  const server = back("accounting_books.py");
  const called = [...page.matchAll(/['`]\/accounting-books([^'`?]*)['`]/g)].map((m) => m[1].replace(/\$\{[^}]+\}/g, "{id}"));
  assert.ok(called.length >= 10, "page should call the books API");
  for (const path of new Set(called)) {
    const route = path.replace("{id}", "{[a-z_]+}");
    assert.match(server, new RegExp(`@router\\.(get|post|put)\\("${route.replace(/\//g, "\\/")}"`), `backend has no route for ${path}`);
  }
});

test("the page guards the rules the server enforces", () => {
  const page = src("pages/AccountingBooks.jsx");
  assert.match(page, /isCashBank/, "payment, receipt and contra pick cash or bank accounts only");
  assert.match(page, /particularAccounts\(accounts\)/, "particulars exclude cash and bank");
  assert.match(page, /totals\.balanced/, "a journal cannot be saved until it balances");
  assert.match(page, /check\.blockers > 0/, "closing is disabled while must-fix items remain");
  assert.match(page, /isAdmin/, "year-end and settings are for administrators");
  assert.match(page, /reason\.trim\(\)\.length < 5/, "reopening needs a reason");
});
