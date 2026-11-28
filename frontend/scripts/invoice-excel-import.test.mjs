// Excel invoice import: the values in the file are kept exactly, every row comes in,
// and a Company column routes each invoice to its own company.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseInvoiceRows, parseDate, parseAmount, matchCompany } from "../src/lib/invoiceExcelImport.js";

const HEAD = ["Invoice No", "Type", "Client", "Date", "Due Date", "Taxable", "GST", "Total", "Paid", "Balance", "Status", "Company"];
// Rows copied from the customer's export (invoices_28-Nov-2026.xlsx)
const ROWS = [
  HEAD,
  ["INV/26-27/141", "Tax Invoice", "SHIVAM SALES AGENCY", "2026-11-24", "", 8150, 0, 8150, 0, 8150, "draft", "Manthan Desai And Associates"],
  ["INV/26-27/027", "Tax Invoice", "STAR BOTTLING & CEMENT TRADERS", "2026-11-01", "", 32150, 5670, 37820, 0, 37820, "partially_paid", "Prodigist Ventures Private Limited"],
  ["INV-0002/25-26", "Tax Invoice", "JOGI HERBACEUTICALS PRIVATE LIMITED", "2026-04-01", "2026-05-01", 9150, 0, 9150, 9150, 0, "paid", "Manthan Desai And Associates"],
  ["INV/26-27/017", "Tax Invoice", "DESAI TECH WEAVES LLP", "2026-06-11", "", 1440.68, 259.32, 1700, 1700, 0, "paid", "Prodigist Ventures Private Limited"],
  ["INV/26-27/017", "Tax Invoice", "DIVINE VISION PRIVATE LIMITED", "2026-06-03", "", 10020, 0, 10000, 10000, 0, "paid", "MSA"],
  ["", "", "", "", "", "", "", "", "", "", "", ""],
];

test("every row is read, with the file's own dates, amounts and status", () => {
  const { invoices, skipped } = parseInvoiceRows(ROWS, "2026-11-28");
  assert.equal(invoices.length, 5);
  assert.equal(skipped.length, 0);
  const [a, b, c, d, e] = invoices;
  assert.equal(a.invoice_date, "2026-11-24");
  assert.equal(a.due_date, "2026-12-24");                      // blank due date → +30 days
  assert.equal(c.due_date, "2026-05-01");                      // given due date kept
  assert.equal(c.amount_due, 0);                               // "Due Date" is never read as balance
  assert.deepEqual([a.total_taxable, a.total_gst, a.grand_total, a.status], [8150, 0, 8150, "draft"]);
  assert.deepEqual([b.total_taxable, b.total_gst, b.total_cgst, b.total_sgst, b.status], [32150, 5670, 2835, 2835, "partially_paid"]);
  assert.equal(b.items[0].gst_rate, 18);
  assert.equal(d.items[0].gst_rate, 18);
  assert.equal(e.grand_total, 10000);                          // total kept as written
  assert.equal(b.client_gstin, "");                            // "GST" amount is not a GSTIN
  assert.equal(a.invoice_type, "tax_invoice");
  assert.deepEqual(invoices.map((i) => i.company_label),
    ["Manthan Desai And Associates", "Prodigist Ventures Private Limited", "Manthan Desai And Associates", "Prodigist Ventures Private Limited", "MSA"]);
});

test("dates and amounts in the usual Indian formats", () => {
  assert.equal(parseDate("24/11/2026"), "2026-11-24");
  assert.equal(parseDate("24-11-26"), "2026-11-24");
  assert.equal(parseDate("2026-11-24"), "2026-11-24");
  assert.equal(parseDate("24-Nov-2026"), "2026-11-24");
  assert.equal(parseDate(46350), "2026-11-24");                // Excel serial
  assert.equal(parseDate("31/02/2026"), null);
  assert.equal(parseAmount("₹ 1,23,456.50"), 123456.5);
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount(0), 0);
});

test("files without tax columns still work the old way", () => {
  const { invoices } = parseInvoiceRows([["Invoice No", "Customer", "Date", "Total", "Paid"], ["X1", "Acme", "01/04/2026", 1180, 0]], "2026-11-28");
  assert.deepEqual([invoices[0].total_taxable, invoices[0].total_gst, invoices[0].status, invoices[0].invoice_date], [1000, 180, "sent", "2026-04-01"]);
});

test("the Company column is matched to the app's companies by name", () => {
  const companies = [{ id: "p", name: "PRODIGIST VENTURES PRIVATE LIMITED" }, { id: "m", name: "Manthan Desai & Associates" }];
  assert.equal(matchCompany("Prodigist Ventures Private Limited", companies), "p");
  assert.equal(matchCompany("Manthan Desai And Associates", companies), "m");
  assert.equal(matchCompany("MSA", companies), "");
});

test("the import screen uses the new reader and sends each company separately", () => {
  const page = readFileSync(new URL("../src/pages/Invoicing.jsx", import.meta.url), "utf8");
  assert.match(page, /parseInvoiceRows\(rows/);
  assert.match(page, /company_id:\s+chunks\[ci\]\.cid/);
  assert.match(page, /Companies in this file/);
  assert.ok(!/Back-calculate taxable assuming 18% GST/.test(page), "old guessing reader is gone");
});

test("bulk delete removes invoices one at a time, shows progress and can be stopped", () => {
  const page = readFileSync(new URL("../src/pages/Invoicing.jsx", import.meta.url), "utf8");
  assert.match(page, /await api\.delete\(`\/invoices\/\$\{id\}`/);
  assert.match(page, /setInvoices\(\(list\) => list\.filter\(\(i\) => i\.id !== id\)\)/);
  assert.match(page, /Deleting \$\{bulkDeleteProgress\.done \+ 1\} of \$\{bulkDeleteProgress\.total\}/);
  assert.match(page, /Stop after this one/);
});
