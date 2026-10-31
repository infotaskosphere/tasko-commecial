// Zero Touch is merged into Purchase: one page, no second menu entry, old links still work.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("the Zero Touch page and its menu entry are gone, and the old link lands on Purchase", () => {
  assert.ok(!existsSync(new URL("../src/pages/ZeroTouchEntry.jsx", import.meta.url)));
  assert.ok(!/path: '\/zero-touch-entry'/.test(src("components/layout/DashboardLayout.jsx")), "no second menu entry");
  const routes = src("AppRoutes.jsx");
  assert.ok(!/ZeroTouchEntry/.test(routes));
  assert.match(routes, /path="\/zero-touch-entry" element=\{<Navigate to="\/purchase" replace\s*\/>\}/);
  assert.match(src("components/layout/NotificationBell.jsx"), /approved_zte_journal: "\/purchase"/);
});

test("Purchase lists the bills still waiting for review and opens them in the same review dialog", () => {
  const page = src("pages/Purchase.jsx");
  for (const frag of ["/purchase-invoices/inbox", "/draft", "/dismiss", "Waiting for review"]) assert.ok(page.includes(frag), frag);
  const dialog = src("components/purchase/InvoicePreviewDialog.jsx");
  assert.match(dialog, /zte_doc_id: preview\.zte_doc_id/);
  for (const code of ["foreign_currency", "fx_unavailable", "inbox_note"]) assert.ok(dialog.includes(`'${code}'`), code);
});

test("amounts are labelled in the bill's own currency, and a saved bill cannot have its currency changed", () => {
  const form = src("components/purchase/InvoiceForm.jsx");
  assert.match(form, /Amounts \(\{foreign \? ccy : '₹'\}\)/);
  assert.match(form, /showCurrency = true/);
  assert.match(src("pages/Purchase.jsx"), /showCurrency=\{false\}/);
});
