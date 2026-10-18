import React, { memo, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { parseMarkdown } from "./markdownParser";
import { highlight } from "./highlight";

const TOKEN_CLASS = {
  comment: "text-slate-500 italic",
  string: "text-emerald-300",
  number: "text-amber-300",
  keyword: "text-sky-300",
  plain: "",
};

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({ text, label = "Copy", className = "" }) {
  const [done, setDone] = useState(false);
  const onClick = async () => {
    if (await copyText(text)) {
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${className}`}
      aria-label={done ? "Copied" : label}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
      {done ? "Copied" : label}
    </button>
  );
}

function Inline({ nodes }) {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text": return <React.Fragment key={i}>{n.v}</React.Fragment>;
      case "code": return <code key={i} className="aw-inline-code">{n.v}</code>;
      case "strong": return <strong key={i} className="font-semibold"><Inline nodes={n.c} /></strong>;
      case "em": return <em key={i}><Inline nodes={n.c} /></em>;
      case "del": return <del key={i} className="opacity-70"><Inline nodes={n.c} /></del>;
      case "link":
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow" className="aw-link">
            <Inline nodes={n.c} />
          </a>
        );
      default: return null;
    }
  });
}

function CodeBlock({ block }) {
  const tokens = useMemo(() => highlight(block.code, block.lang), [block.code, block.lang]);
  return (
    <figure className="aw-code my-4 overflow-hidden rounded-xl border border-slate-800 bg-[#0B1220] text-slate-100">
      <figcaption className="flex items-center justify-between border-b border-white/10 bg-white/[0.04] px-3 py-1.5">
        <span className="font-mono text-xs text-slate-400">{block.lang || "text"}</span>
        {block.open
          ? <span className="text-xs text-teal-300 motion-safe:animate-pulse">writing…</span>
          : <CopyButton text={block.code} className="text-slate-300 hover:bg-white/10 hover:text-white" />}
      </figcaption>
      <pre className="overflow-x-auto p-4 text-[13px] leading-6"><code className="font-mono">
        {tokens.map((t, i) => (t.type === "plain" ? t.text : <span key={i} className={TOKEN_CLASS[t.type]}>{t.text}</span>))}
      </code></pre>
    </figure>
  );
}

const HEADING_CLASS = {
  1: "mb-3 mt-6 text-xl font-semibold tracking-tight",
  2: "mb-2.5 mt-6 text-lg font-semibold tracking-tight",
  3: "mb-2 mt-5 text-base font-semibold",
  4: "mb-2 mt-4 text-[15px] font-semibold",
  5: "mb-1.5 mt-4 text-sm font-semibold",
  6: "mb-1.5 mt-4 text-sm font-semibold opacity-80",
};

function Caret() {
  return <span className="aw-caret" aria-hidden="true" />;
}

function Blocks({ blocks, caret, tight = false }) {
  return blocks.map((b, i) => {
    const last = caret && i === blocks.length - 1;
    switch (b.type) {
      case "paragraph":
        return (
          <p key={i} className={tight ? "" : "my-3 first:mt-0 last:mb-0"}>
            {b.lines.map((line, n) => (
              <React.Fragment key={n}>
                {n > 0 && <br />}
                <Inline nodes={line} />
              </React.Fragment>
            ))}
            {last && <Caret />}
          </p>
        );
      case "heading": {
        const Tag = `h${Math.min(b.level, 6)}`;
        return <Tag key={i} className={HEADING_CLASS[b.level]}><Inline nodes={b.inline} />{last && <Caret />}</Tag>;
      }
      case "code":
        return <CodeBlock key={i} block={b} />;
      case "hr":
        return <hr key={i} className="my-5 border-slate-200 dark:border-slate-700" />;
      case "quote":
        return (
          <blockquote key={i} className="my-3 border-l-2 border-teal-500/60 pl-4 text-slate-600 dark:text-slate-300">
            <Blocks blocks={b.blocks} caret={last} />
          </blockquote>
        );
      case "list": {
        const Tag = b.ordered ? "ol" : "ul";
        return (
          <Tag
            key={i}
            start={b.ordered && b.start !== 1 ? b.start : undefined}
            className={`my-3 space-y-1.5 pl-6 ${b.ordered ? "list-decimal" : "list-disc"} marker:text-slate-400`}
          >
            {b.items.map((item, n) => {
              const onlyText = item.length === 1 && item[0].type === "paragraph";
              return (
                <li key={n} className="pl-1">
                  <Blocks blocks={item} tight={onlyText} caret={last && n === b.items.length - 1} />
                </li>
              );
            })}
          </Tag>
        );
      }
      case "table":
        return (
          <div key={i} className="my-4 overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/60">
                <tr>
                  {b.header.map((cell, n) => (
                    <th key={n} style={{ textAlign: b.align[n] || "left" }} className="whitespace-nowrap border-b border-slate-200 px-3 py-2 font-semibold dark:border-slate-700">
                      <Inline nodes={cell} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                    {row.map((cell, n) => (
                      <td key={n} style={{ textAlign: b.align[n] || "left" }} className="px-3 py-2 align-top tabular-nums">
                        <Inline nodes={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      default:
        return null;
    }
  });
}

/**
 * Renders model output. `streaming` shows a caret at the end of the text while the answer is still arriving.
 */
function Markdown({ text, streaming = false }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const endsInText = streaming && blocks.length > 0 && ["paragraph", "heading", "list", "quote"].includes(blocks[blocks.length - 1].type);
  return (
    <div className="aw-prose break-words text-[15px] leading-7">
      <Blocks blocks={blocks} caret={endsInText} />
      {streaming && !endsInText && <Caret />}
    </div>
  );
}

export default memo(Markdown);
