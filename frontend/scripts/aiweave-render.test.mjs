// Run with: node --test frontend/scripts/aiweave-render.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, parseInline, safeUrl } from "../src/components/aiweave/markdownParser.js";
import { highlight } from "../src/components/aiweave/highlight.js";
import { parseSSE, decodeEvent } from "../src/lib/sse.js";

const flat = (nodes) => nodes.map((n) => (n.t === "text" ? n.v : n.c ? flat(n.c) : n.v)).join("");

test("paragraphs, headings and hard line breaks", () => {
  const b = parseMarkdown("# Title\n\nfirst line\nsecond line\n\n### Sub");
  assert.deepEqual(b.map((x) => x.type), ["heading", "paragraph", "heading"]);
  assert.equal(b[0].level, 1);
  assert.equal(b[1].lines.length, 2);
});

test("inline styles nest and stay literal when unfinished", () => {
  const n = parseInline("a **bold *and em*** `code` ~~gone~~");
  assert.deepEqual(n.map((x) => x.t), ["text", "strong", "text", "code", "text", "del"]);
  assert.equal(parseInline("half **written")[0].v, "half **written");
  assert.equal(flat(parseInline("snake_case_name and file_name.xlsx")), "snake_case_name and file_name.xlsx");
  assert.equal(parseInline("snake_case_name").length, 1);
  assert.equal(parseInline("2 * 3 * 4")[0].v, "2 * 3 * 4");
});

test("links only keep safe protocols", () => {
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("data:text/html;base64,AAAA"), null);
  assert.equal(safeUrl("https://example.com/a"), "https://example.com/a");
  const bad = parseInline("[click](javascript:alert(1))");
  assert.ok(!bad.some((x) => x.t === "link"));
  assert.equal(flat(bad), "click");
  const good = parseInline("see [GST](https://gst.gov.in) now");
  assert.equal(good[1].t, "link");
  const auto = parseInline("visit https://example.com/path.");
  assert.equal(auto[1].href, "https://example.com/path");
  assert.equal(auto[2].v, ".");
});

test("raw HTML stays text", () => {
  const n = parseInline("<img src=x onerror=alert(1)> <script>x</script>");
  assert.ok(n.every((x) => x.t === "text"));
});

test("fenced code, closed and still streaming", () => {
  const closed = parseMarkdown("before\n\n```python\nprint(1)\n```\n\nafter");
  assert.deepEqual(closed.map((x) => x.type), ["paragraph", "code", "paragraph"]);
  assert.equal(closed[1].lang, "python");
  assert.equal(closed[1].code, "print(1)");
  assert.equal(closed[1].open, false);
  const open = parseMarkdown("```js\nconst a = 1;\nconst b");
  assert.equal(open[0].open, true);
  assert.equal(open[0].code, "const a = 1;\nconst b");
  const tildes = parseMarkdown("~~~\n```inner```\n~~~");
  assert.equal(tildes[0].code, "```inner```");
});

test("lists: bullets, numbers, nesting, and a list that interrupts a paragraph", () => {
  const b = parseMarkdown("Steps:\n- one\n- two\n  - nested a\n  - nested b\n- three\n\n1. first\n2. second");
  assert.deepEqual(b.map((x) => x.type), ["paragraph", "list", "list"]);
  assert.equal(b[1].items.length, 3);
  const nested = b[1].items[1].find((x) => x.type === "list");
  assert.equal(nested.items.length, 2);
  assert.equal(b[2].ordered, true);
  assert.equal(b[2].items.length, 2);
  const start = parseMarkdown("3. three\n4. four");
  assert.equal(start[0].start, 3);
});

test("tables with alignment and short rows", () => {
  const b = parseMarkdown("| Item | Qty | Rate |\n|:--|:-:|--:|\n| Pen | 2 | 10 |\n| Ink | 1 |\n\nafter");
  assert.equal(b[0].type, "table");
  assert.deepEqual(b[0].align, ["left", "center", "right"]);
  assert.equal(b[0].rows.length, 2);
  assert.equal(b[0].rows[1].length, 3);
  assert.equal(b[1].type, "paragraph");
  assert.equal(parseMarkdown("a | b\nnot a table")[0].type, "paragraph");
});

test("quotes and rules", () => {
  const b = parseMarkdown("> note one\n> note two\n\n---\n\ntext");
  assert.deepEqual(b.map((x) => x.type), ["quote", "hr", "paragraph"]);
  assert.equal(b[0].blocks[0].type, "paragraph");
});

test("never loops or throws on odd input", () => {
  for (const s of ["", "\n\n", "```", "|", "|-|", "> ", "- ", "1.", "* * *", "**", "[", "[a](", "\\", "`", "~~", "# ", "  - a\n- b\n   c", "- a\n\n\n\n- b"]) {
    assert.ok(Array.isArray(parseMarkdown(s)), JSON.stringify(s));
  }
  const big = "- item **x**\n".repeat(3000) + "| a | b |\n|-|-|\n".repeat(200);
  const t = Date.now();
  parseMarkdown(big);
  assert.ok(Date.now() - t < 1500, "large input parses quickly");
});

test("every prefix of a streamed answer parses", () => {
  const doc = "# Notice\n\nThe **demand** is `₹1,200`.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```sql\nSELECT 1;\n```\n\n- x\n  - y\n";
  for (let i = 0; i <= doc.length; i++) parseMarkdown(doc.slice(0, i));
});

test("syntax colouring", () => {
  const t = highlight('const a = "x"; // note\nreturn 42', "javascript");
  const types = Object.fromEntries(t.map((x) => [x.text.trim(), x.type]));
  assert.equal(types.const, "keyword");
  assert.equal(types['"x"'], "string");
  assert.equal(types["// note"], "comment");
  assert.equal(types["42"], "number");
  assert.equal(t.map((x) => x.text).join(""), 'const a = "x"; // note\nreturn 42');
  assert.equal(highlight("SELECT * FROM t", "sql")[0].type, "keyword");
  assert.deepEqual(highlight("<b>hi</b>", "html"), [{ type: "plain", text: "<b>hi</b>" }]);
  assert.equal(highlight("'unterminated", "py").map((x) => x.text).join(""), "'unterminated");
});

test("event stream framing across arbitrary read boundaries", () => {
  const wire = 'data: {"event":"start"}\n\ndata: {"event":"chunk","delta":"Hel"}\n\ndata: {"event":"chunk","delta":"lo"}\n\ndata: [DONE]\n\n';
  for (const size of [1, 2, 3, 7, 11, 1000]) {
    let rest = "";
    const got = [];
    for (let i = 0; i < wire.length; i += size) {
      const r = parseSSE(rest + wire.slice(i, i + size));
      rest = r.rest;
      got.push(...r.events);
    }
    const objs = got.map(decodeEvent).filter(Boolean);
    assert.equal(objs.map((o) => o.delta || "").join(""), "Hello", `chunk size ${size}`);
    assert.equal(got[got.length - 1], "[DONE]");
  }
  assert.equal(parseSSE("data: {\"a\":1}\r\n\r\n").events[0], '{"a":1}');
  assert.equal(decodeEvent("not json"), null);
  assert.equal(decodeEvent("[DONE]"), null);
  assert.equal(parseSSE(": ping\n\n").events.length, 0);
});

import { buildContext, fromStored, groupByRecency, describeFailure, formatDuration, titleFrom } from "../src/components/aiweave/chatModel.js";

test("stored messages are reshaped for the screen", () => {
  const a = fromStored({ id: "1", role: "assistant", content: "hi", providerName: "Gemini", modelName: "Flash", tokens: 9, latencyMs: 1200,
    fallbackTrail: [{ provider: "openai", model: "gpt", status: "QUOTA_EXHAUSTED", reason: "limit", latency_ms: 50 }] });
  assert.equal(a.meta.providerName, "Gemini");
  assert.equal(a.meta.fallbackTrail[0].latencyMs, 50);
  assert.equal(a.status, "done");
  assert.deepEqual(fromStored({ role: "user", content: "q" }).attachments, []);
});

test("context sent to the model skips unfinished and failed turns and stays bounded", () => {
  const msgs = [
    { role: "user", content: "a" },
    { role: "assistant", content: "partial", status: "pending" },
    { role: "assistant", content: "boom", status: "error" },
    { role: "error", content: "x" },
    { role: "assistant", content: "ok", status: "done" },
    { role: "user", content: "   " },
  ];
  assert.deepEqual(buildContext(msgs).map((m) => m.content), ["a", "ok"]);
  const many = Array.from({ length: 80 }, (_, i) => ({ role: "user", content: `m${i}` }));
  assert.equal(buildContext(many).length, 30);
  assert.equal(buildContext(many)[29].content, "m79");
  const huge = Array.from({ length: 30 }, () => ({ role: "assistant", status: "done", content: "x".repeat(50000) }));
  const ctx = buildContext(huge);
  assert.ok(ctx.reduce((n, m) => n + m.content.length, 0) <= 300000);
  assert.ok(ctx.every((m) => m.content.length <= 24000));
});

test("history grouping, titles, durations and failure wording", () => {
  const now = new Date(2026, 9, 18, 15, 0, 0);
  const g = groupByRecency([
    { id: 1, updated_at: new Date(2026, 9, 18, 9).toISOString() },
    { id: 2, updated_at: new Date(2026, 9, 17, 22).toISOString() },
    { id: 3, updated_at: new Date(2026, 9, 14).toISOString() },
    { id: 4, updated_at: new Date(2026, 8, 1).toISOString() },
    { id: 5 },
  ], now);
  assert.deepEqual(g.map((x) => [x.label, x.items.length]), [["Today", 1], ["Yesterday", 1], ["Previous 7 days", 1], ["Earlier", 2]]);
  assert.equal(titleFrom("  hello\n\n world  "), "hello world");
  assert.equal(titleFrom(""), "New conversation");
  assert.equal(formatDuration(850), "850 ms");
  assert.equal(formatDuration(1234), "1.2 s");
  assert.equal(formatDuration(null), "");
  assert.match(describeFailure({ status: 429, detail: "Rate limit reached: 20 AI requests per minute.", retryAfter: 42 }), /Try again in 42 s/);
  assert.match(describeFailure({ status: 401 }), /session has expired/);
  assert.match(describeFailure({ status: 503 }), /No AI provider/);
  assert.equal(describeFailure({ message: "Network down" }), "Network down");
});

// ── brand and shell fit ──────────────────────────────────────────────────────
import { readFileSync, existsSync } from "node:fs";
const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("the AIWeave mark is the product's own icon, not a redrawn one", () => {
  const mark = src("components/aiweave/WeaveMark.jsx");
  assert.match(mark, /\/aiweave-icon\.png/);
  assert.ok(existsSync(new URL("../public/aiweave-icon.png", import.meta.url)));
  assert.match(src("module-branding.js"), /collapsedLogo: '\/aiweave-icon\.png'/); // same file the app shell shows
  assert.ok(!/<svg/.test(mark), "no hand-drawn logo");
});

test("brand colours come from the logo (navy, blue, green), not an invented accent", () => {
  const css = src("components/aiweave/aiweave.css");
  for (const hex of ["#0d3b66", "#1f6fb2", "#1faf5a"]) assert.ok(css.includes(hex), hex);
  assert.ok(!/0e9c9c|2cc4c4/i.test(css));
});

test("the page fills exactly the space the app shell leaves it", () => {
  const shell = src("components/layout/DashboardLayout.jsx");
  const header = Number(/HEADER_H = (\d+)/.exec(shell)[1]) + Number(/SECTION_BAR_H = (\d+)/.exec(shell)[1]);
  const css = src("components/aiweave/aiweave.css");
  assert.ok(css.includes(`calc(100vh - ${header}px - 2 * var(--aw-shell-pad))`), `css must subtract the ${header}px shell header`);
  assert.ok(shell.includes("padding: 'clamp(0.75rem, 1.5vw, 1.5rem)'"), "shell padding changed: update --aw-shell-pad");
  assert.ok(css.includes("--aw-shell-pad: clamp(0.75rem, 1.5vw, 1.5rem)"));
});
