import React, { useEffect, useState, useRef } from 'react';
import { toast } from 'sonner';
import {
  ScanLine, UploadCloud, RefreshCw, CheckCircle2, AlertTriangle,
  Sparkles, FileText, Settings2, Plus, Building2, Banknote,
  Eye, ThumbsUp, ThumbsDown, Clock, Bot, Pencil, Save, X as XIcon,
} from 'lucide-react';
import { ContentLoader } from '@/components/ui/GifLoader.jsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { FinixTabsList, FinixTabsTrigger } from '@/components/ui/finix-tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import api from '@/lib/api';
import { useDark } from '@/hooks/useDark';
import RequestAccessGate from '@/components/RequestAccessGate.jsx';

const COLORS = { deepBlue: '#0D3B66', mediumBlue: '#1F6FB2', emeraldGreen: '#1FAF5A', amber: '#F59E0B', coral: '#FF6B6B' };
const fmtC = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function StatusBadge({ status, settled }) {
  if (status === 'posted' && settled) {
    return <Badge className="bg-emerald-600 hover:bg-emerald-600">Posted &amp; Settled</Badge>;
  }
  const map = {
    posted:            { label: 'Posted',              className: 'bg-blue-600 hover:bg-blue-600' },
    pending_approval:  { label: 'Awaiting Approval',    className: 'bg-amber-500 hover:bg-amber-500' },
    needs_review:      { label: 'Needs Review',         className: '' },
    rejected:          { label: 'Rejected',             className: '' },
    extracted:         { label: 'Extracted',            className: '' },
  };
  const cfg = map[status] || { label: status, className: '' };
  const variant = status === 'needs_review' || status === 'rejected' ? 'destructive'
    : (status === 'posted' || status === 'pending_approval' ? 'default' : 'secondary');
  return <Badge variant={variant} className={cfg.className}>{cfg.label}</Badge>;
}

function CompanyPicker({ companies, onAssign, isDark }) {
  const [selected, setSelected] = useState('');
  return (
    <div className="flex items-center gap-1">
      <select
        className={`text-xs rounded-md border px-2 py-1 ${isDark ? 'bg-slate-900 border-slate-600 text-slate-200' : 'bg-white border-slate-300'}`}
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
      >
        <option value="">Assign company…</option>
        {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={!selected} onClick={() => onAssign(selected)}>Post</Button>
    </div>
  );
}

function ZeroTouchEntryInner() {
  const isDark = useDark();
  const fileInputRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [docs, setDocs] = useState([]);
  const [rules, setRules] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [uploadCompanyId, setUploadCompanyId] = useState('');
  const [newRule, setNewRule] = useState({ match: '', account_code: '', label: '' });
  const [previewDoc, setPreviewDoc] = useState(null);       // doc shown in the review dialog
  const [approving, setApproving] = useState(false);
  const [rejectDoc, setRejectDoc] = useState(null);         // doc being rejected
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [editingLines, setEditingLines] = useState(false);  // review dialog: correcting the AI-picked account(s)
  const [draftLines, setDraftLines] = useState([]);
  const [savingLines, setSavingLines] = useState(false);

  const fetchDocs = async () => {
    try {
      const { data } = await api.get('/zte/documents');
      setDocs(data || []);
    } catch {
      toast.error('Failed to load processed documents');
    }
  };

  const fetchRules = async () => {
    try {
      const { data } = await api.get('/zte/category-rules');
      setRules(data || []);
    } catch { /* non-fatal */ }
  };

  const fetchCompanies = async () => {
    try {
      const { data } = await api.get('/zte/companies');
      setCompanies(data || []);
    } catch { /* non-fatal */ }
  };

  const fetchAccounts = async () => {
    try {
      const { data } = await api.get('/chart-of-accounts');
      setAccounts(data || []);
    } catch { /* non-fatal — edit-account controls just won't have options */ }
  };

  const fetchAll = async () => {
    setLoading(true);
    await Promise.allSettled([fetchDocs(), fetchRules(), fetchCompanies(), fetchAccounts()]);
    setLoading(false);
  };

  useEffect(() => { fetchAll(); }, []);

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('company_id', uploadCompanyId); // blank = auto-detect (deterministic, then AI)
      const { data } = await api.post('/zte/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (data.status === 'pending_approval') {
        toast.success(`Drafted for ${data.company_name || 'company'} — review & approve below.`);
      } else if (data.status === 'needs_review') {
        toast.warning(`Needs review: ${data.posting_error}`);
      } else {
        toast.info('Document extracted.');
      }
      await fetchDocs();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Extraction failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const retryDraft = async (docId) => {
    try {
      await api.post(`/zte/documents/${docId}/retry-posting`);
      toast.success('Draft ready — review & approve below.');
      await fetchDocs();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Could not draft entry — check extracted data.');
    }
  };

  const assignCompany = async (docId, companyId) => {
    try {
      await api.post(`/zte/documents/${docId}/assign-company`, { company_id: companyId });
      toast.success('Company assigned — draft ready for approval.');
      await fetchDocs();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Could not assign company');
    }
  };

  const openPreview = (doc) => {
    setPreviewDoc(doc);
    setEditingLines(false);
    setDraftLines((doc?.preview?.lines || []).map((l) => ({ ...l })));
  };

  const startEditingLines = () => {
    setDraftLines((previewDoc?.preview?.lines || []).map((l) => ({ ...l })));
    setEditingLines(true);
  };

  const updateDraftLine = (i, field, value) => {
    setDraftLines((prev) => {
      const next = [...prev];
      if (field === 'account_id') {
        const acct = accounts.find((a) => a.id === value);
        next[i] = { ...next[i], account_id: value, account_name: acct ? `${acct.code ? acct.code + ' — ' : ''}${acct.name}` : next[i].account_name };
      } else {
        next[i] = { ...next[i], [field]: value };
      }
      return next;
    });
  };

  const draftTotalDebit = draftLines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const draftTotalCredit = draftLines.reduce((s, l) => s + Number(l.credit || 0), 0);
  const draftBalanced = Math.abs(draftTotalDebit - draftTotalCredit) < 0.01 && draftTotalDebit > 0;

  const saveDraftLines = async () => {
    if (!previewDoc) return;
    if (!draftBalanced) { toast.error('Debits must equal credits before saving.'); return; }
    setSavingLines(true);
    try {
      const { data } = await api.post(`/zte/documents/${previewDoc.id}/update-preview`, {
        lines: draftLines.map((l) => ({
          account_id: l.account_id, account_name: l.account_name || '',
          debit: Number(l.debit || 0), credit: Number(l.credit || 0), memo: l.memo || '',
        })),
      });
      const updatedDoc = { ...previewDoc, preview: data.preview };
      setPreviewDoc(updatedDoc);
      setDocs((prev) => prev.map((d) => (d.id === updatedDoc.id ? updatedDoc : d)));
      setEditingLines(false);
      toast.success('Account corrected — review the updated lines below before approving.');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Could not save the correction.');
    } finally {
      setSavingLines(false);
    }
  };

  const approveDoc = async (docId) => {
    setApproving(true);
    try {
      const { data } = await api.post(`/zte/documents/${docId}/approve`);
      toast.success(`Posted to ledger (Journal Entry ${data.journal_entry_id?.slice(0, 8)}…).`);
      setPreviewDoc(null);
      await fetchDocs();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Could not post — try again.');
    } finally {
      setApproving(false);
    }
  };

  const submitReject = async () => {
    if (!rejectDoc || rejectReason.trim().length < 3) {
      toast.error('Please give a reason (at least a few words).');
      return;
    }
    setRejecting(true);
    try {
      await api.post(`/zte/documents/${rejectDoc.id}/reject`, { reason: rejectReason.trim() });
      toast.success('Draft rejected — nothing was posted.');
      setRejectDoc(null);
      setRejectReason('');
      setPreviewDoc(null);
      await fetchDocs();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Could not reject');
    } finally {
      setRejecting(false);
    }
  };

  const addRule = async () => {
    if (!newRule.match.trim() || !newRule.account_code.trim()) {
      toast.error('Vendor pattern and account code are required.');
      return;
    }
    try {
      await api.post('/zte/category-rules', { company_id: '', ...newRule });
      toast.success('Category rule saved.');
      setNewRule({ match: '', account_code: '', label: '' });
      await fetchRules();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Could not save rule');
    }
  };

  if (loading) return <ContentLoader />;

  const posted = docs.filter(d => d.status === 'posted').length;
  const pending = docs.filter(d => d.status === 'pending_approval').length;
  const review = docs.filter(d => d.status === 'needs_review').length;
  const settled = docs.filter(d => d.settled).length;

  return (
    // NOTE: DashboardLayout already applies page padding + max-width + background.
    // Do NOT add min-h-screen / p-* / max-w-* here or the hero drifts out of
    // alignment with the sidebar and the Accounting Reports page.
    <div className="w-full min-w-0">
      <div className="space-y-5 w-full min-w-0">
        {/* Header — compact (same scale as Accounting Reports). Tabs sit below. */}
        <div className="finix-hero rounded-2xl overflow-hidden shadow-lg" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
          <div className="p-3 md:p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3 text-white">
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-10 w-10 shrink-0 rounded-xl bg-white/15 border border-white/20 flex items-center justify-center">
                <ScanLine className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-[0.2em] text-blue-100 font-bold leading-none">AI Accounting · Module 1</p>
                <h1 className="text-lg md:text-xl font-bold tracking-tight mt-1 truncate">Zero-Touch Entry Engine</h1>
                <p
                  className="text-[11px] leading-snug text-blue-100 mt-0.5 line-clamp-2"
                  title="Upload an invoice or receipt — an AI reads it, detects the company & currency, converts to INR, classifies it, and posts a balanced journal entry automatically."
                >Upload an invoice or receipt — an AI reads it, detects the company &amp; currency, converts to INR, classifies it, and posts a balanced journal entry automatically.</p>
              </div>
            </div>
            <div className="finix-hero-actions flex flex-col gap-1 items-end">
              <div className="flex gap-2" data-header-actions="true">
                <select
                  className="text-xs rounded-md border border-white/25 bg-white/10 text-white px-2"
                  value={uploadCompanyId}
                  onChange={(e) => setUploadCompanyId(e.target.value)}
                >
                  <option value="" className="text-slate-900">Auto-detect company</option>
                  {companies.map((c) => <option key={c.id} value={c.id} className="text-slate-900">{c.name}</option>)}
                </select>
                <input ref={fileInputRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" className="hidden" onChange={handleFileChange} />
                <Button onClick={() => fileInputRef.current?.click()} disabled={uploading} size="sm" className="bg-white text-blue-900 hover:bg-blue-50 text-xs">
                  {uploading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <UploadCloud className="h-4 w-4 mr-2" />}
                  {uploading ? 'Reading document…' : 'Upload Invoice / Receipt'}
                </Button>
                <Button onClick={fetchAll} variant="outline" size="sm" className="bg-white/10 border-white/25 text-white hover:bg-white/20">
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
              {companies.length > 1 && (
                <p className="text-xs text-blue-100 flex items-center gap-1"><Bot className="h-3 w-3" /> {companies.length} companies configured — leave blank for AI to auto-match by GSTIN, billing email, name, or document context</p>
              )}
            </div>
          </div>
        </div>

        {/* Summary strip */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { label: 'Documents Processed', value: docs.length, icon: FileText, color: COLORS.mediumBlue },
            { label: 'Awaiting Approval', value: pending, icon: Clock, color: COLORS.amber },
            { label: 'Posted', value: posted, icon: CheckCircle2, color: COLORS.emeraldGreen },
            { label: 'Settled (Bank Matched)', value: settled, icon: Banknote, color: COLORS.mediumBlue },
            { label: 'Needs Review', value: review, icon: AlertTriangle, color: COLORS.coral },
          ].map((s) => (
            <div key={s.label} className={`rounded-2xl border p-4 flex items-center gap-3 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className="h-10 w-10 rounded-xl flex items-center justify-center" style={{ background: `${s.color}20` }}>
                <s.icon className="h-5 w-5" style={{ color: s.color }} />
              </div>
              <div>
                <p className={`text-xs font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{s.label}</p>
                <p className={`text-xl font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{s.value}</p>
              </div>
            </div>
          ))}
        </div>

        <Tabs defaultValue="documents">
          <FinixTabsList>
            <FinixTabsTrigger value="documents">Processed Documents</FinixTabsTrigger>
            <FinixTabsTrigger value="rules">Vendor Categorisation Rules</FinixTabsTrigger>
          </FinixTabsList>

          <TabsContent value="documents" className="mt-4">
            <div className={`rounded-3xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              {docs.length === 0 ? (
                <div className="p-10 text-center">
                  <Sparkles className={`h-8 w-8 mx-auto mb-2 ${isDark ? 'text-slate-500' : 'text-slate-300'}`} />
                  <p className={isDark ? 'text-slate-400' : 'text-slate-500'}>No documents processed yet — upload an invoice or receipt to get started.</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>File</TableHead>
                      <TableHead>Company</TableHead>
                      <TableHead>Vendor / Customer</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Original</TableHead>
                      <TableHead className="text-right">Posted (INR)</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {docs.map((d) => {
                      const ex = d.extracted || {};
                      const ccy = ex.currency || 'INR';
                      return (
                        <TableRow key={d.id}>
                          <TableCell className="max-w-[140px] truncate">{d.filename}</TableCell>
                          <TableCell>
                            {d.company_name
                              ? <span className="text-sm">{d.company_name}</span>
                              : <span className={`text-xs italic ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>unassigned</span>}
                          </TableCell>
                          <TableCell>{ex.vendor_or_customer_name || '—'}</TableCell>
                          <TableCell><Badge variant="outline">{ex.document_type || '—'}</Badge></TableCell>
                          <TableCell>{ex.invoice_date || '—'}</TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {ccy !== 'INR' ? `${ccy} ${Number(ex.total_invoice_value || 0).toLocaleString()}` : '—'}
                          </TableCell>
                          <TableCell className="text-right font-mono">{fmtC(d.amount_inr ?? ex.total_invoice_value)}</TableCell>
                          <TableCell><StatusBadge status={d.status} settled={d.settled} /></TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              {d.status === 'needs_review' && !d.company_id && (
                                <CompanyPicker companies={companies} isDark={isDark} onAssign={(cid) => assignCompany(d.id, cid)} />
                              )}
                              {d.status === 'needs_review' && d.company_id && (
                                <Button size="sm" variant="outline" onClick={() => retryDraft(d.id)}>Retry Draft</Button>
                              )}
                              {d.status === 'pending_approval' && (
                                <>
                                  <Button size="sm" variant="outline" onClick={() => openPreview(d)}>
                                    <Eye className="h-3.5 w-3.5 mr-1" /> Review
                                  </Button>
                                  <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => approveDoc(d.id)}>
                                    <ThumbsUp className="h-3.5 w-3.5 mr-1" /> Approve
                                  </Button>
                                  <Button size="sm" variant="destructive" onClick={() => setRejectDoc(d)}>
                                    <ThumbsDown className="h-3.5 w-3.5" />
                                  </Button>
                                </>
                              )}
                              {d.status === 'rejected' && d.rejection_reason && (
                                <span className={`text-xs italic ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{d.rejection_reason}</span>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          </TabsContent>

          <TabsContent value="rules" className="mt-4 space-y-4">
            <div className={`rounded-3xl border shadow-sm p-4 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <h3 className={`font-bold mb-3 flex items-center gap-2 ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                <Settings2 className="h-4 w-4" /> Add Vendor → Ledger Rule
              </h3>
              <p className={`text-xs mb-3 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                When a PURCHASE invoice's vendor name matches this pattern (regex, case-insensitive), the expense auto-posts to the given Chart of Accounts code instead of the generic "Purchases" account. Codes must match real Chart of Accounts codes (e.g. 5250 = Software &amp; Cloud Expenses, 5600 = Travel &amp; Conveyance).
              </p>
              <div className="grid md:grid-cols-4 gap-2">
                <Input placeholder="Vendor pattern e.g. render|render.com" value={newRule.match}
                  onChange={(e) => setNewRule({ ...newRule, match: e.target.value })} />
                <Input placeholder="Account code e.g. 5250" value={newRule.account_code}
                  onChange={(e) => setNewRule({ ...newRule, account_code: e.target.value })} />
                <Input placeholder="Label e.g. Software & Cloud Expenses" value={newRule.label}
                  onChange={(e) => setNewRule({ ...newRule, label: e.target.value })} />
                <Button onClick={addRule}><Plus className="h-4 w-4 mr-1" /> Add Rule</Button>
              </div>
            </div>

            <div className={`rounded-3xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendor Pattern</TableHead>
                    <TableHead>Account Code</TableHead>
                    <TableHead>Label</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rules.map((r, i) => (
                    <TableRow key={r.id || i}>
                      <TableCell className="font-mono text-xs">{r.match}</TableCell>
                      <TableCell>{r.account_code}</TableCell>
                      <TableCell>{r.label}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Review & Approve dialog — human sees the exact AI-drafted double-entry
          lines before anything is posted. */}
      <Dialog open={!!previewDoc} onOpenChange={(open) => { if (!open) { setPreviewDoc(null); setEditingLines(false); } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Bot className="h-5 w-5" /> Review AI-Drafted Entry</DialogTitle>
            <DialogDescription>
              Nothing is posted until you approve. Check the lines below against the source document before continuing.
            </DialogDescription>
          </DialogHeader>
          {previewDoc && (() => {
            const ex = previewDoc.extracted || {};
            const preview = previewDoc.preview || {};
            const lines = editingLines ? draftLines : (preview.lines || []);
            const totalDebit = editingLines ? draftTotalDebit : lines.reduce((s, l) => s + Number(l.debit || 0), 0);
            const totalCredit = editingLines ? draftTotalCredit : lines.reduce((s, l) => s + Number(l.credit || 0), 0);
            const acctLabel = (a) => (a ? `${a.code ? a.code + ' — ' : ''}${a.name}` : '');
            return (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <div><span className="text-slate-500">Company: </span>{previewDoc.company_name || '—'}</div>
                  <div><span className="text-slate-500">Type: </span>{ex.document_type || '—'}</div>
                  <div><span className="text-slate-500">Vendor / Customer: </span>{ex.vendor_or_customer_name || '—'}</div>
                  <div><span className="text-slate-500">Invoice #: </span>{ex.invoice_number || '—'}</div>
                  <div><span className="text-slate-500">Invoice Date: </span>{ex.invoice_date || '—'}</div>
                  <div><span className="text-slate-500">Company Match: </span>{previewDoc.company_match_reason || '—'}</div>
                </div>
                <div className={`rounded-xl border overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Account</TableHead>
                        <TableHead>Memo</TableHead>
                        <TableHead className="text-right">Debit</TableHead>
                        <TableHead className="text-right">Credit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {lines.map((l, i) => (
                        <TableRow key={i}>
                          <TableCell className="min-w-[180px]">
                            {editingLines ? (
                              <Select value={l.account_id} onValueChange={(v) => updateDraftLine(i, 'account_id', v)}>
                                <SelectTrigger className="h-9"><SelectValue placeholder="Account…" /></SelectTrigger>
                                <SelectContent>
                                  {accounts.map((a) => <SelectItem key={a.id} value={a.id}>{acctLabel(a)}</SelectItem>)}
                                </SelectContent>
                              </Select>
                            ) : l.account_name}
                          </TableCell>
                          <TableCell className="text-xs">{l.memo}</TableCell>
                          <TableCell className="text-right font-mono">
                            {editingLines ? (
                              <Input type="number" className="h-9 text-right" value={l.debit || ''}
                                onChange={(e) => updateDraftLine(i, 'debit', e.target.value)} />
                            ) : (l.debit ? fmtC(l.debit) : '')}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {editingLines ? (
                              <Input type="number" className="h-9 text-right" value={l.credit || ''}
                                onChange={(e) => updateDraftLine(i, 'credit', e.target.value)} />
                            ) : (l.credit ? fmtC(l.credit) : '')}
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow>
                        <TableCell colSpan={2} className="font-semibold">Total</TableCell>
                        <TableCell className="text-right font-mono font-semibold">{fmtC(totalDebit)}</TableCell>
                        <TableCell className="text-right font-mono font-semibold">{fmtC(totalCredit)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
                {editingLines && !draftBalanced && (
                  <p className="text-xs text-rose-500">Debits must equal credits before saving.</p>
                )}
                {!editingLines && preview.narration && <p className="text-xs text-slate-500">{preview.narration}</p>}
                {!editingLines && (
                  <Button size="sm" variant="outline" onClick={startEditingLines}>
                    <Pencil className="h-3.5 w-3.5 mr-1" /> Wrong account? Edit before approving
                  </Button>
                )}
              </div>
            );
          })()}
          <DialogFooter className="gap-2">
            {editingLines ? (
              <>
                <Button variant="outline" onClick={() => setEditingLines(false)} disabled={savingLines}>
                  <XIcon className="h-4 w-4 mr-1" /> Cancel
                </Button>
                <Button onClick={saveDraftLines} disabled={savingLines || !draftBalanced}>
                  {savingLines ? <RefreshCw className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
                  {savingLines ? 'Saving…' : 'Save correction'}
                </Button>
              </>
            ) : (
              <>
                <Button variant="destructive" onClick={() => { setRejectDoc(previewDoc); }} disabled={approving}>
                  <ThumbsDown className="h-4 w-4 mr-1" /> Reject
                </Button>
                <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => approveDoc(previewDoc.id)} disabled={approving}>
                  {approving ? <RefreshCw className="h-4 w-4 mr-1 animate-spin" /> : <ThumbsUp className="h-4 w-4 mr-1" />}
                  {approving ? 'Posting…' : 'Approve & Post to Ledger'}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog — mandatory reason, entry is discarded and never posted. */}
      <Dialog open={!!rejectDoc} onOpenChange={(open) => { if (!open) { setRejectDoc(null); setRejectReason(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject AI-Drafted Entry</DialogTitle>
            <DialogDescription>This document will not be posted. Give a short reason for the record.</DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="e.g. Wrong vendor detected, duplicate of an earlier upload…"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRejectDoc(null); setRejectReason(''); }} disabled={rejecting}>Cancel</Button>
            <Button variant="destructive" onClick={submitReject} disabled={rejecting}>
              {rejecting ? <RefreshCw className="h-4 w-4 mr-1 animate-spin" /> : <ThumbsDown className="h-4 w-4 mr-1" />}
              {rejecting ? 'Rejecting…' : 'Confirm Reject'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ZeroTouchEntry() {
  return (
    <RequestAccessGate module="post_journal_entries" moduleLabel="Zero-Touch Entry Engine" permissionFlag="can_post_journal_entries">
      <ZeroTouchEntryInner />
    </RequestAccessGate>
  );
}

export default ZeroTouchEntry;
