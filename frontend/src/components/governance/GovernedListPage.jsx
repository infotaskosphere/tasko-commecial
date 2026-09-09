// GovernedListPage.jsx — shared list/create/edit/delete UI for the governed
// stub modules (Leave, Payroll, HR, Client Discussion, Roles, …). Each of
// those pages is a thin wrapper around this component, so restyling it here
// aligns ALL of them with the Dashboard design system in one shot.
//
// Now built on @/components/ui/PageKit (gradient banner + KPI tiles +
// SectionCards) and upgraded with search, status filter, inline edit,
// archive/restore and CSV export — same interaction language as Master Data.

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Plus, Trash2, Pencil, Loader2, Search, Download, Check, X, Archive, RotateCcw, ListTree,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import api from '@/lib/api';
import { toast } from 'sonner';
import useDark from '@/hooks/useDark';
import { ActionGuard } from '@/components/governance/GovernanceGuards';
import {
  PageShell, PageBanner, StatRow, SectionCard, EmptyState, LoadingState, Toolbar, HUB_COLORS,
} from '@/components/ui/PageKit';

export default function GovernedListPage({
  title,
  description,
  apiPath,
  module,
  pageFlag,
  icon: Icon = ListTree,
  eyebrow,
  color = HUB_COLORS.mediumBlue,
  width = 'medium',
}) {
  const isDark = useDark();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({ title: '', details: '' });
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('active');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(apiPath);
      setItems(Array.isArray(data) ? data : []);
    } catch {
      /* PageGuard handles 403s */
    } finally {
      setLoading(false);
    }
  }, [apiPath]);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => {
    let list = [...items];
    if (status !== 'all') {
      list = list.filter((i) =>
        status === 'archived' ? i.status === 'archived' : (i.status || 'open') !== 'archived');
    }
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((i) => `${i.title || ''} ${i.details || ''}`.toLowerCase().includes(q));
    return list;
  }, [items, search, status]);

  const activeCount = items.filter((i) => (i.status || 'open') !== 'archived').length;

  const save = async () => {
    if (!draft.title.trim()) return;
    setBusy(true);
    try {
      const payload = { title: draft.title.trim(), details: draft.details.trim() || null };
      if (editingId) await api.put(`${apiPath}/${editingId}`, payload);
      else await api.post(apiPath, payload);
      toast.success(editingId ? 'Updated' : 'Created');
      setDraft({ title: '', details: '' });
      setEditingId(null);
      setAdding(false);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const setArchived = async (item, archived) => {
    try {
      await api.put(`${apiPath}/${item.id}`, { status: archived ? 'archived' : 'open' });
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not update');
    }
  };

  const remove = async (item) => {
    if (!window.confirm(`Delete “${item.title}” permanently?`)) return;
    try {
      await api.delete(`${apiPath}/${item.id}`);
      toast.success('Deleted');
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not delete');
    }
  };

  const exportCsv = () => {
    const rows = [['Title', 'Details', 'Status', 'Created by', 'Created at']];
    visible.forEach((i) => rows.push([
      i.title || '', i.details || '', i.status || '', i.created_by_name || '', i.created_at || '',
    ]));
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(title || 'export').toLowerCase().replace(/\s+/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <PageShell width={width}>
      <PageBanner icon={Icon} eyebrow={eyebrow || module} title={title} subtitle={description} />

      <StatRow
        columns={3}
        items={[
          { icon: ListTree, label: 'Total records', value: items.length, color },
          { icon: Check, label: 'Active', value: activeCount, color: HUB_COLORS.emeraldGreen },
          { icon: Archive, label: 'Archived', value: items.length - activeCount, color: '#F59E0B' },
        ]}
      />

      <SectionCard
        icon={Icon}
        color={color}
        title={title}
        badge={visible.length}
        actions={
          <>
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={!visible.length}>
              <Download className="w-3.5 h-3.5 mr-1" /> Export
            </Button>
            <ActionGuard module={module} page={pageFlag} action="create">
              <Button
                size="sm"
                onClick={() => { setEditingId(null); setDraft({ title: '', details: '' }); setAdding((a) => !a); }}
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add
              </Button>
            </ActionGuard>
          </>
        }
      >
        {adding && (
          <div className={`rounded-xl p-4 mb-4 space-y-3 ${isDark ? 'bg-slate-900/40' : 'bg-slate-50'}`}>
            <Input
              placeholder="Title *"
              aria-label="Discussion title"
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            />
            <Input
              placeholder="Details (optional)"
              aria-label="Discussion details"
              value={draft.details}
              onChange={(e) => setDraft((d) => ({ ...d, details: e.target.value }))}
            />
            <div className="flex gap-2 flex-wrap">
              <Button onClick={save} disabled={busy || !draft.title.trim()}>
                {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />}
                {editingId ? 'Save changes' : 'Add'}
              </Button>
              <Button variant="ghost" onClick={() => { setAdding(false); setEditingId(null); }}>
                <X className="w-4 h-4 mr-1" /> Cancel
              </Button>
            </div>
          </div>
        )}

        <Toolbar className="mb-4">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-slate-400" aria-hidden="true" />
            <Input
              className="pl-8"
              placeholder="Search discussions…"
              aria-label="Search discussions"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            aria-label="Discussion status filter"
            className={`h-10 rounded-md border px-3 text-sm ${
              isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-200'
            }`}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </select>
        </Toolbar>

        {loading ? (
          <LoadingState />
        ) : visible.length === 0 ? (
          <EmptyState title="No discussions yet" hint="Add the first client discussion record to get started." />
        ) : (
          <div className="space-y-2">
            {visible.map((item) => (
              <div
                key={item.id}
                className={`rounded-xl px-4 py-3 flex items-start justify-between gap-4 min-w-0 ${
                  isDark ? 'bg-slate-900/40' : 'bg-slate-50'
                } ${item.status === 'archived' ? 'opacity-60' : ''}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-sm font-semibold break-words ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                      {item.title}
                    </span>
                    {item.status === 'archived' && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 shrink-0">
                        Archived
                      </span>
                    )}
                  </div>
                  {item.details && (
                    <p className={`text-xs mt-1 leading-relaxed break-words ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{item.details}</p>
                  )}
                  <p className="text-[11px] text-slate-400 mt-1 break-words">
                    {item.created_by_name || 'Unknown'}
                    {item.created_at ? ` · ${new Date(item.created_at).toLocaleDateString()}` : ''}
                  </p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <ActionGuard module={module} page={pageFlag} action="edit">
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Edit discussion"
                      aria-label="Edit discussion"
                      onClick={() => {
                        setEditingId(item.id);
                        setAdding(true);
                        setDraft({ title: item.title || '', details: item.details || '' });
                      }}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                  </ActionGuard>
                  <ActionGuard module={module} page={pageFlag} action="edit">
                    <Button
                      variant="ghost"
                      size="icon"
                      title={item.status === 'archived' ? 'Restore discussion' : 'Archive discussion'}
                      aria-label={item.status === 'archived' ? 'Restore discussion' : 'Archive discussion'}
                      onClick={() => setArchived(item, item.status !== 'archived')}
                    >
                      {item.status === 'archived' ? <RotateCcw className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
                    </Button>
                  </ActionGuard>
                  <ActionGuard module={module} page={pageFlag} action="delete">
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Delete discussion"
                      aria-label="Delete discussion"
                      onClick={() => remove(item)}
                    >
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </Button>
                  </ActionGuard>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </PageShell>
  );
}
