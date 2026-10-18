import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Lock, RefreshCw, ShieldCheck, PlusCircle, X, ArrowUpCircle, ArrowDownCircle, Wand2, SlidersHorizontal, Info } from 'lucide-react';
import { ContentLoader } from '@/components/ui/GifLoader.jsx';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import api from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { canPerformFinixAction } from '@/lib/commercialPermissionMatrix';
import { useDark } from '@/hooks/useDark';
import RequestAccessGate from '@/components/RequestAccessGate.jsx';
import { GuidanceNote } from '@/components/ui/GuidanceNote.jsx';

const fmtC = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// Accounts whose normal balance goes UP with a debit (asset, expense) vs
// accounts whose normal balance goes UP with a credit (liability, equity,
// income). This is what lets the modal ask "should this go up or down?"
// in plain English and work out the correct debit/credit itself.
const DEBIT_NORMAL_TYPES = ['asset', 'expense'];
const isDebitNormal = (type) => DEBIT_NORMAL_TYPES.includes((type || '').toLowerCase());

// direction: 'increase' | 'decrease'  →  returns 'debit' | 'credit'
function sideFor(accountType, direction) {
  const debitNormal = isDebitNormal(accountType);
  if (direction === 'increase') return debitNormal ? 'debit' : 'credit';
  return debitNormal ? 'credit' : 'debit';
}

const REASON_PRESETS = [
  { label: 'Wrong amount', text: 'The amount on this entry was entered incorrectly and needs to be corrected.' },
  { label: 'Wrong account used', text: 'This was recorded against the wrong account/category and needs to be moved to the correct one.' },
  { label: 'Duplicate entry', text: 'This entry was posted twice by mistake — this adjustment cancels out the duplicate.' },
];

function emptyAdvLine() { return { account_id: '', debit: '', credit: '', memo: '' }; }

function AdjustmentDrawer({ entry, accounts, isDark, onClose, onSaved }) {
  const [reason, setReason] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── Simple mode state ────────────────────────────────────────────────
  const [debitAccountId, setDebitAccountId] = useState('');
  const [creditAccountId, setCreditAccountId] = useState('');
  const [amount, setAmount] = useState('');

  // ── Advanced mode state (original multi-line debit/credit table) ─────
  const [advLines, setAdvLines] = useState([emptyAdvLine(), emptyAdvLine()]);

  const accountById = useMemo(() => {
    const m = {};
    accounts.forEach((a) => { m[a.id] = a; });
    return m;
  }, [accounts]);

  const acctLabel = (a) => (a ? `${a.code ? a.code + ' — ' : ''}${a.name}` : '');

  const updateAdvLine = (i, field, value) => {
    const next = [...advLines];
    next[i] = { ...next[i], [field]: field === 'debit' || field === 'credit' ? value : value };
    setAdvLines(next);
  };

  // Build the actual correcting lines the API expects, from whichever
  // mode is active.
  const builtLines = useMemo(() => {
    if (!advanced) {
      const dbAcct = accountById[debitAccountId];
      const crAcct = accountById[creditAccountId];
      const amt = Number(amount || 0);
      if (!dbAcct || !crAcct || !amt) return [];
      return [
        { account_id: dbAcct.id, account_name: acctLabel(dbAcct), debit: amt, credit: 0, memo: '' },
        { account_id: crAcct.id, account_name: acctLabel(crAcct), debit: 0, credit: amt, memo: '' },
      ];
    }
    return advLines
      .filter((l) => l.account_id && (Number(l.debit) > 0 || Number(l.credit) > 0))
      .map((l) => ({ account_id: l.account_id, account_name: acctLabel(accountById[l.account_id]), debit: Number(l.debit || 0), credit: Number(l.credit || 0), memo: l.memo }));
  }, [advanced, debitAccountId, creditAccountId, amount, advLines, accountById]);

  const totalDebit = builtLines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const totalCredit = builtLines.reduce((s, l) => s + Number(l.credit || 0), 0);
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01 && totalDebit > 0;

  const submit = async () => {
    if (reason.trim().length < 10) { toast.error('Please add a short reason (at least 10 characters).'); return; }
    if (builtLines.length < 2) { toast.error(advanced ? 'Add at least two lines.' : 'Pick both a Debit Account and a Credit Account, plus an amount.'); return; }
    if (!balanced) { toast.error(advanced ? 'Debits must equal credits.' : "Those two accounts can't be balanced against each other this way."); return; }
    setSaving(true);
    try {
      await api.post('/accounting-integrity/adjustment-note', {
        original_entry_id: entry.id,
        company_id: entry.company_id || '',
        reason: reason.trim(),
        correcting_lines: builtLines,
      });
      toast.success('Entry updated — the previous values are kept in Adjustment Note History for audit.');
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Could not post adjustment note');
    } finally {
      setSaving(false);
    }
  };

  const inputCls = isDark ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-white border-slate-200 text-slate-700';

  return (
    <div className="fixed inset-0 bg-emerald-900/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className={`w-full max-w-2xl rounded-2xl shadow-2xl p-6 my-8 ${isDark ? 'bg-slate-800' : 'bg-white'}`}>
        <div className="flex items-center justify-between mb-1">
          <h3 className={`font-bold text-lg ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Fix this entry</h3>
          <Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
        <p className={`text-sm mb-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          Correcting <span className="font-semibold">{entry.narration}</span> ({fmtC(entry.total_debit)}) — this updates the
          entry's own lines directly. The values it had before are kept in the Adjustment Note History below for the audit trail.
        </p>

        {/* Mode toggle */}
        <div className={`flex items-center gap-1 rounded-xl border p-1 mb-4 w-fit ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
          <button
            onClick={() => setAdvanced(false)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${!advanced ? 'text-white' : isDark ? 'text-slate-300' : 'text-slate-600'}`}
            style={!advanced ? { background: '#1F6FB2' } : {}}
          >
            <Wand2 className="h-3.5 w-3.5" /> Simple
          </button>
          <button
            onClick={() => setAdvanced(true)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${advanced ? 'text-white' : isDark ? 'text-slate-300' : 'text-slate-600'}`}
            style={advanced ? { background: '#1F6FB2' } : {}}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" /> Advanced
          </button>
        </div>

        {!advanced ? (
          <div className="space-y-3">
            <div className={`rounded-xl border p-3 ${isDark ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-emerald-50 border-emerald-200'}`}>
              <label className={`text-xs font-bold flex items-center gap-1.5 mb-1.5 ${isDark ? 'text-emerald-300' : 'text-emerald-800'}`}>
                <ArrowUpCircle className="h-3.5 w-3.5" /> Debit Account (increases assets / expenses, decreases liabilities)
              </label>
              <Select value={debitAccountId} onValueChange={setDebitAccountId}>
                <SelectTrigger className="h-10 bg-white"><SelectValue placeholder="Search for Debit account…" /></SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => <SelectItem key={a.id} value={a.id}>{acctLabel(a)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className={`rounded-xl border p-3 ${isDark ? 'bg-rose-500/10 border-rose-500/30' : 'bg-rose-50 border-rose-200'}`}>
              <label className={`text-xs font-bold flex items-center gap-1.5 mb-1.5 ${isDark ? 'text-rose-300' : 'text-rose-800'}`}>
                <ArrowDownCircle className="h-3.5 w-3.5" /> Credit Account (increases liabilities / equity / income, decreases assets)
              </label>
              <Select value={creditAccountId} onValueChange={setCreditAccountId}>
                <SelectTrigger className="h-10 bg-white"><SelectValue placeholder="Search for Credit account…" /></SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => <SelectItem key={a.id} value={a.id}>{acctLabel(a)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className={`text-xs font-bold mb-1.5 block ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>Amount</label>
              <Input type="number" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} />
            </div>

            {debitAccountId && creditAccountId && amount > 0 && (
              <p className={`text-sm rounded-xl p-3 ${isDark ? 'bg-slate-900/50 text-slate-300' : 'bg-slate-50 text-slate-600'}`}>
                This will debit <span className="font-bold">{acctLabel(accountById[debitAccountId])}</span> and credit{' '}
                <span className="font-bold">{acctLabel(accountById[creditAccountId])}</span> by <span className="font-bold">{fmtC(amount)}</span>.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className={`text-xs rounded-xl p-3 flex items-start gap-2 ${isDark ? 'bg-slate-900/50 text-slate-400' : 'bg-slate-50 text-slate-500'}`}>
              <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              Debit increases what you own or spend; Credit increases what you owe or earn. Totals must match below.
            </p>
            <div className="space-y-2">
              {advLines.map((l, i) => (
                <div key={i} className="grid grid-cols-[1fr_90px_90px_1fr_28px] gap-2 items-center">
                  <Select value={l.account_id} onValueChange={(v) => updateAdvLine(i, 'account_id', v)}>
                    <SelectTrigger className="h-9"><SelectValue placeholder="Account" /></SelectTrigger>
                    <SelectContent>
                      {accounts.map((a) => <SelectItem key={a.id} value={a.id}>{acctLabel(a)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input placeholder="Debit" type="number" value={l.debit} onChange={(e) => updateAdvLine(i, 'debit', e.target.value)} className="h-9" />
                  <Input placeholder="Credit" type="number" value={l.credit} onChange={(e) => updateAdvLine(i, 'credit', e.target.value)} className="h-9" />
                  <Input placeholder="Memo (optional)" value={l.memo} onChange={(e) => updateAdvLine(i, 'memo', e.target.value)} className="h-9" />
                  <button onClick={() => setAdvLines(advLines.filter((_, idx) => idx !== i))} className="text-slate-300 hover:text-rose-500"><X className="h-4 w-4" /></button>
                </div>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={() => setAdvLines([...advLines, emptyAdvLine()])}>
              <PlusCircle className="h-4 w-4 mr-1" /> Add line
            </Button>
            <div className={`flex items-center justify-between text-sm ${balanced ? 'text-emerald-500' : 'text-red-500'}`}>
              <span>Debit: {fmtC(totalDebit)} · Credit: {fmtC(totalCredit)}</span>
              <span>{balanced ? 'Balanced ✓' : 'Debits must equal credits'}</span>
            </div>
          </div>
        )}

        {/* Reason */}
        <div className="mt-5">
          <label className={`text-xs font-bold mb-1.5 block ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>Why is this being corrected?</label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {REASON_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => setReason(p.text)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border ${isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-700/50' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <Textarea placeholder="Reason for this adjustment (min 10 characters)…" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>{saving ? 'Posting…' : 'Post correction'}</Button>
        </div>
      </div>
    </div>
  );
}

function AccountingIntegrityInner() {
  const { user } = useAuth();
  // Adjustment notes rewrite a posted entry: an edit of Journal Entries.
  const canEditJournal = canPerformFinixAction(user, 'can_view_journal_entries', 'edit');
  const isDark = useDark();
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState([]);
  const [notes, setNotes] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [activeEntry, setActiveEntry] = useState(null);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [le, an, ac] = await Promise.allSettled([
        api.get('/accounting-integrity/locked-entries'),
        api.get('/accounting-integrity/adjustment-notes'),
        api.get('/chart-of-accounts'),
      ]);
      setLocked(le.status === 'fulfilled' ? le.value.data : []);
      setNotes(an.status === 'fulfilled' ? an.value.data : []);
      setAccounts(ac.status === 'fulfilled' ? (ac.value.data || []) : []);
    } catch {
      toast.error('Failed to load integrity data');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { fetchAll(); }, []);

  if (loading) return <ContentLoader />;

  const notesByEntry = notes.reduce((acc, n) => {
    (acc[n.original_entry_id] = acc[n.original_entry_id] || []).push(n);
    return acc;
  }, {});

  return (
    <div className={`min-h-screen ${isDark ? 'bg-slate-900' : 'bg-slate-50'}`}>
      <div className="p-4 md:p-6 space-y-5 max-w-[1200px] mx-auto">
        <div className="rounded-3xl overflow-hidden shadow-xl" style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}>
          <div className="p-6 md:p-7 flex flex-col lg:flex-row lg:items-center justify-between gap-5 text-white">
            <div className="flex items-start gap-4">
              <div className="h-14 w-14 rounded-2xl bg-white/15 border border-white/20 flex items-center justify-center shadow-lg">
                <Lock className="h-7 w-7" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.25em] text-blue-100 font-bold">AI Accounting · Module 4</p>
                <h1 className="text-2xl md:text-3xl font-bold tracking-tight mt-1">System Integrity &amp; Audit Trail</h1>
                <p className="text-sm text-blue-100 mt-1 max-w-2xl">System-generated journal entries are locked — corrections go through a tracked Adjustment Note Override, never a silent edit.</p>
              </div>
            </div>
            <Button onClick={fetchAll} variant="outline" className="bg-white/10 border-white/25 text-white hover:bg-white/20"><RefreshCw className="h-4 w-4 mr-2" /> Refresh</Button>
          </div>
        </div>

        <GuidanceNote pageKey="accounting-integrity" isDark={isDark} />

        <div className={`rounded-3xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
          <div className="p-4 border-b flex items-center gap-2" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
            <ShieldCheck className="h-4 w-4 text-emerald-500" />
            <h3 className={`font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Locked Entries (system-generated)</h3>
          </div>
          {locked.length === 0 ? (
            <p className={`p-6 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>No locked entries yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Narration</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead>Adjustments</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {locked.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>{e.entry_date}</TableCell>
                    <TableCell className="max-w-[280px] truncate">{e.narration}</TableCell>
                    <TableCell><Badge variant="outline">{e.source}</Badge></TableCell>
                    <TableCell className="text-right font-mono">{fmtC(e.total_debit)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtC(e.total_credit)}</TableCell>
                    <TableCell>
                      {notesByEntry[e.id]?.length
                        ? <Badge className="bg-amber-500 hover:bg-amber-500">{notesByEntry[e.id].length} note(s)</Badge>
                        : <span className={isDark ? 'text-slate-500' : 'text-slate-400'}>—</span>}
                    </TableCell>
                    <TableCell>
                      {canEditJournal && <Button size="sm" variant="outline" onClick={() => setActiveEntry(e)}>Fix this entry</Button>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <div className={`rounded-3xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
          <div className="p-4 border-b" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
            <h3 className={`font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Adjustment Note History</h3>
          </div>
          {notes.length === 0 ? (
            <p className={`p-6 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>No adjustment notes raised yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Raised At</TableHead>
                  <TableHead>Entry</TableHead>
                  <TableHead>Before</TableHead>
                  <TableHead>After</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {notes.map((n) => (
                  <TableRow key={n.id}>
                    <TableCell className="text-xs">{new Date(n.raised_at).toLocaleString('en-IN')}</TableCell>
                    <TableCell className="font-mono text-xs">{n.original_entry_id.slice(0, 8)}…</TableCell>
                    <TableCell className="font-mono text-xs">{fmtC(n.previous_total_debit ?? n.previous_total_credit)}</TableCell>
                    <TableCell className="font-mono text-xs">{fmtC(n.new_total_debit ?? n.new_total_credit)}</TableCell>
                    <TableCell className="max-w-[320px] truncate">{n.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      {activeEntry && (
        <AdjustmentDrawer
          entry={activeEntry}
          accounts={accounts}
          isDark={isDark}
          onClose={() => setActiveEntry(null)}
          onSaved={() => { setActiveEntry(null); fetchAll(); }}
        />
      )}
    </div>
  );
}

function AccountingIntegrity() {
  return (
    <RequestAccessGate module="manage_chart_of_accounts" moduleLabel="Accounting Integrity" permissionFlag="can_manage_chart_of_accounts">
      <AccountingIntegrityInner />
    </RequestAccessGate>
  );
}

export default AccountingIntegrity;
