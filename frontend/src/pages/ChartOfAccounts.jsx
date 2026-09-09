import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { BookOpen, Plus, RefreshCw, Trash2, Layers, AlertTriangle } from 'lucide-react';
import GifLoader, { MiniLoader, ContentLoader } from '@/components/ui/GifLoader.jsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import api from '@/lib/api';
import { useDark } from '@/hooks/useDark';
import RequestAccessGate from '@/components/RequestAccessGate.jsx';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { GuidanceNote } from '@/components/ui/GuidanceNote.jsx';

const COLORS = { deepBlue: '#0D3B66', mediumBlue: '#1F6FB2', emeraldGreen: '#1FAF5A', amber: '#F59E0B', coral: '#FF6B6B' };
const TYPE_COLOR = { asset: COLORS.mediumBlue, liability: COLORS.coral, equity: COLORS.deepBlue, income: COLORS.emeraldGreen, expense: COLORS.amber };

function ChartOfAccountsInner() {
  const isDark = useDark();
  const { hasPermission, user } = useAuth();
  const canManage = user?.role === 'admin' || hasPermission('can_manage_chart_of_accounts');
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [typeFilter, setTypeFilter] = useState('all');
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', type: 'expense', sub_type: '' });
  const [saving, setSaving] = useState(false);

  const fetchAccounts = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/chart-of-accounts');
      setAccounts(data || []);
    } catch {
      toast.error('Failed to load chart of accounts');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { fetchAccounts(); }, []);

  const filtered = useMemo(() => typeFilter === 'all' ? accounts : accounts.filter(a => a.type === typeFilter), [accounts, typeFilter]);
  const grouped = useMemo(() => {
    const g = {};
    filtered.forEach(a => { (g[a.type] = g[a.type] || []).push(a); });
    return g;
  }, [filtered]);

  const createAccount = async () => {
    if (!form.code.trim() || !form.name.trim()) { toast.error('Code and name are required'); return; }
    setSaving(true);
    try {
      await api.post('/chart-of-accounts', form);
      toast.success('Account added');
      setShowNew(false);
      setForm({ code: '', name: '', type: 'expense', sub_type: '' });
      await fetchAccounts();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to add account');
    } finally {
      setSaving(false);
    }
  };

  const [showReview, setShowReview] = useState(false);
  const [suspectAccounts, setSuspectAccounts] = useState([]);
  const [reviewLoading, setReviewLoading] = useState(false);

  const loadSuspectAccounts = async () => {
    setReviewLoading(true);
    try {
      const { data } = await api.get('/chart-of-accounts/review-imports');
      setSuspectAccounts(data?.accounts || []);
    } catch {
      toast.error('Failed to load imported-account review');
    } finally {
      setReviewLoading(false);
    }
  };

  const purgeAccount = async (id, name) => {
    if (!window.confirm(`Delete \"${name}\" and every journal entry posted against it? This cannot be undone — if this balance is real, re-enter it via Accounting Reports → Add Opening Balance afterwards.`)) return;
    try {
      await api.delete(`/chart-of-accounts/${id}`, { params: { purge: true } });
      toast.success('Account and its entries removed');
      setSuspectAccounts(prev => prev.filter(a => a.account_id !== id));
      await fetchAccounts();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to delete');
    }
  };

  const deleteAccount = async (id) => {
    if (!window.confirm('Delete this account?')) return;
    try {
      await api.delete(`/chart-of-accounts/${id}`);
      toast.success('Account deleted');
      await fetchAccounts();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to delete — it may have journal entries posted against it.');
    }
  };

  if (loading) return <ContentLoader />;

  return (
    <div className={`min-h-full min-w-0 ${isDark ? 'bg-slate-900' : 'bg-slate-50'}`}>
      <div className="space-y-5 w-full min-w-0">
        <div className="rounded-3xl overflow-hidden shadow-xl min-w-0" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
          <div className="p-6 md:p-7 flex flex-col lg:flex-row lg:items-center justify-between gap-5 text-white min-w-0">
            <div className="flex items-start gap-4 min-w-0 flex-1">
              <div className="h-14 w-14 rounded-2xl bg-white/15 border border-white/20 flex items-center justify-center shadow-lg flex-shrink-0">
                <BookOpen className="h-7 w-7" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs uppercase tracking-[0.25em] text-blue-100 font-bold">Accounts</p>
                <h1 className="text-2xl md:text-3xl font-bold tracking-tight mt-1 break-words">Chart of Accounts</h1>
                <p className="text-sm text-blue-100 mt-1 max-w-2xl break-words">Assets, liabilities, equity, income and expense heads — the foundation every journal entry, ledger, and report is built on.</p>
              </div>
            </div>
            <div className="flex w-full lg:w-auto lg:max-w-[60%] flex-wrap items-center justify-start lg:justify-end gap-2 min-w-0">
              {canManage && <Button onClick={() => { setShowReview(true); loadSuspectAccounts(); }} variant="outline" className="w-full sm:w-auto max-w-full bg-white/10 border-white/25 text-white hover:bg-white/20"><AlertTriangle className="h-4 w-4 mr-2" /> Review imported balances</Button>}
              {canManage && <Button onClick={() => setShowNew(true)} variant="outline" className="w-full sm:w-auto max-w-full bg-white/10 border-white/25 text-white hover:bg-white/20"><Plus className="h-4 w-4 mr-2" /> Add account</Button>}
              <Button onClick={fetchAccounts} variant="outline" className="w-full sm:w-auto max-w-full bg-white/10 border-white/25 text-white hover:bg-white/20"><RefreshCw className="h-4 w-4 mr-2" /> Refresh</Button>
            </div>
          </div>
        </div>

        <GuidanceNote pageKey="chart-of-accounts" isDark={isDark} />

        <div className="flex gap-2 flex-wrap min-w-0">
          {['all', 'asset', 'liability', 'equity', 'income', 'expense'].map(t => (
            <button key={t} onClick={() => setTypeFilter(t)}
              className={`px-4 py-2 rounded-xl text-sm font-semibold border capitalize max-w-full ${typeFilter === t ? 'text-white' : isDark ? 'text-slate-300 border-slate-700' : 'text-slate-600 border-slate-200'}`}
              style={typeFilter === t ? { background: t === 'all' ? COLORS.deepBlue : TYPE_COLOR[t], borderColor: 'transparent' } : {}}
            >{t}</button>
          ))}
        </div>

        <div className="grid md:grid-cols-2 gap-4 min-w-0">
          {Object.entries(grouped).map(([type, accts]) => (
            <div key={type} className={`rounded-3xl border shadow-sm overflow-hidden min-w-0 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className="p-4 border-b flex items-center gap-2 min-w-0" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
                <Layers className="h-4 w-4 flex-shrink-0" style={{ color: TYPE_COLOR[type] }} />
                <h3 className={`font-bold capitalize min-w-0 truncate ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{type}</h3>
                <span className="text-xs text-slate-400 flex-shrink-0">{accts.length} accounts</span>
              </div>
              <div className="divide-y min-w-0" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
                {accts.map(a => (
                  <div key={a.id} className={`p-3 flex items-center justify-between gap-3 min-w-0 ${isDark ? 'hover:bg-slate-700/40' : 'hover:bg-slate-50'}`}>
                    <div className="min-w-0 flex-1 flex items-center gap-3">
                      <span className={`text-xs font-mono px-2 py-1 rounded-lg flex-shrink-0 max-w-full ${isDark ? 'bg-slate-900 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>{a.code}</span>
                      <p className={`text-sm font-semibold min-w-0 truncate ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{a.name}</p>
                    </div>
                    {canManage && !a.is_system && (
                      <button onClick={() => deleteAccount(a.id)} className="text-slate-300 hover:text-rose-500 flex-shrink-0"><Trash2 className="h-4 w-4" /></button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent className="w-[calc(100%-1.5rem)] sm:max-w-md max-w-full min-w-0">
          <DialogHeader><DialogTitle className="break-words">Add account</DialogTitle></DialogHeader>
          <div className="space-y-3 mt-2 min-w-0">
            <Input placeholder="Account code (e.g. 5600)" value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} />
            <Input placeholder="Account name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            <Select value={form.type} onValueChange={v => setForm(f => ({ ...f, type: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {['asset', 'liability', 'equity', 'income', 'expense'].map(t => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input placeholder="Sub-type (optional, e.g. operating_expense)" value={form.sub_type} onChange={e => setForm(f => ({ ...f, sub_type: v }))} />
            <Button onClick={createAccount} disabled={saving} className="w-full rounded-xl">{saving ? <MiniLoader height={18} /> : 'Save account'}</Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={showReview} onOpenChange={setShowReview}>
        <DialogContent className="w-[calc(100%-1.5rem)] max-w-2xl max-h-[80vh] overflow-y-auto min-w-0">
          <DialogHeader><DialogTitle className="break-words">Review imported / backup balances</DialogTitle></DialogHeader>
          <p className="text-xs text-slate-500 -mt-1 break-words">
            These accounts have at least one entry that wasn't posted by a real sale, purchase, or payment in the app —
            typically ledgers created while importing old-system/backup data to set up clients. If a balance here isn't
            real, delete it below. If it is real prior-period data, re-enter it cleanly via
            <span className="font-semibold"> Accounting Reports → Add Opening Balance</span> instead, so Sales-report
            figures stay separate from historical carry-forward balances.
          </p>
          {reviewLoading ? <MiniLoader height={40} /> : suspectAccounts.length === 0 ? (
            <p className="text-sm text-slate-400 py-6 text-center break-words">No flagged accounts — every balance in the ledger traces back to a real sale, purchase, payment, or a properly-recorded opening balance.</p>
          ) : (
            <div className="divide-y min-w-0" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
              {suspectAccounts.map(a => (
                <div key={a.account_id} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 min-w-0">
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-semibold truncate ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{a.name}</p>
                    <p className="text-xs text-slate-400 break-words">
                      {a.code} · {a.type} · sources: {a.sources.join(', ')} · Dr ₹{a.debit.toLocaleString('en-IN')} / Cr ₹{a.credit.toLocaleString('en-IN')}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" className="w-full sm:w-auto max-w-full text-rose-600 border-rose-200 flex-shrink-0" onClick={() => purgeAccount(a.account_id, a.name)}>
                    <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete
                  </Button>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ChartOfAccounts() {
  return (
    <RequestAccessGate module="chart_of_accounts" moduleLabel="Chart of Accounts" permissionFlag="can_view_chart_of_accounts">
      <ChartOfAccountsInner />
    </RequestAccessGate>
  );
}

export default ChartOfAccounts;
