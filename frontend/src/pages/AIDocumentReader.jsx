import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Menu, PanelRight, Plus } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";
import {
  listProviders, listAccounts, getModels, getRoutingConfig, getExecutionHistory, executeTask, streamOmni,
  getStats, listConversations, createConversation, getConversation, deleteConversation,
} from "@/lib/aiweaveApi";
import { pname } from "@/components/aiweave/shared";
import {
  SYSTEM_INSTRUCTION, buildContext, describeFailure, fromStored, normaliseTrail, titleFrom,
} from "@/components/aiweave/chatModel";
import MessageView from "@/components/aiweave/MessageView";
import Composer from "@/components/aiweave/Composer";
import EmptyState from "@/components/aiweave/EmptyState";
import ModelPicker from "@/components/aiweave/ModelPicker";
import HistoryRail from "@/components/aiweave/HistoryRail";
import Inspector from "@/components/aiweave/Inspector";
import SettingsDrawer from "@/components/aiweave/SettingsDrawer";
import WeaveMark from "@/components/aiweave/WeaveMark";
import useShellFit from "@/components/aiweave/useShellFit";
import useElementWidth, { INSPECTOR_DOCK_AT, RAIL_DOCK_AT } from "@/components/aiweave/useElementWidth";
import "@/components/aiweave/aiweave.css";

const MAX_ATTACHMENTS = 10;
const nid = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const convId = (c) => c?.id || c?.conversation_id || null;

export default function AIDocumentReader() {
  // layout
  const rootRef = useRef(null);
  useShellFit(rootRef);
  const width = useElementWidth(rootRef);
  const railDocked = width >= RAIL_DOCK_AT;
  const inspectorDocked = width >= INSPECTOR_DOCK_AT;
  const [rail, setRail] = useState(false);              // history as a sheet over the page (narrow)
  const [inspectorOpen, setInspectorOpen] = useState(true);  // details beside the chat (wide)
  const [inspectorSheet, setInspectorSheet] = useState(false); // details as a sheet over the page (narrow)
  const [settings, setSettings] = useState(false);
  const [tab, setTab] = useState("providers");
  const [search, setSearch] = useState("");

  // conversation
  const [messages, setMessages] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [active, setActive] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");

  // routing choices
  const [provider, setProvider] = useState("auto");
  const [selectedModel, setSelectedModel] = useState("auto");
  const [mode, setMode] = useState("chat");

  // platform data (read-only for customers)
  const [providers, setProviders] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [models, setModels] = useState([]);
  const [routing, setRouting] = useState(null);
  const [executions, setExecutions] = useState([]);
  const [stats, setStats] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [auditSearch, setAuditSearch] = useState("");

  // document workspace (settings drawer)
  const [docFiles, setDocFiles] = useState([]);
  const [docQuestion, setDocQuestion] = useState("");
  const [docAnswer, setDocAnswer] = useState("");
  const [docBusy, setDocBusy] = useState(false);
  const docRef = useRef(null);

  // streaming plumbing
  const scroller = useRef(null);
  const inputRef = useRef(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const abortRef = useRef(null);
  const frame = useRef(0);
  const live = useRef({ id: null, content: "", reasoning: "" });
  const docContext = useRef("");

  const connected = useMemo(() => providers.filter((p) => p.connectedCount > 0), [providers]);
  const visibleModels = useMemo(
    () => models.filter((x) => !modelSearch || `${x.name} ${x.id} ${x.provider}`.toLowerCase().includes(modelSearch.toLowerCase())),
    [models, modelSearch]
  );
  const visibleExec = useMemo(
    () => executions.filter((x) => !auditSearch || `${x.prompt} ${x.providerName} ${x.accountName} ${x.model}`.toLowerCase().includes(auditSearch.toLowerCase())),
    [executions, auditSearch]
  );

  const refreshActivity = useCallback(async () => {
    try {
      const [e, s, c] = await Promise.all([getExecutionHistory(), getStats(), listConversations()]);
      setExecutions(e || []); setStats(s || null); setConversations(c || []);
    } catch (err) { console.warn("AIWeave activity refresh failed", err); }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [p, a, m, r, e, s, c] = await Promise.all([listProviders(), listAccounts(), getModels(), getRoutingConfig(), getExecutionHistory(), getStats(), listConversations()]);
        setProviders(p || []); setAccounts(a || []); setModels(m || []); setRouting(r || null);
        setExecutions(e || []); setStats(s || null); setConversations(c || []);
      } catch (err) { console.warn("AIWeave load failed", err); }
      setLoaded(true);
    })();
    return () => { abortRef.current?.abort(); if (frame.current) cancelAnimationFrame(frame.current); };
  }, []);

  // keep the newest text in view unless the reader scrolled up to read
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // An empty chat starts at its top; scrolling it to the bottom hides the heading on short windows.
    if (!messages.length) { el.scrollTop = 0; pinned.current = true; return; }
    if (pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    pinned.current = atBottom;
    setShowJump(!atBottom);
  };
  const jump = () => { const el = scroller.current; if (el) { pinned.current = true; el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); } };

  const patch = useCallback((id, change) => {
    setMessages((list) => list.map((m) => (m.id === id ? { ...m, ...(typeof change === "function" ? change(m) : change) } : m)));
  }, []);

  const scheduleFlush = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const { id, content, reasoning } = live.current;
      patch(id, { content, reasoning });
    });
  };
  const flushNow = () => {
    if (frame.current) { cancelAnimationFrame(frame.current); frame.current = 0; }
    const { id, content, reasoning } = live.current;
    if (id) patch(id, { content, reasoning });
  };

  const newChat = () => {
    if (running) return;
    setActive(null); setMessages([]); setPrompt(""); setFiles([]); setStatus(""); setSelectedId(null);
    docContext.current = ""; setRail(false);
    inputRef.current?.focus();
  };

  const openChat = async (id) => {
    if (running) return;
    try {
      const c = await getConversation(id);
      setActive(c); setMessages((c.messages || []).map(fromStored)); setStatus(""); setSelectedId(null);
      docContext.current = ""; pinned.current = true; setRail(false);
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not open that conversation."); }
  };

  const removeChat = async (id, title, e) => {
    e?.stopPropagation();
    if (!id || !window.confirm(`Delete "${title || "this conversation"}"? This cannot be undone.`)) return;
    try {
      await deleteConversation(id);
      if (convId(active) === id) newChat();
      await refreshActivity();
      toast.success("Conversation deleted.");
    } catch (err) { toast.error(err?.response?.data?.detail || "Could not delete that conversation."); }
  };

  const attach = (list) => {
    const incoming = Array.from(list || []);
    if (!incoming.length) return;
    setFiles((x) => {
      if (x.length + incoming.length > MAX_ATTACHMENTS) toast.warning(`You can attach up to ${MAX_ATTACHMENTS} documents per message.`);
      return [...x, ...incoming].slice(0, MAX_ATTACHMENTS);
    });
  };

  const readDocuments = async (attached) => {
    setStatus(`Reading ${attached.length} document${attached.length === 1 ? "" : "s"}…`);
    const form = new FormData();
    attached.forEach((f) => form.append("files", f));
    const response = await api.post("/ai/workspace/analyze-documents", form, { headers: { "Content-Type": "multipart/form-data" }, timeout: 600000 });
    const data = response?.data || {};
    const results = Array.isArray(data.results) ? data.results : [];
    const errors = Array.isArray(data.errors) ? data.errors : [];
    if (!results.length) {
      const detail = errors.map((x) => (x?.filename ? `${x.filename}: ${x.error || "could not be processed"}` : x?.error)).filter(Boolean).join(" | ");
      throw new Error(detail || "The uploaded documents could not be read.");
    }
    if (errors.length) toast.warning(`${errors.length} document${errors.length === 1 ? "" : "s"} could not be processed.`);
    const text = results
      .map((x) => `DOCUMENT: ${x?.filename || "Uploaded document"}\nDOCUMENT TYPE: ${x?.document_type || "Unknown"}\nEXTRACTED ANALYSIS:\n${String(x?.analysis || "").trim().slice(0, 14000)}`)
      .join("\n\n--- DOCUMENT BOUNDARY ---\n\n");
    // later questions in this chat keep the same evidence
    docContext.current = [docContext.current, text].filter(Boolean).join("\n\n--- DOCUMENT BOUNDARY ---\n\n").slice(-60000);
  };

  /** Runs one turn. `base` is the conversation up to and including the user's message. */
  const runTurn = async (text, attached, base) => {
    const assistantId = nid("a");
    live.current = { id: assistantId, content: "", reasoning: "" };
    const placeholder = { id: assistantId, role: "assistant", content: "", reasoning: "", status: "pending", meta: {}, created_at: new Date().toISOString() };
    setMessages([...base, placeholder]);
    setSelectedId(null); pinned.current = true; setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;
    const acc = { trail: [], meta: {}, done: false, error: null, started: false };

    let conv = active;
    try {
      if (!conv) {
        conv = await createConversation({ title: titleFrom(text) });
        setActive(conv);
      }
      if (attached.length) {
        await readDocuments(attached);
        setFiles([]);
      }

      setStatus(selectedModel === "auto" ? "Choosing the best available model…" : `Using ${selectedModel}…`);
      const payload = {
        prompt: text,
        messages: buildContext(base),
        conversation_id: convId(conv),
        task_type: mode,
        required_capability: docContext.current ? "document_analysis" : mode,
        provider,
        model: selectedModel,
        document_context: docContext.current || undefined,
        files: attached.map((f) => ({ name: f.name, type: f.type, size: f.size })),
        user_preferences: { system_instruction: SYSTEM_INSTRUCTION },
      };

      await streamOmni(payload, {
        signal: controller.signal,
        onChunk: (c) => {
          switch (c.event) {
            case "start":
              acc.started = true;
              acc.meta = { ...acc.meta, provider: c.provider, providerName: pname(c.provider), modelName: c.model };
              patch(assistantId, (m) => ({ status: "streaming", meta: { ...m.meta, ...acc.meta, fallbackTrail: acc.trail } }));
              setStatus(`${pname(c.provider)} is answering…`);
              break;
            case "chunk":
              live.current.content += c.delta || "";
              scheduleFlush();
              break;
            case "reasoning":
              live.current.reasoning += c.reasoning_delta || "";
              scheduleFlush();
              break;
            case "fallback":
              acc.trail = [...acc.trail, { provider: c.metadata?.from_provider, model: c.metadata?.from_model, status: "FAILED", reason: c.metadata?.reason }];
              patch(assistantId, (m) => ({ meta: { ...m.meta, fallbackTrail: acc.trail }, note: "That model was busy. Trying another…" }));
              setStatus("That model was busy. Trying another…");
              break;
            case "done": {
              acc.done = true;
              const md = c.metadata || {};
              acc.meta = {
                ...acc.meta,
                provider: c.provider || acc.meta.provider,
                providerName: pname(c.provider || acc.meta.provider),
                modelName: md.model_name || c.model || acc.meta.modelName,
                accountName: md.account_name,
                latencyMs: md.latency_ms,
                tokens: c.usage?.total_tokens || null,
                executionId: md.execution_id,
                fallbackTrail: normaliseTrail(md.fallback_trail?.length ? md.fallback_trail : acc.trail),
              };
              break;
            }
            case "error":
              acc.error = c.error?.message || "The answer was interrupted.";
              break;
            default: break;
          }
        },
      });

      flushNow();
      if (acc.error && !live.current.content) throw Object.assign(new Error(acc.error), { status: 503 });
      if (!acc.done && !acc.error && !live.current.content) throw new Error("The model returned no answer. Try again.");
      patch(assistantId, {
        status: acc.done ? "done" : "error",
        error: acc.done ? undefined : `${acc.error || "The answer was interrupted."} The text above is incomplete and was not saved.`,
        meta: acc.meta,
        note: undefined,
      });
      if (acc.done) {
        setSelectedId(assistantId);
        setStatus(acc.trail.length ? `Answered after switching ${acc.trail.length} time${acc.trail.length === 1 ? "" : "s"}.` : `Answered by ${acc.meta.providerName}.`);
      } else {
        setStatus("The answer was interrupted.");
      }
      setFiles([]);
    } catch (err) {
      flushNow();
      if (err?.name === "AbortError") {
        patch(assistantId, { status: "stopped", note: undefined });
        setStatus("Stopped.");
      } else if ((err?.status === 404 || err?.status === 501) && !acc.started) {
        // the streaming route is missing on an older server: use the classic one-shot route
        try {
          const r = await executeTask({
            prompt: text, messages: buildContext(base), conversationId: convId(conv), taskType: mode,
            requiredCapability: docContext.current ? "document_analysis" : mode, preferredProvider: provider,
            preferredModel: selectedModel, documentContext: docContext.current,
          });
          patch(assistantId, {
            content: r.output || "", status: "done", note: undefined,
            meta: { providerName: r.providerName, modelName: r.modelName || r.model, accountName: r.accountName, fallbackTrail: normaliseTrail(r.fallbackTrail), tokens: r.tokens, latencyMs: r.latencyMs },
          });
          setSelectedId(assistantId); setFiles([]);
        } catch (legacy) {
          const message = describeFailure(legacy);
          patch(assistantId, { status: "error", error: message, note: undefined }); setStatus(message);
        }
      } else {
        const message = describeFailure(err);
        patch(assistantId, { status: "error", error: message, note: undefined });
        setStatus(message);
        if (err?.status === 429) toast.warning(message);
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
      refreshActivity();
    }
  };

  const send = (override) => {
    const text = String(override ?? prompt).trim();
    if (!text || running) return;
    const attached = override ? [] : [...files];
    const user = { id: nid("u"), role: "user", content: text, status: "done", created_at: new Date().toISOString(), attachments: attached.map((f) => ({ name: f.name })) };
    setPrompt("");
    runTurn(text, attached, [...messages, user]);
  };

  const regenerate = () => {
    if (running) return;
    let at = messages.length - 1;
    while (at >= 0 && messages[at].role !== "user") at--;
    if (at < 0) return;
    runTurn(messages[at].content, [], messages.slice(0, at + 1));
  };

  const stop = () => abortRef.current?.abort();

  const pickStarter = (s) => {
    setPrompt(s.text); setMode(s.mode);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const analyzeDocs = async () => {
    if (!docFiles.length || docBusy) return;
    setDocBusy(true);
    try {
      const f = new FormData(); docFiles.forEach((x) => f.append("files", x));
      const { data } = await api.post("/ai/workspace/analyze-documents", f, { headers: { "Content-Type": "multipart/form-data" }, timeout: 600000 });
      setDocAnswer((data?.results || []).map((x) => `### ${x.filename}\n${x.analysis || "Analysis completed."}`).join("\n\n") || "No analysis returned.");
      toast.success("Document analysis completed.");
    } catch (e) { setDocAnswer(e?.response?.data?.detail || "Server-side document analysis is unavailable."); toast.error("Document analysis failed."); }
    finally { setDocBusy(false); }
  };
  const askDocs = async () => {
    if (!docQuestion.trim()) return;
    setDocBusy(true);
    try {
      const { data } = await api.post("/ai/workspace/query", { question: docQuestion.trim() }, { timeout: 180000 });
      setDocAnswer(data?.answer || "No answer returned.");
    } catch (e) { setDocAnswer(e?.response?.data?.detail || "AIWeave could not query document memory."); }
    finally { setDocBusy(false); }
  };

  const lastIndex = messages.length - 1;
  const selected = messages.find((m) => m.id === selectedId) || [...messages].reverse().find((m) => m.role === "assistant" && m.status === "done") || null;
  const activeId = convId(active);

  return (
    <div ref={rootRef} className="aw-root relative flex min-w-0 overflow-hidden">
      {/* history: a fixed column when there is room, a sheet over the page when there is not */}
      {railDocked && (
        <div className="w-[272px] shrink-0">
          <HistoryRail conversations={conversations} activeId={activeId} search={search} onSearch={setSearch} onOpen={openChat} onDelete={removeChat} onNew={newChat} onSettings={() => setSettings(true)} stats={stats} providerCount={connected.length} />
        </div>
      )}
      {!railDocked && rail && (
        <div className="absolute inset-0 z-30 flex">
          <div className="w-[min(20rem,86%)] shadow-xl">
            <HistoryRail conversations={conversations} activeId={activeId} search={search} onSearch={setSearch} onOpen={(id) => { setRail(false); openChat(id); }} onDelete={removeChat} onNew={() => { setRail(false); newChat(); }} onSettings={() => { setRail(false); setSettings(true); }} onClose={() => setRail(false)} stats={stats} providerCount={connected.length} />
          </div>
          <button type="button" className="aw-sheet-scrim flex-1" aria-label="Close history" onClick={() => setRail(false)} />
        </div>
      )}

      <div className="aw-canvas flex min-w-0 flex-1 flex-col">
        <div className="aw-topbar flex h-14 shrink-0 items-center justify-between gap-3 px-3 tablet:px-5">
          <div className="flex min-w-0 items-center gap-2">
            {!railDocked && (
              <button type="button" onClick={() => setRail(true)} aria-label="Open chat history" className="aw-iconbtn shrink-0"><Menu size={18} /></button>
            )}
            <WeaveMark size={22} className="shrink-0" />
            {(active?.title && messages.length) || width >= 520 ? (
              <h1 className="truncate text-base font-semibold">{active?.title && messages.length ? active.title : "AIWeave"}</h1>
            ) : <h1 className="sr-only">AIWeave</h1>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ModelPicker connected={connected} models={models} provider={provider} model={selectedModel} onChange={(p, m) => { setProvider(p); setSelectedModel(m); }} />
            {!railDocked && (
              <button type="button" onClick={newChat} disabled={running} aria-label="New chat" className="aw-iconbtn"><Plus size={18} /></button>
            )}
            <button
              type="button"
              onClick={() => (inspectorDocked ? setInspectorOpen((v) => !v) : setInspectorSheet((v) => !v))}
              aria-label="Toggle answer details"
              aria-pressed={inspectorDocked ? inspectorOpen : inspectorSheet}
              className="aw-iconbtn"
            ><PanelRight size={18} /></button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
          <div ref={scroller} onScroll={onScroll} className="aw-scroll h-full overflow-y-auto px-3 tablet:px-6">
            {messages.length === 0 ? (
              <EmptyState ready={!loaded || connected.length > 0} providerCount={connected.length} onPick={pickStarter} />
            ) : (
              <div className="mx-auto w-full max-w-3xl space-y-8 py-8">
                {messages.map((m, i) => (
                  <MessageView
                    key={m.id}
                    m={m}
                    isLast={i === lastIndex}
                    busy={running}
                    selected={m.id === selected?.id}
                    onSelect={() => setSelectedId(m.id)}
                    onRegenerate={regenerate}
                  />
                ))}
              </div>
            )}
          </div>
          {showJump && running && (
            <button type="button" onClick={jump} className="aw-surface absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs shadow-md">
              <ArrowDown size={13} />Jump to latest
            </button>
          )}
        </div>

        <div className="shrink-0 px-3 pb-3 pt-2 tablet:px-6">
          <div className="mx-auto w-full max-w-3xl">
            <Composer
              value={prompt} onChange={setPrompt} onSend={() => send()} onStop={stop} running={running}
              files={files} onFiles={attach} onRemoveFile={(i) => setFiles((x) => x.filter((_, n) => n !== i))}
              mode={mode} onMode={setMode} status={status} inputRef={inputRef}
            />
            <p className="mt-2 px-1 text-center text-xs aw-muted">AI can make mistakes. Check figures, dates and section numbers before you rely on them.</p>
          </div>
        </div>
      </div>

      {inspectorDocked && inspectorOpen && <div className="w-[288px] shrink-0"><Inspector message={selected} stats={stats} /></div>}
      {!inspectorDocked && inspectorSheet && (
        <div className="absolute inset-0 z-30 flex justify-end">
          <button type="button" className="aw-sheet-scrim flex-1" aria-label="Close answer details" onClick={() => setInspectorSheet(false)} />
          <div className="w-[min(20rem,86%)] shadow-xl"><Inspector message={selected} stats={stats} /></div>
        </div>
      )}

      <SettingsDrawer
        settings={settings} setSettings={setSettings} tab={tab} setTab={setTab}
        providers={providers} accounts={accounts} models={models} routing={routing} provider={provider}
        modelSearch={modelSearch} setModelSearch={setModelSearch} auditSearch={auditSearch} setAuditSearch={setAuditSearch}
        visibleModels={visibleModels} visibleExec={visibleExec}
        docFiles={docFiles} setDocFiles={setDocFiles} docQuestion={docQuestion} setDocQuestion={setDocQuestion}
        docAnswer={docAnswer} docBusy={docBusy} docRef={docRef} analyzeDocs={analyzeDocs} askDocs={askDocs}
      />
    </div>
  );
}
