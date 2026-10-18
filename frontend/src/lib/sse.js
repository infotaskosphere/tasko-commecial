/**
 * Server-sent-event framing, kept free of browser APIs so it can be tested in Node.
 *
 * Feed it the text received so far; it returns the complete events found and the
 * unfinished tail to prepend to the next read.
 */
export function parseSSE(buffer) {
  const parts = String(buffer || "").split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  const events = [];
  for (const block of parts) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) events.push(data);
  }
  return { events, rest };
}

/** Turn one event payload into an object, or null for the end marker and anything unreadable. */
export function decodeEvent(data) {
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
