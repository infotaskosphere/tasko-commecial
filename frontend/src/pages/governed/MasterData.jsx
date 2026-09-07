// MasterData.jsx — Admin → Master Data.
// Central source for company profiles, company users and shared reference data.
// User administration intentionally lives here as a company-level capability;
// People Matrix is not required for creating or approving a user.

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Plus, Trash2, Pencil, Loader2, Database, Building2, Search, Download, Upload,
  Copy, Archive, RotateCcw, Check, X, ListTree, Tag,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import api from '@/lib/api';
import { toast } from 'sonner';
import useDark from '@/hooks/useDark';
import { ActionGuard } from '@/components/governance/GovernanceGuards';
import { CompanyProfilesList } from '@/components/CompanyProfiles';
import CompanyUserManager from '@/components/CompanyUserManager';
import {
  PageShell, PageBanner, StatRow, SectionCard, EmptyState, LoadingState, Toolbar, HUB_COLORS,
} from '@/components/ui/PageKit';

const MODULE = 'admin';
const VIEW_FLAG = 'can_view_master_data';
const API_PATH = '/master-data';

const DEFAULT_CATEGORIES = [
  'Department', 'Task Category', 'Client Category', 'Document Type',
  'Expense Head', 'Service', 'Bank', 'Other',
];

export default function MasterData() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [companyCount, setCompanyCount] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(API_PATH);
      setItems(Array.isArray(data) ? data : []);
    } catch {
      /* PageGuard handles access errors. */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/companies');
        setCompanyCount(Array.isArray(data) ? data.length : 0);
      } catch { setCompanyCount(null); }
    })();
  }, []);

  const active = items.filter((i) => (i.status || 'open') !== 'archived').length;
  const categories = useMemo(() => {
    const set = new Set(DEFAULT_CATEGORIES);
    items.forEach((i) => { if (i.extra?.category) set.add(i.extra.category); });
    return [...set].sort();
  }, [items]);

  return (
    <PageShell className="master-data-page-shell">
      <PageBanner
        icon={Database}
        eyebrow="Admin"
        title="Master Data"
        subtitle="One place for company profiles, users and the shared reference lists every other module reads from."
      />

      <StatRow
        items={[
          { icon: Building2, label: 'Company profiles', value: companyCount ?? '—', color: HUB_COLORS.mediumBlue },
          { icon: ListTree, label: 'Reference entries', value: items.length, color: '#7C3AED' },
          { icon: Check, label: 'Active', value: active, color: HUB_COLORS.emeraldGreen },
          { icon: Archive, label: 'Archived', value: items.length - active, color: '#F59E0B' },
        ]}
      />

      <SectionCard
        icon={Building2}
        title="Company Profiles"
        badge={companyCount ?? undefined}
        description="Name, address, GSTIN/PAN, bank details, logos & SMTP — the shared company master used by Quotations, Invoicing, Trademark Sphere, WhatsApp/Email settings and GST Portal Sync."
      >
        <CompanyProfilesList />
      </SectionCard>

      <CompanyUserManager />

      <ReferenceData items={items} loading={loading} reload={load} categories={categories} />
    </PageShell>
  );
}

function ReferenceData({ items, loading, reload, categories }) {
  const isDark = useDark();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState('active');
  const [sort, setSort] = useState('newest');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({ title: '', code: '', category: '', details: '' });

  const resetDraft = () => setDraft({ title: '', code: '', category: '', details: '' });

  const visible = useMemo(() => {
    let list = [...items];
    if (status !== 'all') {
      list = list.filter((i) => status === 'archived' ? i.status === 'archived' : (i.status || 'open') !== 'archived');
    }
    if (category !== 'all') list = list.filter((i) => (i.extra?.category || 'Other') === category);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((i) => `${i.title || ''} ${i.details || ''} ${i.extra?.code || ''} ${i.extra?.category || ''}`.toLowerCase().includes(q));
    list.sort((a, b) => {
      if (sort === 'az') return (a.title || '').localeCompare(b.title || '');
      if (sort === 'category') return (a.extra?.category || '').localeCompare(b.extra?.category || '') || (a.title || '').localeCompare(b.title || '');
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
    return list;
  }, [items, search, category, status, sort]);

  const save = async () => {
    if (!draft.title.trim()) return;
    setBusy(true);
    try {
      const payload = { title: draft.title.trim(), details: draft.details.trim() || null, extra: { category: draft.category || 'Other', code: draft.code.trim() || null } };
      if (editingId) { await api.put(`${API_PATH}/${editingId}`, payload); toast.success('Updated'); }
      else { await api.post(API_PATH, payload); toast.success('Added'); }
      resetDraft(); setEditingId(null); setAdding(false); reload();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Could not save'); }
    finally { setBusy(false); }
  };

  const startEdit = (item) => {
    setEditingId(item.id); setAdding(true);
    setDraft({ title: item.title || '', code: item.extra?.code || '', category: item.extra?.category || '', details: item.details || '' });
  };

  const duplicate = async (item) => {
    try { await api.post(API_PATH, { title: `${item.title} (copy)`, details: item.details || null, extra: item.extra || {} }); toast.success('Duplicated'); reload(); }
    catch (e) { toast.error(e?.response?.data?.detail || 'Could not duplicate'); }
  };

  const setArchived = async (item, archived) => {
    try { await api.put(`${API_PATH}/${item.id}`, { status: archived ? 'archived' : 'open' }); toast.success(archived ? 'Archived' : 'Restored'); reload(); }
    catch (e) { toast.error(e?.response?.data?.detail || 'Could not update'); }
  };

  const remove = async (item) => {
    if (!window.confirm(`Delete “${item.title}” permanently?`)) return;
    try { await api.delete(`${API_PATH}/${item.id}`); toast.success('Deleted'); reload(); }
    catch (e) { toast.error(e?.response?.data?.detail || 'Could not delete'); }
  };

  const exportCsv = () => {
    const rows = [['Category', 'Code', 'Title', 'Details', 'Status', 'Created by']];
    visible.forEach((i) => rows.push([i.extra?.category || '', i.extra?.code || '', i.title || '', i.details || '', i.status || '', i.created_by_name || '']));
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a'); a.href = url; a.download = `master-data-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  const importCsv = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(Boolean).slice(1);
      let ok = 0;
      for (const line of lines) {
        const cells = line.match(/("([^"]|"")*"|[^,]*)/g)?.filter((_, idx) => idx % 2 === 0) || [];
        const clean = cells.map((c) => c.replace(/^"|"$/g, '').replace(/""/g, '"').trim());
        const [cat, code, title, details] = clean;
        if (!title) continue;
        await api.post(API_PATH, { title, details: details || null, extra: { category: cat || 'Other', code: code || null } });
        ok += 1;
      }
      toast.success(`Imported ${ok} row${ok === 1 ? '' : 's'}`); reload();
    } catch { toast.error('Could not import that CSV'); }
    finally { setBusy(false); }
  };

  return (
    <SectionCard
      icon={ListTree} color="#7C3AED" title="Reference Data" badge={visible.length}
      description="Departments, task/client categories, document types, expense heads and any other shared lookup list."
      actions={<>
        <Button size="sm" variant="outline" onClick={exportCsv} disabled={!visible.length}><Download className="w-3.5 h-3.5 mr-1" /> Export</Button>
        <ActionGuard module={MODULE} page={VIEW_FLAG} action="create"><label className="inline-flex"><input type="file" accept=".csv" className="hidden" onChange={(e) => { importCsv(e.target.files?.[0]); e.target.value = ''; }} /><Button size="sm" variant="outline" asChild><span><Upload className="w-3.5 h-3.5 mr-1" /> Import CSV</span></Button></label></ActionGuard>
        <ActionGuard module={MODULE} page={VIEW_FLAG} action="create"><Button size="sm" onClick={() => { setEditingId(null); resetDraft(); setAdding((a) => !a); }}><Plus className="w-3.5 h-3.5 mr-1" /> Add entry</Button></ActionGuard>
      </>}
    >
      {adding && <div className={`p-4 mb-4 space-y-3 border ${isDark ? 'bg-slate-900/40 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <select className={`h-10 border px-3 text-sm ${isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-200'}`} value={draft.category} onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}><option value="">Category…</option>{categories.map((c) => <option key={c} value={c}>{c}</option>)}</select>
          <Input placeholder="Code (optional, e.g. DEPT-GST)" value={draft.code} onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value }))} />
          <Input placeholder="Title *" value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
        </div>
        <Input placeholder="Details / description (optional)" value={draft.details} onChange={(e) => setDraft((d) => ({ ...d, details: e.target.value }))} />
        <div className="flex gap-2"><Button onClick={save} disabled={busy || !draft.title.trim()}>{busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />}{editingId ? 'Save changes' : 'Add entry'}</Button><Button variant="ghost" onClick={() => { setAdding(false); setEditingId(null); resetDraft(); }}><X className="w-4 h-4 mr-1" /> Cancel</Button></div>
      </div>}

      <Toolbar className="mb-4">
        <div className="relative flex-1 min-w-[200px]"><Search className="w-4 h-4 absolute left-2.5 top-2.5 text-slate-400" /><Input className="pl-8" placeholder="Search title, code or details…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <select className={`h-10 border px-3 text-sm ${isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-200'}`} value={category} onChange={(e) => setCategory(e.target.value)}><option value="all">All categories</option>{categories.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <select className={`h-10 border px-3 text-sm ${isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-200'}`} value={status} onChange={(e) => setStatus(e.target.value)}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option></select>
        <select className={`h-10 border px-3 text-sm ${isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-200'}`} value={sort} onChange={(e) => setSort(e.target.value)}><option value="newest">Newest first</option><option value="az">A → Z</option><option value="category">By category</option></select>
      </Toolbar>

      {loading ? <LoadingState /> : visible.length === 0 ? <EmptyState icon={Database} title="No reference data yet" hint="Add departments, task categories, document types or any other list your team picks from." /> : (
        <div className="space-y-2">
          {visible.map((item) => <div key={item.id} className={`px-4 py-3 flex items-start justify-between gap-4 border ${isDark ? 'bg-slate-900/40 border-slate-700' : 'bg-slate-50 border-slate-100'} ${item.status === 'archived' ? 'opacity-60' : ''}`}>
            <div className="min-w-0"><div className="flex items-center gap-2 flex-wrap">{item.extra?.category && <span className="text-[10px] font-extrabold px-2 py-0.5 bg-[#7C3AED]/15 text-[#7C3AED] inline-flex items-center gap-1"><Tag className="w-3 h-3" /> {item.extra.category}</span>}<span className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{item.title}</span>{item.extra?.code && <span className="text-[10px] font-mono px-1.5 py-0.5 bg-slate-500/15 text-slate-400">{item.extra.code}</span>}{item.status === 'archived' && <span className="text-[10px] font-bold px-2 py-0.5 bg-amber-500/15 text-amber-600">Archived</span>}</div>{item.details && <p className={`text-xs mt-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{item.details}</p>}<p className="text-[11px] text-slate-400 mt-1">{item.created_by_name || 'Unknown'}{item.created_at ? ` · ${new Date(item.created_at).toLocaleDateString()}` : ''}</p></div>
            <div className="flex gap-1 shrink-0"><ActionGuard module={MODULE} page={VIEW_FLAG} action="create"><Button variant="ghost" size="icon" title="Duplicate" onClick={() => duplicate(item)}><Copy className="w-4 h-4" /></Button></ActionGuard><ActionGuard module={MODULE} page={VIEW_FLAG} action="edit"><Button variant="ghost" size="icon" title="Edit" onClick={() => startEdit(item)}><Pencil className="w-4 h-4" /></Button></ActionGuard><ActionGuard module={MODULE} page={VIEW_FLAG} action="edit"><Button variant="ghost" size="icon" title={item.status === 'archived' ? 'Restore' : 'Archive'} onClick={() => setArchived(item, item.status !== 'archived')}>{item.status === 'archived' ? <RotateCcw className="w-4 h-4" /> : <Archive className="w-4 h-4" />}</Button></ActionGuard><ActionGuard module={MODULE} page={VIEW_FLAG} action="delete"><Button variant="ghost" size="icon" title="Delete" onClick={() => remove(item)}><Trash2 className="w-4 h-4 text-red-500" /></Button></ActionGuard></div>
          </div>)}
        </div>
      )}
    </SectionCard>
  );
}
