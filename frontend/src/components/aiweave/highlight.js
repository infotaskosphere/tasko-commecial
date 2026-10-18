/**
 * Small, dependency-free syntax colouring for code blocks. It returns tokens
 * ({ type, text }) and never HTML, so rendering stays free of injection risk.
 */
const KEYWORDS = {
  js: "const let var function return if else for while do switch case break continue new class extends import from export default async await try catch finally throw typeof instanceof in of null undefined true false this super yield",
  py: "def class return if elif else for while in not and or is import from as with try except finally raise lambda pass break continue None True False yield async await global nonlocal assert del",
  sql: "select from where group by order having join left right inner outer full on as and or not null insert into values update set delete create table alter drop index distinct union all limit offset case when then else end like in is between exists asc desc count sum avg min max",
  sh: "if then else elif fi for while do done case esac function in echo export cd ls cat grep sed awk curl git npm pip sudo exit return",
  json: "true false null",
};
const ALIASES = {
  javascript: "js", jsx: "js", ts: "js", tsx: "js", typescript: "js", node: "js",
  python: "py", py: "py", sql: "sql", postgres: "sql", mysql: "sql", sqlite: "sql",
  bash: "sh", shell: "sh", sh: "sh", zsh: "sh", json: "json", jsonc: "json",
};

const cache = {};
function matcher(family) {
  if (cache[family]) return cache[family];
  const words = KEYWORDS[family].split(" ").join("|");
  const comment = family === "py" || family === "sh" ? "#[^\\n]*" : family === "sql" ? "--[^\\n]*" : "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$)";
  const string = "\"(?:\\\\.|[^\"\\\\\\n])*\"?|'(?:\\\\.|[^'\\\\\\n])*'?|`(?:\\\\.|[^`\\\\])*`?";
  const number = "\\b\\d[\\d_]*(?:\\.\\d+)?\\b";
  const kw = `\\b(?:${words})\\b`;
  cache[family] = new RegExp(`(${comment})|(${string})|(${number})|(${kw})`, family === "sql" ? "gi" : "g");
  return cache[family];
}

export function highlight(code, lang) {
  const family = ALIASES[String(lang || "").toLowerCase()];
  const text = String(code || "");
  if (!family || text.length > 20000) return [{ type: "plain", text }];
  const re = matcher(family);
  re.lastIndex = 0;
  const tokens = [];
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === "") { re.lastIndex++; continue; }
    if (m.index > last) tokens.push({ type: "plain", text: text.slice(last, m.index) });
    const type = m[1] ? "comment" : m[2] ? "string" : m[3] ? "number" : "keyword";
    tokens.push({ type, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ type: "plain", text: text.slice(last) });
  return tokens;
}
