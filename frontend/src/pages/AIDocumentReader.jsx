import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowUp, Bot, ChevronDown, ChevronLeft, ChevronRight, Copy,
  FileText, History, Menu, MessageSquare, Paperclip, Plus, Settings, Sparkles,
  Square, Trash2, Upload, X
} from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";
import {
  listProviders, listAccounts, getModels, getRoutingConfig, updateRoutingConfig,
  getExecutionHistory, executeTask, getStats, listConversations,
  createConversation, getConversation
} from "@/lib/aiweaveApi";
import { PROVIDERS, CAPABILITIES, ROUTING_STRATEGIES, COST_POLICIES } from "@/lib/aiweaveConstants";

const ACCEPTED = ".pdf,.xlsx,.xls,.xlsm,.csv,.jpg,.jpeg,.png,.webp,.gif";
const MAX_DOCS = 25;

const pname = (id) => PROVIDERS.find((p) => p.id === id)?.shortName || PROVIDERS.find((p) => p.id === id)?.name || id || "AI";
const fmt = (v) => { try { return v ? new Date(v).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) : ""; } catch { return ""; } };

function Bubble({children, tone=""}) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium ${tone}`}>{children}</span>;
}
function Text({value}) {
  return <div className="whitespace-pre-wrap break-words text-[15px] leading-7">{String(value || "").split("\n").map((x,i)=><div key={i}>{x || "\u00a0"}</div>)}</div>;
}

export default function AIDocumentReader() {
  const [sidebar,setSidebar]=useState(true), [inspector,setInspector]=useState(true);
  const [settings,setSettings]=useState(false), [tab,setTab]=useState("providers");
  const [modelMenu,setModelMenu]=useState(false), [search,setSearch]=useState("");
  const [prompt,setPrompt]=useState(""), [running,setRunning]=useState(false), [status,setStatus]=useState("");
  const [messages,setMessages]=useState([]), [conversations,setConversations]=useState([]), [active,setActive]=useState(null);
  const [providers,setProviders]=useState([]), [accounts,setAccounts]=useState([]), [models,setModels]=useState([]);
  const [routing,setRouting]=useState(null), [executions,setExecutions]=useState([]), [stats,setStats]=useState(null);
  const [provider,setProvider]=useState("auto"), [selectedModel,setSelectedModel]=useState("auto"), [capability,setCapability]=useState("chat");
  const [files,setFiles]=useState([]);
  const [modelSearch,setModelSearch]=useState(""), [auditSearch,setAuditSearch]=useState("");
  const [docFiles,setDocFiles]=useState([]), [docQuestion,setDocQuestion]=useState(""), [docAnswer,setDocAnswer]=useState(""), [docBusy,setDocBusy]=useState(false);
  const fileRef=useRef(null), docRef=useRef(null), endRef=useRef(null);

  const refresh=async()=>{try{
    const [p,a,m,r,e,s,c]=await Promise.all([listProviders(),listAccounts(),getModels(),getRoutingConfig(),getExecutionHistory(),getStats(),listConversations()]);
    setProviders(p||[]);setAccounts(a||[]);setModels(m||[]);setRouting(r||null);setExecutions(e||[]);setStats(s||null);setConversations(c||[]);
  }catch(e){console.warn("AIWeave refresh failed",e);}};
  useEffect(()=>{refresh();},[]);
  useEffect(()=>{endRef.current?.scrollIntoView({behavior:"smooth"});},[messages,running]);

  const activeModel=selectedModel==="auto"?null:models.find(x=>x.id===selectedModel);
  const connected=useMemo(()=>providers.filter(x=>x.connectedCount>0),[providers]);
  const visibleModels=useMemo(()=>models.filter(x=>!modelSearch||`${x.name} ${x.id} ${x.provider}`.toLowerCase().includes(modelSearch.toLowerCase())),[models,modelSearch]);
  const visibleExec=useMemo(()=>executions.filter(x=>!auditSearch||`${x.prompt} ${x.providerName} ${x.accountName} ${x.model}`.toLowerCase().includes(auditSearch.toLowerCase())),[executions,auditSearch]);

  const newChat=()=>{setActive(null);setMessages([]);setPrompt("");setFiles([]);setStatus("");};
  const openChat=async(id)=>{try{const c=await getConversation(id);setActive(c);setMessages(c.messages||[]);setStatus("");}catch(e){toast.error(e?.response?.data?.detail||"Could not open conversation");}};

  const send=async()=>{
    const text=prompt.trim();if(!text||running)return;
    const userMsg={id:`u-${Date.now()}`,role:"user",content:text,created_at:new Date().toISOString()};
    setMessages(x=>[...x,userMsg]);setPrompt("");setRunning(true);
    try{
      let conv=active;
      if(!conv){conv=await createConversation({title:text.slice(0,80)});setActive(conv);}
      setStatus(selectedModel==="auto"?"AIWeave Auto is selecting the best available model...":`Using ${activeModel?.name||selectedModel}...`);
      const result=await executeTask({
        prompt:text,messages:[...messages,userMsg].slice(-30).map(x=>({role:x.role,content:x.content})),
        conversationId:conv.id||conv.conversation_id,taskType:capability,requiredCapability:capability,
        preferredProvider:provider,preferredModel:selectedModel,files:files.map(x=>({name:x.name,type:x.type,size:x.size}))
      });
      const assistant={id:`a-${Date.now()}`,role:"assistant",content:result.output||"The model completed without returning text.",
        created_at:new Date().toISOString(),providerName:result.providerName,modelName:result.modelName||result.model,
        accountName:result.accountName,fallbackTrail:result.fallbackTrail||[],tokens:result.tokens,latencyMs:result.latencyMs};
      setMessages(x=>[...x,assistant]);
      setStatus(assistant.fallbackTrail.length?`AIWeave continued automatically after ${assistant.fallbackTrail.length} fallback event(s).`:`Completed with ${assistant.providerName||"AIWeave"}.`);
      setFiles([]);await refresh();
    }catch(e){const d=e?.response?.data?.detail||e?.message||"AIWeave could not complete this request.";setMessages(x=>[...x,{id:`e-${Date.now()}`,role:"error",content:d}]);setStatus("AIWeave could not complete this request.");toast.error(d);}
    finally{setRunning(false);}
  };
  const keyDown=(e)=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}};
  const attach=(list)=>setFiles(x=>[...x,...Array.from(list||[])].slice(0,10));

  const connect=async(e)=>{e.preventDefault();setConnecting(true);try{
    await connectAccount({providerId:connectProvider,name:connectName||`${pname(connectProvider)} Account`,identity:identity||"configured",credentialSecret:secret,baseUrl:baseUrl||undefined,priority:1,weight:100,capabilities:["chat","reasoning","coding","debugging","vision","document_analysis","tool_calling","long_context","structured_output"]});
    setConnectOpen(false);setSecret("");toast.success("AI account connected.");await refresh();
  }catch(e){toast.error(e?.response?.data?.detail||e?.message||"Could not connect account.");}finally{setConnecting(false);}};

  const saveRouting=async(patch)=>{try{setRouting(await updateRoutingConfig(patch));toast.success("Routing policy updated.");}catch(e){toast.error(e?.response?.data?.detail||"Could not update routing.");}};
  const test=async(a)=>{try{const x=await testAccount(a.id);toast.success(x.message||"Provider verified.");await refresh();}catch(e){toast.error(e?.response?.data?.detail||"Provider test failed.");}};
  const toggle=async(a)=>{try{await toggleAccount(a.id);await refresh();}catch(e){toast.error(e?.response?.data?.detail||"Could not update account.");}};
  const remove=async(a)=>{if(!confirm(`Remove ${a.name}?`))return;try{await deleteAccount(a.id);await refresh();toast.success("Account removed.");}catch(e){toast.error(e?.response?.data?.detail||"Could not remove account.");}};

  const analyzeDocs=async()=>{if(!docFiles.length||docBusy)return;setDocBusy(true);try{
    const f=new FormData();docFiles.forEach(x=>f.append("files",x));
    const {data}=await api.post("/ai/workspace/analyze-documents",f,{headers:{"Content-Type":"multipart/form-data"},timeout:600000});
    setDocAnswer((data?.results||[]).map(x=>`### ${x.filename}\n${x.analysis||"Analysis completed."}`).join("\n\n")||"No analysis returned.");toast.success("Document analysis completed.");
  }catch(e){setDocAnswer(e?.response?.data?.detail||"Server-side document analysis is unavailable.");toast.error("Document analysis failed.");}finally{setDocBusy(false);}};
  const askDocs=async()=>{if(!docQuestion.trim())return;setDocBusy(true);try{const {data}=await api.post("/ai/workspace/query",{question:docQuestion.trim()},{timeout:180000});setDocAnswer(data?.answer||"No answer returned.");}catch(e){setDocAnswer(e?.response?.data?.detail||"AIWeave could not query document memory.");}finally{setDocBusy(false);}};

  return <div className="flex h-[calc(100vh-64px)] min-h-[650px] w-full min-w-0 overflow-hidden bg-white text-slate-900">
    {sidebar&&<aside className="hidden w-[270px] shrink-0 flex-col border-r border-slate-200 bg-[#f8fafc] md:flex">
      <div className="flex items-center gap-3 border-b px-4 py-4"><img src="/aiweave-icon.png" className="h-9 w-9 object-contain" alt="AIWeave"/><div><b>AIWeave</b><div className="text-[11px] text-slate-500">Multi-AI Workspace</div></div></div>
      <div className="p-3"><button onClick={newChat} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#0D3B66] px-4 py-3 text-sm font-semibold text-white"><Plus size={16}/>New Chat</button></div>
      <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Chats</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {conversations.filter(x=>!search||String(x.title||"").toLowerCase().includes(search.toLowerCase())).map(x=><button key={x.id||x.conversation_id} onClick={()=>openChat(x.id||x.conversation_id)} className={`mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-white ${active?.id===(x.id||x.conversation_id)?"bg-white shadow-sm":""}`}><MessageSquare size={15} className="shrink-0 text-slate-400"/><span className="truncate">{x.title||"New conversation"}</span></button>)}
        {!conversations.length&&<div className="px-3 py-8 text-center text-xs text-slate-400">Your recent chats will appear here.</div>}
      </div>
      <div className="border-t p-3"><div className="rounded-xl bg-white p-3 shadow-sm text-xs"><b className="block mb-2">AI Provider Status</b><div className="flex justify-between"><span>Healthy accounts</span><b>{stats?.healthyAccounts||0}</b></div><div className="flex justify-between"><span>Connected providers</span><b>{connected.length}</b></div><div className="flex justify-between"><span>Auto fallback</span><b className="text-emerald-600">ON</b></div></div><button onClick={()=>setSettings(true)} className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-white"><Settings size={15}/>Settings</button></div>
    </aside>}

    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-16 shrink-0 items-center justify-between border-b px-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2"><button className="rounded-lg p-2 hover:bg-slate-100 md:hidden" onClick={()=>setSidebar(true)}><Menu size={19}/></button><button className="hidden rounded-lg p-2 hover:bg-slate-100 md:block" onClick={()=>setSidebar(x=>!x)}>{sidebar?<ChevronLeft size={18}/>:<ChevronRight size={18}/>}</button><div><b className="text-sm">AIWeave</b><div className="hidden text-[11px] text-slate-400 sm:block">One workspace. Multiple AI models.</div></div></div>
        <div className="flex items-center gap-1"><button onClick={newChat} className="hidden items-center gap-1 rounded-lg border px-3 py-2 text-xs sm:flex"><Plus size={14}/>New Chat</button><button onClick={()=>{setSettings(true);setTab("audit");}} className="rounded-lg p-2 hover:bg-slate-100"><History size={17}/></button><button onClick={()=>setSettings(true)} className="rounded-lg p-2 hover:bg-slate-100"><Settings size={17}/></button></div>
      </header>

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="mx-auto flex w-full max-w-4xl min-h-0 flex-1 flex-col px-3 sm:px-6">
            <div className="flex items-center justify-between py-5"><div><h1 className="text-lg font-semibold">AIWeave</h1><p className="text-xs text-slate-500">Your multi-model AI workspace</p></div>
              <div className="relative"><button onClick={()=>setModelMenu(x=>!x)} className="flex items-center gap-2 rounded-full border px-3 py-2 text-xs shadow-sm"><Sparkles size={14} className="text-[#0D3B66]"/>{selectedModel==="auto"?"AIWeave Auto":activeModel?.name||selectedModel}<ChevronDown size={13}/></button>
                {modelMenu&&<div className="absolute right-0 z-40 mt-2 max-h-[60vh] w-80 overflow-y-auto rounded-2xl border bg-white p-2 shadow-xl">
                  <button onClick={()=>{setSelectedModel("auto");setProvider("auto");setModelMenu(false);}} className="w-full rounded-xl p-3 text-left hover:bg-slate-50"><b>Auto</b><div className="text-[11px] text-slate-500">Best available model + automatic fallback</div></button>
                  {connected.map(p=><button key={p.id} onClick={()=>{setProvider(p.id);setSelectedModel("auto");setModelMenu(false);}} className="flex w-full justify-between rounded-xl p-3 text-left hover:bg-slate-50"><span>{p.name}</span><Bubble tone="bg-slate-100 text-slate-600">{p.connectedCount} account{p.connectedCount===1?"":"s"}</Bubble></button>)}
                  {provider!=="auto"&&models.filter(x=>x.provider===provider).map(m=><button key={m.id} onClick={()=>{setSelectedModel(m.id);setModelMenu(false);}} className="block w-full rounded-xl px-3 py-2 text-left text-xs hover:bg-slate-50">{m.name}</button>)}
                </div>}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-5">
              {!messages.length?<div className="flex min-h-[55vh] flex-col items-center justify-center text-center"><div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#0D3B66] text-white shadow-lg"><Sparkles size={28}/></div><h2 className="text-2xl font-semibold sm:text-3xl">What can AIWeave do for you?</h2><p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">Give one instruction. AIWeave selects a connected model, preserves context, and continues automatically when an account or provider reaches a limit.</p><div className="mt-6 grid w-full max-w-2xl gap-2 sm:grid-cols-3">{["Analyse a document","Write production code","Prepare a compliance report"].map(x=><button key={x} onClick={()=>setPrompt(x)} className="rounded-xl border p-3 text-left text-xs font-medium hover:bg-slate-50">{x}</button>)}</div></div>
              :messages.map(m=><div key={m.id} className={`mb-7 flex ${m.role==="user"?"justify-end":"justify-start"}`}><div className={`${m.role==="user"?"max-w-[82%] rounded-2xl bg-[#0D3B66] px-4 py-3 text-white":"w-full max-w-[94%]"} min-w-0`}>{m.role==="assistant"&&<div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-500"><Bot size={15}/> {m.providerName||"AIWeave"}{m.modelName&&<span className="font-normal text-slate-400">· {m.modelName}</span>}</div>}{m.role==="error"?<div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{m.content}</div>:<Text value={m.content}/>} {m.role==="assistant"&&<div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-400">{m.fallbackTrail?.length?<Bubble tone="bg-amber-50 text-amber-700">Auto fallback ×{m.fallbackTrail.length}</Bubble>:null}{m.tokens?<span>{m.tokens.toLocaleString()} tokens</span>:null}{m.latencyMs?<span>{(m.latencyMs/1000).toFixed(1)}s</span>:null}<button onClick={()=>navigator.clipboard?.writeText(m.content)}><Copy size={13}/></button></div>}</div></div>)}
              {running&&<div className="mb-6 flex items-center gap-3 text-sm text-slate-500"><span className="flex gap-1"><i className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"/><i className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"/><i className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"/></span>{status}</div>}<div ref={endRef}/>
            </div>
            <div className="pb-4 pt-2">{files.length>0&&<div className="mb-2 flex flex-wrap gap-2">{files.map((f,i)=><Bubble key={i} tone="bg-slate-100 text-slate-600"><FileText size={12} className="mr-1"/>{f.name}<button className="ml-1" onClick={()=>setFiles(x=>x.filter((_,n)=>n!==i))}><X size={11}/></button></Bubble>)}</div>}
              <div className="rounded-2xl border border-slate-300 bg-white p-2 shadow-sm focus-within:border-slate-400"><textarea value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={keyDown} disabled={running} rows={2} className="max-h-48 min-h-[54px] w-full resize-none border-0 bg-transparent px-3 py-2 text-sm outline-none" placeholder="Ask AIWeave anything..."/><div className="flex items-center justify-between px-2 pb-1"><div className="flex items-center gap-1"><input ref={fileRef} type="file" multiple accept={ACCEPTED} className="hidden" onChange={e=>attach(e.target.files)}/><button onClick={()=>fileRef.current?.click()} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><Paperclip size={17}/></button><select value={capability} onChange={e=>setCapability(e.target.value)} className="max-w-[150px] rounded-lg bg-slate-50 px-2 py-1.5 text-[11px]">{CAPABILITIES.filter(x=>["chat","reasoning","coding","debugging","document_analysis","vision","structured_output"].includes(x.id)).map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</select></div><button onClick={send} disabled={!prompt.trim()||running} className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#0D3B66] text-white disabled:opacity-40">{running?<Square size={14}/>:<ArrowUp size={16}/>}</button></div></div><div className="mt-2 flex justify-between px-2 text-[10px] text-slate-400"><span>{status||"AIWeave can automatically switch models when a provider becomes unavailable."}</span><span className="hidden sm:block">Enter to send · Shift+Enter for new line</span></div>
            </div>
          </div>
        </section>
        {inspector&&<aside className="hidden w-[270px] shrink-0 border-l bg-[#fbfcfe] xl:block"><div className="border-b px-4 py-4"><b className="text-sm">AIWeave</b><div className="text-[11px] text-slate-400">Execution inspector</div></div><div className="space-y-3 p-4"><div className="rounded-xl border bg-white p-3"><div className="text-[11px] text-slate-400">Current model</div><b className="text-sm">{activeModel?.name||"Auto"}</b><div className="text-xs text-slate-500">{provider==="auto"?"Best available provider":pname(provider)}</div></div><div className="grid grid-cols-2 gap-2">{[["Healthy",stats?.healthyAccounts||0],["Accounts",stats?.totalAccounts||0],["Executions",stats?.totalExecutionsCount||0],["Fallbacks",stats?.fallbackExecutions||0]].map(x=><div key={x[0]} className="rounded-xl bg-white p-3 shadow-sm"><div className="text-[10px] text-slate-400">{x[0]}</div><b>{x[1]}</b></div>)}</div><div className="rounded-xl border bg-white p-3 text-xs"><b>Routing</b><div className="mt-2 flex justify-between"><span>Strategy</span><b>{routing?.strategy||"PRIORITY"}</b></div><div className="flex justify-between"><span>Attempts</span><b>{routing?.maxTotalAttempts||5}</b></div><div className="flex justify-between"><span>Fallback</span><b>{routing?.retryOnRateLimit?"ON":"OFF"}</b></div></div><button onClick={()=>setInspector(false)} className="w-full rounded-lg border px-3 py-2 text-xs">Hide inspector</button></div></aside>}
      </div>
    </main>

    {settings&&<div className="fixed inset-0 z-50 flex bg-slate-900/30"><div className="ml-auto flex h-full w-full max-w-5xl flex-col bg-white shadow-2xl"><div className="flex items-center justify-between border-b px-5 py-4"><div><b>AIWeave Settings</b><div className="text-xs text-slate-500">Platform-managed providers, models, routing, audit and documents</div></div><button onClick={()=>setSettings(false)}><X/></button></div><div className="flex min-h-0 flex-1"><nav className="hidden w-48 shrink-0 border-r bg-slate-50 p-3 sm:block">{[["providers","Providers"],["accounts","Accounts"],["models","Models"],["routing","Routing"],["audit","Audit"],["documents","Documents"]].map(x=><button key={x[0]} onClick={()=>setTab(x[0])} className={`mb-1 w-full rounded-lg px-3 py-2 text-left text-sm ${tab===x[0]?"bg-white font-semibold shadow-sm":""}`}>{x[1]}</button>)}</nav><div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
      {tab==="providers"&&<div><div className="mb-4"><h2 className="text-lg font-semibold">AI Providers</h2><p className="mt-1 text-xs text-slate-500">AI providers are configured centrally by the software operator. Customer users only sign in with their Taskosphere account; they never enter provider API keys here.</p></div><div className="mb-4 rounded-xl border border-blue-100 bg-blue-50 p-4 text-xs text-blue-800"><b>Platform-managed AI infrastructure</b><div className="mt-1">OpenAI, Gemini, Claude, Grok and other enabled providers are supplied from the backend environment and can be used automatically according to the platform routing policy.</div></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{PROVIDERS.map(p=>{const x=providers.find(y=>y.id===p.id);return <div key={p.id} className="rounded-xl border p-4"><div className="flex justify-between"><b className="text-sm">{p.name}</b><span className={x?.healthyCount?"text-emerald-600":"text-slate-300"}>●</span></div><div className="mt-1 text-[11px] text-slate-500">{x?.connectedCount||0} available · {x?.healthyCount||0} healthy</div><div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-500">Managed by platform administrator</div></div>})}</div></div>}
      {tab==="accounts"&&<div><h2 className="mb-2 text-lg font-semibold">Platform AI Accounts</h2><p className="mb-4 text-xs text-slate-500">These are read-only provider statuses for the current customer. Credentials are stored and managed only on the backend.</p><div className="space-y-2">{accounts.map(a=><div key={a.id} className="rounded-xl border p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><b className="text-sm">{a.name}</b><div className="text-xs text-slate-500">{pname(a.provider)} · {a.maskedIdentity||"server-managed credential"}</div></div><Bubble tone={a.health==="HEALTHY"?"bg-emerald-50 text-emerald-700":"bg-amber-50 text-amber-700"}>{a.health||"UNKNOWN"}</Bubble></div></div>)}{!accounts.length&&<div className="rounded-xl border border-dashed p-8 text-center text-sm text-slate-500">No platform AI providers are currently enabled.</div>}</div></div>}
      {tab==="models"&&<div><div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold">Model Registry</h2><input value={modelSearch} onChange={e=>setModelSearch(e.target.value)} placeholder="Search models" className="rounded-lg border px-3 py-2 text-xs"/></div><div className="space-y-2">{visibleModels.map(m=><div key={m.provider+m.id} className="flex flex-wrap justify-between gap-2 rounded-xl border p-3"><div><b className="text-sm">{m.name}</b><div className="text-xs text-slate-500">{pname(m.provider)} · {m.availability||"catalog"}</div></div><div className="flex flex-wrap gap-1">{(m.capabilities||[]).slice(0,6).map(c=><Bubble key={c} tone="bg-slate-100 text-slate-500">{c}</Bubble>)}</div></div>)}</div></div>}
      {tab==="routing"&&<div><h2 className="mb-4 text-lg font-semibold">Routing & Fallback</h2><div className="grid gap-4 md:grid-cols-2"><label className="rounded-xl border p-4 text-sm"><span className="mb-2 block text-xs text-slate-500">Strategy</span><select value={routing?.strategy||"PRIORITY"} onChange={e=>saveRouting({strategy:e.target.value})} className="w-full rounded-lg border px-3 py-2">{ROUTING_STRATEGIES.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</select></label><label className="rounded-xl border p-4 text-sm"><span className="mb-2 block text-xs text-slate-500">Cost policy</span><select value={routing?.costPolicy||"FREE_FIRST"} onChange={e=>saveRouting({costPolicy:e.target.value})} className="w-full rounded-lg border px-3 py-2">{COST_POLICIES.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</select></label><label className="rounded-xl border p-4 text-sm"><span className="mb-2 block text-xs text-slate-500">Maximum total attempts</span><input type="number" min="1" max="15" value={routing?.maxTotalAttempts||5} onChange={e=>saveRouting({maxTotalAttempts:Number(e.target.value)})} className="w-full rounded-lg border px-3 py-2"/></label><div className="rounded-xl border p-4"><b className="text-sm">Automatic fallback</b><p className="mt-1 text-xs text-slate-500">Continue after rate limits, capacity exhaustion and provider failures.</p><button onClick={()=>saveRouting({retryOnRateLimit:!routing?.retryOnRateLimit,retryOnCapacityExhausted:!routing?.retryOnCapacityExhausted})} className={`mt-3 rounded-lg px-3 py-2 text-xs font-semibold ${routing?.retryOnRateLimit?"bg-emerald-600 text-white":"bg-slate-100"}`}>{routing?.retryOnRateLimit?"Enabled":"Disabled"}</button></div></div></div>}
      {tab==="audit"&&<div><div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold">Execution History</h2><input value={auditSearch} onChange={e=>setAuditSearch(e.target.value)} placeholder="Search" className="rounded-lg border px-3 py-2 text-xs"/></div><div className="space-y-2">{visibleExec.map(e=><div key={e.execution_id||e.id} className="rounded-xl border p-4"><div className="flex justify-between"><div><b className="text-sm">{e.modelName||e.model}</b><div className="text-xs text-slate-500">{e.providerName} · {e.accountName}</div></div><Bubble tone="bg-emerald-50 text-emerald-700">{e.status}</Bubble></div><p className="mt-2 text-xs text-slate-500">{e.prompt}</p>{e.fallbackTrail?.length?<p className="mt-1 text-[11px] text-amber-700">Fallbacks: {e.fallbackTrail.map(x=>x.provider).join(" → ")}</p>:null}<p className="mt-1 text-[10px] text-slate-400">{fmt(e.timestamp)}</p></div>)}</div></div>}
      {tab==="documents"&&<div><h2 className="mb-4 text-lg font-semibold">Document Workspace</h2><input ref={docRef} type="file" multiple accept={ACCEPTED} className="hidden" onChange={e=>setDocFiles(Array.from(e.target.files||[]).slice(0,MAX_DOCS))}/><button onClick={()=>docRef.current?.click()} className="w-full rounded-2xl border border-dashed p-8 text-center hover:bg-slate-50"><Upload className="mx-auto mb-2 text-slate-400"/><b className="text-sm">Upload documents</b><div className="text-xs text-slate-500">PDF, Excel, CSV and images</div></button>{docFiles.length>0&&<div className="mt-3">{docFiles.map((f,i)=><div key={i} className="flex justify-between bg-slate-50 p-2 text-xs">{f.name}<button onClick={()=>setDocFiles(x=>x.filter((_,n)=>n!==i))}><X size={14}/></button></div>)}<button disabled={docBusy} onClick={analyzeDocs} className="mt-2 rounded-lg bg-[#0D3B66] px-3 py-2 text-xs text-white">{docBusy?"Analysing...":"Analyse documents"}</button></div>}<div className="mt-6 rounded-xl border p-4"><b className="text-sm">Ask document memory</b><textarea value={docQuestion} onChange={e=>setDocQuestion(e.target.value)} rows={3} className="mt-2 w-full rounded-lg border p-2 text-sm"/><button onClick={askDocs} disabled={docBusy} className="mt-2 rounded-lg border px-3 py-2 text-xs">Ask AIWeave</button>{docAnswer&&<div className="mt-4 whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-sm">{docAnswer}</div>}</div></div>}
    </div></div></div></div>}
  </div>;
}
