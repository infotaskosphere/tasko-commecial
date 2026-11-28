// GST returns follow the law in force (Tax rules & law updates), are per company, and Finix
// chat routes sales / receipts / bills to real documents.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("GSTR-1 B2C Large: inter-state only, limit read from the rules for the return month", () => {
  const page = src("pages/Invoicing.jsx");
  assert.match(page, /\/statutory-rules\/effective/);
  assert.match(page, /interState && total > b2clLimit/);
  assert.ok(!/total > 250000/.test(page), "old hard-coded 2.5 lakh limit is gone");
});

test("GSTR-3B is built on the server for one company and exports ITC, reverse charge and set-off", () => {
  const page = src("pages/Invoicing.jsx");
  assert.match(page, /\/gst-returns\/gstr3b/);
  assert.match(page, /Combined view, not for filing/);
  assert.match(page, /t4\.a3_reverse_charge/);
  assert.match(page, /6\.1 Payment/);
  assert.match(src("pages/AccountingReports.jsx"), /combined, not for filing/);
});

test("purchase review supports reverse charge and its totals check excludes the tax we pay", () => {
  assert.match(src("components/purchase/InvoicePreviewDialog.jsx"), /reverse_charge/);
  assert.match(src("lib/purchase.js"), /const billGst = f\.reverse_charge \? 0 : gst;/);
});

test("Finix chat: bills open the Purchase review, sales become draft invoices, receipts go to an invoice", () => {
  const c = src("components/finix/FinixAICommandCenter.jsx");
  assert.match(c, /\/purchase-invoices\/preview/);
  assert.match(c, /<InvoicePreviewDialog/);
  assert.match(c, /Create draft invoice/);
  assert.match(c, /Record receipt/);
  assert.match(c, /Open Purchase to upload the bill/);
});

test("Tax rules & law updates page is routed and in the menu", () => {
  assert.match(src("AppRoutes.jsx"), /path="\/tax-rules"/);
  assert.match(src("components/layout/DashboardLayout.jsx"), /Tax Rules & Law Updates/);
  assert.match(src("pages/TaxRules.jsx"), /\/statutory-rules/);
});
