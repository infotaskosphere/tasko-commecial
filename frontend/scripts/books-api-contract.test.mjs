// Every API call the Books & Vouchers tabs make must match a real backend route, with the right HTTP method.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const PREFIX = { API: "/accounting-books/inventory", SP: "/accounting-books/standards", NOTES: "/accounting-books/notes" };

const BACKEND = [
  ["accounting_books.py", "/accounting-books"], ["accounting_inventory.py", "/accounting-books/inventory"], ["accounting_standards.py", "/accounting-books/standards"],
  ["accounting_standards_obligations.py", "/accounting-books/standards"], ["accounting_notes.py", "/accounting-books/notes"],
];

function backendRoutes() {
  const routes = [];
  for (const [file, prefix] of BACKEND) {
    const src = read(`../../backend/${file}`);
    for (const m of src.matchAll(/@router\.(get|post|put|delete)\("([^"]*)"/g)) {
      const pattern = (prefix + m[2]).replace(/\{[^}]+\}/g, "[^/]+");
      routes.push({ method: m[1], regex: new RegExp(`^${pattern}$`), text: prefix + m[2] });
    }
  }
  return routes;
}

function frontendCalls() {
  const dir = new URL("../src/pages/books/", import.meta.url);
  const files = [...readdirSync(dir).filter((f) => f.endsWith(".jsx")).map((f) => read(`../src/pages/books/${f}`)), read("../src/pages/AccountingBooks.jsx")];
  const calls = [];
  for (const src of files) {
    for (const m of src.matchAll(/api\.(get|post|put|delete)\(\s*[`']([^`']+)[`']/g)) {
      if (m[2].includes("${path}")) continue; // the generic get() helper itself, checked through its callers below
      let path = m[2].replace(/\$\{(API|SP|NOTES)\}/g, (_, k) => PREFIX[k]);
      path = path.replace(/\$\{[^}]+\}/g, "x");
      calls.push({ method: m[1], path });
    }
    // helper `get('/path', ...)` defined in the standards panels: always GET under /accounting-books/standards
    for (const m of src.matchAll(/(?<![.\w])get\(\s*[`']([^`']+)[`']/g)) {
      calls.push({ method: "get", path: PREFIX.SP + m[1].replace(/\$\{[^}]+\}/g, "x") });
    }
  }
  return calls.filter((c) => c.path.startsWith("/accounting-books"));
}

test("every call the tabs make has a matching backend route and method", () => {
  const routes = backendRoutes();
  const calls = frontendCalls();
  assert.ok(calls.length >= 60, `expected many calls, found ${calls.length}`);
  for (const c of calls) {
    const hit = routes.find((r) => r.method === c.method && r.regex.test(c.path.split("?")[0]));
    assert.ok(hit, `no ${c.method.toUpperCase()} route for ${c.path}`);
  }
});

test("the new tabs are mounted on the page", () => {
  const page = read("../src/pages/AccountingBooks.jsx");
  for (const t of ["inventory", "standards", "notes"]) assert.match(page, new RegExp(`\\['${t}', `), `tab ${t}`);
  assert.match(page, /<InventoryTab companyId=\{companyId\}/);
  assert.match(page, /<StandardsTab companyId=\{companyId\} accounts=\{accounts\}/);
  assert.match(page, /<NotesTab companyId=\{companyId\}/);
});

test("the tabs keep the rules the server enforces", () => {
  const inv = read("../src/pages/books/InventoryTab.jsx");
  assert.match(inv, /l\.negative_on/, "closing stock cannot be posted while an item is negative");
  assert.match(inv, /rateMissing\(form\)/, "a receipt needs a rate");
  const part = read("../src/pages/books/StandardsPartB.jsx");
  assert.match(part, /leaseNextStep\(l\)/, "a lease is recognised before periods are posted");
  assert.match(part, /!form\.qualifying_asset/, "borrowing costs need the qualifying-asset confirmation");
  const a = read("../src/pages/books/StandardsPartA.jsx");
  assert.match(a, /isAdmin &&/, "provision rates are for administrators");
  const notes = read("../src/pages/books/NotesTab.jsx");
  assert.match(notes, /isAdmin && !editing/, "only an administrator edits policy wording");
  assert.match(notes, /pendingNotes\(data\.sections\)/, "notes that still need input are called out");
});

test("tab-like controls inside the page avoid role=tab, which the app's global CSS restyles", () => {
  const dir = new URL("../src/pages/books/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsx"))) assert.doesNotMatch(read(`../src/pages/books/${f}`), /role="tab"/, f);
  assert.doesNotMatch(read("../src/pages/AccountingBooks.jsx"), /role="tab"/);
});
