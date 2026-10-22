import React, { useState } from 'react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { fyOptions } from '@/lib/books';
import { NOTE_STATUS, notesToText, pendingNotes } from '@/lib/standards';
import { DataTable, ErrorNote, GhostButton, Loading, Pill, PrimaryButton, Section, Stat, field, mutedCls, runAction, useLoad } from './ui.jsx';

const NOTES = '/accounting-books/notes';

function PolicyRow({ p, companyId, isDark, isAdmin, onDone }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(p.text);
  const [busy, setBusy] = useState(false);
  const save = async () => { if (await runAction(setBusy, () => api.put(`${NOTES}/policies/${p.key}`, { company_id: companyId, text }), 'Policy updated')) { setEditing(false); onDone(); } };
  const reset = async () => { if (await runAction(setBusy, () => api.delete(`${NOTES}/policies/${p.key}`, { params: { company_id: companyId } }), 'Policy reset')) { setEditing(false); onDone(); } };
  return (
    <div className="py-2">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold">{p.title} <span className={`font-normal text-xs ${mutedCls(isDark)}`}>({p.standard}){p.is_custom && ' · edited'}</span></p>
        {isAdmin && !editing && <GhostButton isDark={isDark} className="print:hidden" onClick={() => setEditing(true)}>Edit</GhostButton>}
      </div>
      {editing ? (
        <div className="mt-2 space-y-2">
          <textarea aria-label={`Policy: ${p.title}`} value={text} onChange={(e) => setText(e.target.value)} rows={4} className={`${field(isDark)} w-full h-auto py-2`} />
          <div className="flex gap-2 justify-end">
            {p.is_custom && <GhostButton isDark={isDark} onClick={reset} disabled={busy}>Use standard wording</GhostButton>}
            <GhostButton isDark={isDark} onClick={() => { setEditing(false); setText(p.text); }}>Cancel</GhostButton>
            <PrimaryButton onClick={save} disabled={busy || text.trim().length < 10}>Save</PrimaryButton>
          </div>
        </div>
      ) : <p className={`text-sm mt-0.5 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{p.text}</p>}
    </div>
  );
}

function NoteBody({ s, companyId, isDark, isAdmin, onDone }) {
  if (s.kind === 'policies') return <div className={`divide-y ${isDark ? 'divide-slate-700' : 'divide-slate-200'}`}>{s.policies.map((p) => <PolicyRow key={p.key} p={p} companyId={companyId} isDark={isDark} isAdmin={isAdmin} onDone={onDone} />)}</div>;
  const table = (cols, rows) => (
    <DataTable isDark={isDark} rowKey="i" rows={rows.map((r, i) => ({ i, cells: r }))}
      columns={cols.map((c, ci) => ({ key: String(ci), label: c, align: ci > 0 ? 'right' : undefined, render: (r) => r.cells[ci] }))} />
  );
  return (
    <div className="space-y-3">
      {s.text && <p className={`text-sm ${s.status === 'needs_input' ? 'text-amber-600' : isDark ? 'text-slate-300' : 'text-slate-600'}`}>{s.text}</p>}
      {s.columns && table(s.columns, s.rows)}
      {s.second_table && (<div><p className="text-sm font-semibold mb-1">{s.second_table.title}</p>{table(s.second_table.columns, s.second_table.rows)}</div>)}
      {s.hint && <p className="text-xs text-amber-600">{s.hint}</p>}
    </div>
  );
}

export default function NotesTab({ companyId, isDark, isAdmin }) {
  const [fy, setFy] = useState(fyOptions()[0]);
  const { data, loading, error, reload } = useLoad(() => api.get(NOTES, { params: { company_id: companyId, fy } }).then((r) => r.data), [companyId, fy]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(notesToText(data)); toast.success('Notes copied as text'); } catch { toast.error('Could not copy. Use Print instead.'); }
  };
  if (loading) return <Loading />;
  if (error) return <ErrorNote error={error} isDark={isDark} />;
  const pending = pendingNotes(data.sections);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex items-center gap-2">
          <select aria-label="Financial year" value={fy} onChange={(e) => setFy(e.target.value)} className={field(isDark)}>{fyOptions().map((y) => <option key={y} value={y}>{y}</option>)}</select>
          <Pill tone="info">{data.framework === 'IND_AS' ? 'Ind AS' : 'ICAI AS'}</Pill>
        </div>
        <div className="flex gap-2"><GhostButton isDark={isDark} onClick={reload}>Refresh</GhostButton><GhostButton isDark={isDark} onClick={copy}>Copy as text</GhostButton><PrimaryButton onClick={() => window.print()}>Print</PrimaryButton></div>
      </div>
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <Stat label="Revenue" value={`₹${Number(data.summary.revenue).toLocaleString('en-IN')}`} isDark={isDark} />
        <Stat label="Profit after tax" value={`₹${Number(data.summary.profit_after_tax).toLocaleString('en-IN')}`} isDark={isDark} />
        <Stat label="Balance sheet" value={data.summary.balance_sheet_balanced ? 'Balances' : 'Does not balance'} tone={data.summary.balance_sheet_balanced ? 'good' : 'bad'} isDark={isDark} />
        <Stat label="Notes needing input" value={pending.length} tone={pending.length ? 'bad' : 'good'} hint={pending.length ? 'Listed below' : 'Ready to review'} isDark={isDark} />
      </div>
      {pending.length > 0 && (
        <div role="status" className={`rounded-xl border p-3 text-sm ${isDark ? 'border-amber-700 bg-amber-900/20 text-amber-200' : 'border-amber-300 bg-amber-50 text-amber-900'}`}>
          Complete these before approving the accounts: {pending.map((p) => p.title).join(', ')}.
        </div>
      )}
      {data.sections.map((s) => {
        const st = NOTE_STATUS[s.status] || NOTE_STATUS.complete;
        return (
          <Section key={s.no} isDark={isDark} title={`${s.no}. ${s.title}`} action={<span className="flex items-center gap-2"><span className={`text-xs ${mutedCls(isDark)}`}>{s.standard}</span><Pill tone={st.tone}>{st.label}</Pill></span>}>
            <NoteBody s={s} companyId={companyId} isDark={isDark} isAdmin={isAdmin} onDone={reload} />
          </Section>
        );
      })}
    </div>
  );
}
