// Opt-out (suppression) list for one channel. Suppressed addresses are skipped by every campaign.
import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Search, ShieldOff, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, GuidanceNote, LoadingState } from '@/components/ui/PageKit';
import { engagexApi, engagexError } from '@/lib/engagexApi';
import { fmtDateTime } from './shared';

export default function OptOutPanel({ channel }) {
  const [q, setQ] = useState('');
  const [state, setState] = useState({ loading: true, items: [], total: 0 });
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await engagexApi.suppressions(channel, q);
      setState({ loading: false, items: data.items || [], total: data.total || 0 });
    } catch (error) {
      setState((s) => ({ ...s, loading: false }));
      toast.error(engagexError(error));
    }
  }, [channel, q]);

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const add = async () => {
    const addresses = text.split(/[\n,;]+/).map((v) => v.trim()).filter(Boolean);
    if (!addresses.length) return;
    try {
      const res = await engagexApi.addSuppressions(channel, addresses, 'Added manually');
      toast.success(`${res.added} added to the opt-out list`);
      setText(''); setAdding(false); load();
    } catch (error) { toast.error(engagexError(error)); }
  };

  const remove = async (address) => {
    if (!window.confirm(`Remove ${address} from the opt-out list? They will receive future campaigns again.`)) return;
    try { await engagexApi.removeSuppression(channel, address); load(); } catch (error) { toast.error(engagexError(error)); }
  };

  return (
    <div className="space-y-3">
      <GuidanceNote icon={ShieldOff}>
        {channel === 'email'
          ? 'People who click “Unsubscribe” are added here automatically and are never emailed by MailMaster again.'
          : 'Numbers here are skipped by every WhatsApp broadcast. Add anyone who replies STOP or asks not to be contacted.'}
      </GuidanceNote>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={channel === 'email' ? 'Search emails' : 'Search numbers'} className="pl-8" />
        </div>
        <Button size="sm" onClick={() => setAdding((v) => !v)}><Plus className="h-4 w-4 mr-1" />Add</Button>
      </div>
      {adding && (
        <div className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
          <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={channel === 'email' ? 'One email per line' : 'One number per line'} className="font-mono text-sm" />
          <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button><Button size="sm" onClick={add}>Add to opt-out list</Button></div>
        </div>
      )}
      {state.loading ? <LoadingState /> : state.items.length === 0 ? <EmptyState icon={ShieldOff} title="No opt-outs" hint="Nobody has opted out yet." /> : (
        <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
          <table className="w-full text-sm">
            <tbody>
              {state.items.map((row) => (
                <tr key={row.address} className="border-t border-slate-100 first:border-t-0 dark:border-slate-700/60">
                  <td className="px-3 py-2 font-mono text-xs text-slate-700 dark:text-slate-200">{row.address}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{row.reason}</td>
                  <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">{fmtDateTime(row.created_at)}</td>
                  <td className="px-2 py-2 text-right"><Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => remove(row.address)} title="Remove"><X className="h-4 w-4" /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {state.total > state.items.length && <p className="border-t border-slate-100 px-3 py-2 text-center text-xs text-slate-400 dark:border-slate-700">Showing {state.items.length} of {state.total}. Search to narrow down.</p>}
        </div>
      )}
    </div>
  );
}
