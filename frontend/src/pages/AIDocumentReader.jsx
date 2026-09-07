import React, { useEffect, useRef, useState } from "react";
import { Upload, FileText, Loader2, Sparkles, X, Brain, Search, RefreshCw, CheckCircle2, AlertTriangle } from "lucide-react";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

const ACCEPTED = ".pdf,.xlsx,.xls,.xlsm,.csv,.jpg,.jpeg,.png,.webp,.gif";
const MAX_FILES = 25;

const FILE_ICONS = {
  pdf: "📄", xlsx: "📊", xls: "📊", xlsm: "📊",
  csv: "📋", jpg: "🖼️", jpeg: "🖼️", png: "🖼️", webp: "🖼️", gif: "🖼️",
};

export default function AIDocumentReader() {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const [errors, setErrors] = useState([]);
  const [knowledge, setKnowledge] = useState(null);
  const [workspaceDocs, setWorkspaceDocs] = useState([]);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [queryLoading, setQueryLoading] = useState(false);
  const inputRef = useRef(null);

  async function loadWorkspace() {
    try {
      const { data } = await api.get("/ai/workspace/context");
      setKnowledge(data.knowledge || null);
      setWorkspaceDocs(data.documents || []);
    } catch (err) {
      // Workspace is additive; the reader remains usable if the context endpoint is unavailable.
      console.warn("AI workspace context unavailable", err);
    }
  }

  useEffect(() => {
    loadWorkspace();
  }, []);

  function addFiles(incoming) {
    const selected = Array.from(incoming || []).filter(Boolean);
    if (!selected.length) return;
    setFiles((current) => {
      const merged = [...current, ...selected];
      const unique = merged.filter((file, index, all) =>
        all.findIndex((other) => other.name === file.name && other.size === file.size && other.lastModified === file.lastModified) === index
      );
      if (unique.length > MAX_FILES) {
        toast.error(`You can upload up to ${MAX_FILES} documents at once.`);
      }
      return unique.slice(0, MAX_FILES);
    });
  }

  function onDrop(e) {
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  }

  function removeFile(index) {
    setFiles((current) => current.filter((_, i) => i !== index));
  }

  function clearSelection() {
    setFiles([]);
    setResults([]);
    setErrors([]);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function analyzeAll() {
    if (!files.length) return;
    setLoading(true);
    setResults([]);
    setErrors([]);
    const form = new FormData();
    files.forEach((file) => form.append("files", file));

    try {
      const { data } = await api.post("/ai/workspace/analyze-documents", form, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 600000,
      });
      setResults(data.results || []);
      setErrors(data.errors || []);
      setKnowledge(data.knowledge || null);
      await loadWorkspace();
      if (data.failed) {
        toast.warning(`${data.processed} document(s) processed, ${data.failed} failed.`);
      } else {
        toast.success(`${data.processed} document(s) processed and added to AI memory.`);
      }
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Document analysis failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function askWorkspace() {
    const q = question.trim();
    if (!q) return;
    setQueryLoading(true);
    setAnswer("");
    try {
      const { data } = await api.post("/ai/workspace/query", { question: q }, { timeout: 180000 });
      setAnswer(data.answer || "No answer was returned.");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Could not query the document workspace.");
    } finally {
      setQueryLoading(false);
    }
  }

  return (
    <div className="w-full min-w-0 p-5 md:p-6 space-y-5">
      {/* Existing application blue page-header treatment */}
      <div
        className="w-full border border-blue-900/20 shadow-sm"
        style={{
          background: "linear-gradient(135deg,#0D3B66 0%,#145A8D 52%,#1F6FB2 100%)",
          color: "#fff",
        }}
      >
        <div className="px-5 py-4 md:px-6 md:py-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 shrink-0 border border-white/30 bg-white/10 flex items-center justify-center">
              <Sparkles className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl md:text-2xl font-semibold tracking-tight">AI Document Reader</h1>
              <p className="text-sm text-blue-100 mt-0.5">
                Read, connect and remember information across every document you upload.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs font-medium shrink-0">
            <span className="border border-white/25 bg-white/10 px-3 py-2 flex items-center gap-2">
              <Brain className="w-4 h-4" /> Persistent AI Memory
            </span>
            <span className="border border-white/25 bg-white/10 px-3 py-2">
              {knowledge?.document_count || workspaceDocs.length || 0} documents learned
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.55fr)] gap-5 items-start">
        <div className="space-y-5 min-w-0">
          <Card className="border shadow-sm">
            <CardContent className="p-0">
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop}
                onClick={() => inputRef.current?.click()}
                className="border-2 border-dashed border-slate-300 p-8 md:p-10 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition-colors"
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept={ACCEPTED}
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <Upload className="w-10 h-10 mx-auto mb-3 text-slate-500" />
                <p className="text-sm font-semibold text-slate-800">Drop multiple documents here or click to browse</p>
                <p className="text-xs text-slate-500 mt-1">
                  PDF · Excel · CSV · JPG · PNG · WEBP · scanned certificates · tax records · reports
                </p>
                <p className="text-xs text-blue-700 mt-2 font-medium">Up to {MAX_FILES} documents per batch</p>
              </div>
            </CardContent>
          </Card>

          {files.length > 0 && (
            <Card className="border shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <FileText className="w-4 h-4 text-blue-600" />
                    Upload queue ({files.length})
                  </CardTitle>
                  <button onClick={clearSelection} className="text-xs text-slate-500 hover:text-slate-900">Clear</button>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="divide-y border">
                  {files.map((file, index) => {
                    const ext = file.name.split(".").pop()?.toLowerCase() || "";
                    return (
                      <div key={`${file.name}-${file.size}-${file.lastModified}`} className="flex items-center justify-between gap-3 px-3 py-2.5">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-xl shrink-0">{FILE_ICONS[ext] || "📁"}</span>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{file.name}</p>
                            <p className="text-xs text-slate-500">{(file.size / 1024).toFixed(1)} KB</p>
                          </div>
                        </div>
                        <button onClick={() => removeFile(index)} className="text-slate-400 hover:text-red-600 shrink-0" aria-label={`Remove ${file.name}`}>
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    );
                  })}
                </div>
                <Button onClick={analyzeAll} disabled={loading} className="mt-4 w-full gap-2">
                  {loading ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> Reading all documents and updating memory…</>
                  ) : (
                    <><Sparkles className="w-4 h-4" /> Analyse All Documents</>
                  )}
                </Button>
              </CardContent>
            </Card>
          )}

          {results.length > 0 && (
            <div className="space-y-4">
              {results.map((item, index) => (
                <Card key={`${item.filename}-${index}`} className="border shadow-sm">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-start justify-between gap-3">
                      <span className="flex items-center gap-2 min-w-0">
                        <FileText className="w-4 h-4 text-blue-600 shrink-0" />
                        <span className="truncate">{item.filename}</span>
                      </span>
                      {item.reused_memory ? (
                        <span className="text-[11px] border px-2 py-1 text-emerald-700 bg-emerald-50 shrink-0">Memory reused</span>
                      ) : null}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-xs text-slate-500 mb-2">{item.document_type || "Document"}</div>
                    <pre className="whitespace-pre-wrap text-sm leading-relaxed font-sans text-slate-800">{item.analysis || "No analysis returned."}</pre>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {errors.length > 0 && (
            <Card className="border border-amber-200 shadow-sm">
              <CardContent className="p-4 space-y-2">
                {errors.map((item) => (
                  <div key={item.filename} className="flex items-start gap-2 text-sm text-amber-800">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span><strong>{item.filename}:</strong> {item.error}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-5 min-w-0">
          <Card className="border shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Brain className="w-4 h-4 text-blue-600" /> Workspace Intelligence
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="border p-3">
                  <div className="text-xs text-slate-500">Documents learned</div>
                  <div className="text-xl font-semibold mt-1">{knowledge?.document_count || workspaceDocs.length || 0}</div>
                </div>
                <div className="border p-3">
                  <div className="text-xs text-slate-500">Knowledge version</div>
                  <div className="text-xl font-semibold mt-1">{knowledge?.knowledge_version || 0}</div>
                </div>
              </div>
              <div className="border bg-slate-50 p-3 text-xs text-slate-600 leading-relaxed">
                Each processed document is stored in company-scoped AI memory. New uploads update the knowledge snapshot so later documents can be compared with earlier registrations, financials, parties, dates, identifiers and recurring patterns.
              </div>
              <Button variant="outline" onClick={loadWorkspace} className="w-full gap-2">
                <RefreshCw className="w-4 h-4" /> Refresh learned context
              </Button>
            </CardContent>
          </Card>

          <Card className="border shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Search className="w-4 h-4 text-blue-600" /> Ask Across All Documents
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) askWorkspace(); }}
                placeholder="e.g. Which documents belong to the same business?"
              />
              <Button onClick={askWorkspace} disabled={queryLoading || !question.trim()} className="w-full gap-2">
                {queryLoading ? <><Loader2 className="w-4 h-4 animate-spin" /> Thinking…</> : <><Search className="w-4 h-4" /> Ask AI</>}
              </Button>
              {answer && (
                <div className="border bg-slate-50 p-3 text-sm whitespace-pre-wrap leading-relaxed">
                  {answer}
                </div>
              )}
            </CardContent>
          </Card>

          {workspaceDocs.length > 0 && (
            <Card className="border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Learned Documents</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="max-h-72 overflow-auto divide-y border">
                  {workspaceDocs.map((doc) => (
                    <div key={doc.document_id || doc.filename} className="px-3 py-2.5">
                      <div className="flex items-start gap-2">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{doc.filename}</p>
                          <p className="text-[11px] text-slate-500">{doc.document_type || "Document"}{doc.vendor_name ? ` · ${doc.vendor_name}` : ""}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
