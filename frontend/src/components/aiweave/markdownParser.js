/**
 * Markdown for AI answers: a small parser that returns a plain data tree.
 *
 * It never produces HTML. The React renderer turns the tree into elements, so a
 * model (or a document it quoted) cannot inject markup or script. It is also
 * tolerant of half-written input, because answers are re-parsed on every
 * streamed update: an unclosed code fence is a code block that is still open,
 * and an unclosed `**` is just text until its partner arrives.
 */

const SAFE_PROTOCOLS = /^(https?:|mailto:|tel:)/i;

/** Only web, mail and phone links survive; javascript:, data: and the like become plain text. */
export function safeUrl(raw) {
  const url = String(raw || "").trim();
  if (!url) return null;
  if (SAFE_PROTOCOLS.test(url)) return url;
  if (url.startsWith("#")) return url;
  return null;
}

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~|>]/;
const WORD_CHAR = /[\p{L}\p{N}]/u;

export function parseInline(src) {
  const text = String(src ?? "");
  const out = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) { out.push({ t: "text", v: buf }); buf = ""; }
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === "\\" && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      let n = 1;
      while (text[i + n] === "`") n++;
      const fence = "`".repeat(n);
      const end = text.indexOf(fence, i + n);
      if (end > i + n) {
        flush();
        out.push({ t: "code", v: text.slice(i + n, end).replace(/^ (.+) $/, "$1") });
        i = end + n;
        continue;
      }
      buf += fence;
      i += n;
      continue;
    }

    if (ch === "[") {
      const m = /^\[([^\]\n]+)\]\(\s*((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\s*\)/.exec(text.slice(i, i + 2200));
      if (m) {
        const href = safeUrl(m[2]);
        flush();
        if (href) out.push({ t: "link", href, c: parseInline(m[1]) });
        else out.push(...parseInline(m[1]));
        i += m[0].length;
        continue;
      }
    }

    if (ch === "h" && (text.startsWith("http://", i) || text.startsWith("https://", i)) && !WORD_CHAR.test(text[i - 1] || " ")) {
      const m = /^https?:\/\/[^\s<>]+/.exec(text.slice(i, i + 2200));
      if (m) {
        const url = m[0].replace(/[.,;:!?'")\]]+$/, "");
        flush();
        out.push({ t: "link", href: url, c: [{ t: "text", v: url }] });
        i += url.length;
        continue;
      }
    }

    if ((ch === "*" || ch === "_") && text[i + 1] === ch) {
      const close = text.indexOf(ch + ch, i + 2);
      if (close > i + 2 && !/^\s/.test(text[i + 2]) && !/\s$/.test(text.slice(i + 2, close))) {
        flush();
        out.push({ t: "strong", c: parseInline(text.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    if (ch === "~" && text[i + 1] === "~") {
      const close = text.indexOf("~~", i + 2);
      if (close > i + 2) {
        flush();
        out.push({ t: "del", c: parseInline(text.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    if ((ch === "*" || ch === "_") && text[i + 1] !== ch && text[i + 1] && !/\s/.test(text[i + 1])) {
      // underscores inside words (snake_case, file_name.xlsx) are not emphasis
      const wordBefore = ch === "_" && WORD_CHAR.test(text[i - 1] || " ");
      if (!wordBefore) {
        let close = -1;
        for (let j = i + 1; j < text.length; j++) {
          if (text[j] === "\\") { j++; continue; }
          if (text[j] === ch && text[j + 1] !== ch && text[j - 1] !== ch && !/\s/.test(text[j - 1])) {
            if (ch === "_" && WORD_CHAR.test(text[j + 1] || " ")) continue;
            close = j;
            break;
          }
        }
        if (close > i + 1) {
          flush();
          out.push({ t: "em", c: parseInline(text.slice(i + 1, close)) });
          i = close + 1;
          continue;
        }
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)[^\n`]*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (s[i] === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function startsTable(lines, i) {
  return (
    lines[i].includes("|") &&
    i + 1 < lines.length &&
    lines[i + 1].includes("-") &&
    TABLE_DELIM_RE.test(lines[i + 1]) &&
    splitRow(lines[i]).length === splitRow(lines[i + 1]).length
  );
}

function startsBlock(lines, i) {
  const line = lines[i];
  if (FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line)) return true;
  const li = LIST_RE.exec(line);
  if (li && (/^[-*+]$/.test(li[2]) || /^1[.)]$/.test(li[2]))) return true;
  return startsTable(lines, i);
}

const indentOf = (line) => /^\s*/.exec(line)[0].length;

function parseList(lines, start) {
  const first = LIST_RE.exec(lines[start]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNumber = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let i = start;
  let current = null;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length) break;
      const next = lines[j];
      const nm = LIST_RE.exec(next);
      const continues = indentOf(next) >= base + 2 || (nm && nm[1].length < base + 2 && /\d/.test(nm[2]) === ordered && indentOf(next) >= base);
      if (!continues) break;
      if (current) current.push("");
      i = j;
      continue;
    }
    const m = LIST_RE.exec(line);
    if (m && m[1].length < base + 2 && indentOf(line) >= base) {
      if (/\d/.test(m[2]) !== ordered) break;
      current = [m[3]];
      items.push(current);
      i++;
      continue;
    }
    if (current && indentOf(line) >= base + 2) {
      current.push(line.slice(Math.min(indentOf(line), base + 2)));
      i++;
      continue;
    }
    if (current && indentOf(line) < base + 2 && !startsBlock(lines, i)) {
      current.push(line.trim());
      i++;
      continue;
    }
    break;
  }

  return {
    block: {
      type: "list",
      ordered,
      start: startNumber,
      items: items.map((itemLines) => parseBlocks(itemLines)),
    },
    next: i,
  };
}

export function parseBlocks(lines) {
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[2];
      const closeRe = new RegExp(`^\\s{0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      const body = [];
      let closed = false;
      i++;
      while (i < lines.length) {
        if (closeRe.test(lines[i])) { closed = true; i++; break; }
        body.push(fence[1] ? lines[i].replace(new RegExp(`^\\s{0,${fence[1].length}}`), "") : lines[i]);
        i++;
      }
      blocks.push({ type: "code", lang: fence[3] || "", code: body.join("\n"), open: !closed });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, inline: parseInline(heading[2]) });
      i++;
      continue;
    }

    if (HR_RE.test(line)) { blocks.push({ type: "hr" }); i++; continue; }

    if (startsTable(lines, i)) {
      const header = splitRow(lines[i]);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        const cells = splitRow(lines[i]);
        while (cells.length < header.length) cells.push("");
        rows.push(cells.slice(0, header.length));
        i++;
      }
      blocks.push({
        type: "table",
        align,
        header: header.map(parseInline),
        rows: rows.map((r) => r.map(parseInline)),
      });
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner = [];
      while (i < lines.length && lines[i].trim() && (QUOTE_RE.test(lines[i]) || !startsBlock(lines, i))) {
        inner.push(lines[i].replace(QUOTE_RE, ""));
        i++;
      }
      blocks.push({ type: "quote", blocks: parseBlocks(inner) });
      continue;
    }

    if (LIST_RE.test(line)) {
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines, i))) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "paragraph", lines: para.map(parseInline) });
  }

  return blocks;
}

export function parseMarkdown(src) {
  return parseBlocks(String(src ?? "").replace(/\r\n?/g, "\n").split("\n"));
}
