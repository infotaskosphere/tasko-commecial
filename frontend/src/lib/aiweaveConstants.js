// AIWeave frontend contract constants.
// Keep these values UI-only; provider credentials and entitlement checks remain server-side.
export const PROVIDER_CATEGORIES = Object.freeze({
  FRONTIER: "frontier",
  OPEN_WEIGHTS: "open_weights",
  LOCAL: "local",
  AGENTIC: "agentic",
});

export const PROVIDERS = Object.freeze([
  { id: "gemini", name: "Google Gemini", category: PROVIDER_CATEGORIES.FRONTIER, isMandatory: true },
  { id: "openai", name: "OpenAI", category: PROVIDER_CATEGORIES.FRONTIER, isMandatory: false },
  { id: "claude", name: "Anthropic Claude", category: PROVIDER_CATEGORIES.FRONTIER, isMandatory: false },
  { id: "grok", name: "xAI Grok", category: PROVIDER_CATEGORIES.FRONTIER, isMandatory: false },
  { id: "groq", name: "Groq", category: PROVIDER_CATEGORIES.OPEN_WEIGHTS, isMandatory: false },
  { id: "ollama", name: "Ollama", category: PROVIDER_CATEGORIES.LOCAL, isMandatory: false },
]);

export const MANDATORY_PROVIDERS = Object.freeze(PROVIDERS.filter((p) => p.isMandatory).map((p) => p.id));

export const CAPABILITIES = Object.freeze([
  { id: "document_analysis", label: "Document Analysis" },
  { id: "ocr", label: "OCR" },
  { id: "vision", label: "Vision" },
  { id: "reasoning", label: "Reasoning" },
  { id: "classification", label: "Classification" },
]);

export const ACCOUNT_STATUS = Object.freeze({
  CONNECTED: "connected",
  CAPACITY_EXHAUSTED: "capacity_exhausted",
  RATE_LIMITED: "rate_limited",
  DISABLED: "disabled",
  ERROR: "error",
  PENDING: "pending",
});

export const HEALTH_STATE = Object.freeze({
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  UNHEALTHY: "unhealthy",
  UNKNOWN: "unknown",
});

export const ROUTING_STRATEGIES = Object.freeze([
  { id: "priority_first", label: "Priority First", description: "Use the highest-priority healthy account first." },
  { id: "weighted", label: "Weighted", description: "Distribute requests using configured account weights." },
  { id: "round_robin", label: "Round Robin", description: "Rotate requests across eligible accounts." },
  { id: "cost_optimized", label: "Cost Optimized", description: "Prefer eligible providers with the lowest configured cost." },
]);

export const COST_POLICIES = Object.freeze([
  { id: "balanced", label: "Balanced", description: "Balance reliability, latency and cost." },
  { id: "lowest_cost", label: "Lowest Cost", description: "Prefer the lowest configured provider cost." },
  { id: "performance", label: "Performance First", description: "Prefer provider performance over cost." },
]);
