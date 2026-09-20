/**
 * AIWeave provider/capability/model registry.
 * Provider availability is server-authoritative; these are UI metadata only.
 */
export const PROVIDER_CATEGORIES = {
  FRONTIER: "Frontier Commercial",
  OPEN_WEIGHTS: "Open Weights & Fast Inference",
  LOCAL: "Local Inference",
  AGENTIC: "Autonomous Agent Platforms",
  AGGREGATOR: "Model Aggregators & Gateways",
};

const p = (id, name, category, extra = {}) => ({
  id, name, shortName: name.replace(" / ChatGPT","").replace("Anthropic ",""),
  category, supportsModelDiscovery: true, supportsStreaming: true,
  supportsTools: true, supportsMultiAccount: true, ...extra,
});

export const MANDATORY_PROVIDERS = ["openai", "gemini", "claude", "grok"];

export const PROVIDERS = [
  p("openai","OpenAI / ChatGPT",PROVIDER_CATEGORIES.FRONTIER,{isMandatory:true,docsUrl:"https://platform.openai.com/docs"}),
  p("gemini","Google Gemini",PROVIDER_CATEGORIES.FRONTIER,{isMandatory:true,docsUrl:"https://ai.google.dev/docs"}),
  p("claude","Anthropic Claude",PROVIDER_CATEGORIES.FRONTIER,{isMandatory:true,docsUrl:"https://docs.anthropic.com"}),
  p("grok","xAI Grok",PROVIDER_CATEGORIES.FRONTIER,{isMandatory:true,docsUrl:"https://docs.x.ai"}),
  p("kimi","Moonshot AI / Kimi",PROVIDER_CATEGORIES.FRONTIER,{docsUrl:"https://platform.moonshot.cn"}),
  p("deepseek","DeepSeek",PROVIDER_CATEGORIES.OPEN_WEIGHTS,{docsUrl:"https://api-docs.deepseek.com"}),
  p("qwen","Alibaba Qwen",PROVIDER_CATEGORIES.OPEN_WEIGHTS,{docsUrl:"https://help.aliyun.com"}),
  p("mistral","Mistral AI",PROVIDER_CATEGORIES.OPEN_WEIGHTS,{docsUrl:"https://docs.mistral.ai"}),
  p("llama","Meta Llama",PROVIDER_CATEGORIES.OPEN_WEIGHTS,{supportsModelDiscovery:false,docsUrl:"https://llama.meta.com"}),
  p("groq","Groq LPU",PROVIDER_CATEGORIES.OPEN_WEIGHTS,{docsUrl:"https://console.groq.com/docs"}),
  p("openrouter","OpenRouter",PROVIDER_CATEGORIES.AGGREGATOR,{docsUrl:"https://openrouter.ai/docs"}),
  p("together","Together AI",PROVIDER_CATEGORIES.AGGREGATOR,{docsUrl:"https://docs.together.ai"}),
  p("ollama","Ollama (Local)",PROVIDER_CATEGORIES.LOCAL,{isLocal:true,docsUrl:"https://ollama.com"}),
  p("replit","Replit Agent",PROVIDER_CATEGORIES.AGENTIC,{supportsModelDiscovery:false,docsUrl:"https://docs.replit.com"}),
  p("lovable","Lovable",PROVIDER_CATEGORIES.AGENTIC,{supportsModelDiscovery:false,docsUrl:"https://docs.lovable.dev"}),
  p("mulerun","MuleRun",PROVIDER_CATEGORIES.AGENTIC,{supportsModelDiscovery:false,docsUrl:"https://mulerun.ai"}),
];

export const CAPABILITIES = [
  {id:"chat",label:"General Chat & Conversation",icon:"MessageSquare"},
  {id:"reasoning",label:"Complex Reasoning",icon:"Brain"},
  {id:"coding",label:"Code Generation",icon:"Code"},
  {id:"debugging",label:"Debugging & Diagnostics",icon:"Bug"},
  {id:"vision",label:"Vision & Image Understanding",icon:"Eye"},
  {id:"document_analysis",label:"Document Intelligence",icon:"FileText"},
  {id:"image_generation",label:"Image Generation",icon:"Image"},
  {id:"tool_calling",label:"Function / Tool Calling",icon:"Wrench"},
  {id:"agent_execution",label:"Autonomous Agent Execution",icon:"Bot"},
  {id:"long_context",label:"Long Context",icon:"Layers"},
  {id:"structured_output",label:"Strict JSON / Schema",icon:"CheckSquare"},
];

export const ACCOUNT_STATUS = {
  CONNECTED:"CONNECTED", DISCONNECTED:"DISCONNECTED", DISABLED:"DISABLED",
  AUTH_REQUIRED:"AUTH_REQUIRED", UNHEALTHY:"UNHEALTHY", RATE_LIMITED:"RATE_LIMITED",
  CAPACITY_EXHAUSTED:"CAPACITY_EXHAUSTED", ERROR:"ERROR", PENDING:"PENDING",
};
export const HEALTH_STATE = {HEALTHY:"HEALTHY",DEGRADED:"DEGRADED",UNHEALTHY:"UNHEALTHY",UNKNOWN:"UNKNOWN"};

export const ROUTING_STRATEGIES = [
  {id:"PRIORITY",label:"Priority First",description:"Highest-priority eligible account first."},
  {id:"ROUND_ROBIN",label:"Round Robin",description:"Rotate eligible accounts."},
  {id:"LEAST_USED",label:"Least Used",description:"Prefer the lowest tracked usage."},
  {id:"HEALTH_FIRST",label:"Health & Latency First",description:"Prefer healthy accounts."},
  {id:"WEIGHTED",label:"Weighted Distribution",description:"Use configured account weights."},
  {id:"CUSTOM",label:"Custom Rule Policy",description:"Administrator-defined routing."},
];
export const COST_POLICIES = [
  {id:"FREE_FIRST",label:"Free / Low-Cost First",description:"Prefer legitimate free/low-cost options when capable."},
  {id:"LOWEST_COST",label:"Lowest Cost",description:"Prefer the lowest configured cost."},
  {id:"BALANCED",label:"Balanced Quality & Cost",description:"Balance capability, reliability and cost."},
  {id:"PERFORMANCE_FIRST",label:"Maximum Performance",description:"Prefer configured performance."},
  {id:"ADMIN_CUSTOM",label:"Administrator Custom",description:"Use administrator-defined policy."},
];
export const FAILURE_CLASSIFICATIONS = {
  RETRYABLE_ACCOUNT_FAILURE:"Account-level transient failure",
  CAPACITY_EXHAUSTED:"Provider-reported capacity/quota exhaustion",
  RATE_LIMITED:"Provider rate limit",
  AUTH_REQUIRED:"Authentication required",
  NON_RETRYABLE_ACCOUNT_FAILURE:"Non-retryable account error",
  PROVIDER_UNAVAILABLE:"Provider unavailable",
  MODEL_UNAVAILABLE:"Model unavailable",
  INVALID_REQUEST:"Invalid request",
  PERMISSION_DENIED:"Permission denied",
  NETWORK_FAILURE:"Network failure",
  TIMEOUT:"Timeout",
};

export const INITIAL_MODELS = [
  ["gpt-5.6-sol","openai","GPT-5.6 Sol",["chat","reasoning","coding","debugging","vision","document_analysis","tool_calling","structured_output"]],
  ["gpt-5.6-terra","openai","GPT-5.6 Terra",["chat","reasoning","coding","debugging","vision","document_analysis","tool_calling","structured_output"]],
  ["gpt-5.6-luna","openai","GPT-5.6 Luna",["chat","coding","vision","document_analysis","structured_output"]],
  ["gemini-3.8-flash","gemini","Gemini 3.8 Flash",["chat","reasoning","coding","vision","document_analysis","tool_calling","long_context","structured_output"]],
  ["gemini-3.1-pro-preview","gemini","Gemini 3.1 Pro",["chat","reasoning","coding","vision","document_analysis","tool_calling","agent_execution","long_context","structured_output"]],
  ["gemini-2.5-flash","gemini","Gemini 2.5 Flash",["chat","reasoning","coding","vision","document_analysis","tool_calling","long_context","structured_output"]],
  ["claude-opus-5","claude","Claude Opus 5",["chat","reasoning","coding","debugging","vision","document_analysis","tool_calling","agent_execution","long_context","structured_output"]],
  ["claude-sonnet-5","claude","Claude Sonnet 5",["chat","reasoning","coding","debugging","vision","document_analysis","tool_calling","structured_output"]],
  ["grok-4.6","grok","Grok 4.6",["chat","reasoning","coding","vision","tool_calling","agent_execution","structured_output"]],
  ["deepseek-reasoner","deepseek","DeepSeek Reasoner",["reasoning","coding","debugging","structured_output"]],
  ["deepseek-chat","deepseek","DeepSeek Chat",["chat","coding","tool_calling","structured_output"]],
  ["qwen-plus","qwen","Qwen Plus",["chat","reasoning","coding","document_analysis","structured_output"]],
  ["mistral-large-latest","mistral","Mistral Large",["chat","reasoning","coding","document_analysis","tool_calling","structured_output"]],
  ["llama-3.3-70b","llama","Llama 3.3 70B",["chat","reasoning","coding","document_analysis","structured_output"]],
  ["llama-3.3-70b-versatile","groq","Llama 3.3 70B Versatile",["chat","reasoning","coding","document_analysis","tool_calling","structured_output"]],
  ["openrouter/auto","openrouter","OpenRouter Auto",["chat","reasoning","coding","vision","document_analysis","tool_calling"]],
  ["qwen2.5-coder:32b","ollama","Qwen 2.5 Coder 32B (Local)",["coding","debugging","tool_calling","structured_output"],true],
  ["llama3.3:70b","ollama","Llama 3.3 70B (Local)",["chat","reasoning","coding","document_analysis","structured_output"],true],
].map(([id,provider,name,capabilities,isLocal=false])=>({id,provider,name,capabilities,isLocal,isFree:!!isLocal}));

export const AIWEAVE_DEFAULT_ROUTING = {
  strategy:"PRIORITY",preferredProvider:"auto",preferredModel:"auto",costPolicy:"FREE_FIRST",
  allowLocalFallback:true,maxAccountAttempts:3,maxProviderAttempts:3,maxTotalAttempts:5,
  retryOnRateLimit:true,retryOnCapacityExhausted:true,timeoutMs:60000,companyIsolationEnabled:true,
};
