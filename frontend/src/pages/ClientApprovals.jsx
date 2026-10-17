// ClientApprovals.jsx — Records ▸ Client Approvals
// Any user can add a client; the record stays "pending" until an approver
// (admin, or a user with can_approve_clients) approves it here.
import React, { useCallback, useEffect, useState } from 'react';
import { UserPlus, CheckCircle2, XCircle, Loader2, ShieldCheck, Building2, Clock } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import useDark from '@/hooks/useDark';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { HubBanner } from '@/components/SectionHub.jsx';

export default function ClientApprovals() {
  const isDark = useDark();
  const { user, hasPermission } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  const canApprove = user?.role === 'admin' || hasPermission('can_approve_clients');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/clients/pending', { _silent: true });
      setRows(data?.items || []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const decide = async (client, action) => {
    setBusyId(client.id);
    try {
      const body = action === 'reject'
        ? { reason: window.prompt('Reason for rejection (optional)') || '' }
        : {};
      await api.post(`/clients/${client.id}/${action}`, body);
      toast.success(`${client.company_name} ${action === 'approve' ? 'approved' : 'rejected'}`);
      setRows(prev => prev.filter(r => r.id !== client.id));
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  const card = isDark ? 'bg-slate-800/60 border-slate-700/80' : 'bg-white border-slate-100 shadow-sm';

  return (
    <div>
      <HubBanner
        icon={UserPlus}
        eyebrow="ClientSync"
        title="Client Approvals"
        subtitle={canApprove
          ? 'Clients added by your team are held here until you approve them into the master list.'
          : 'Clients you added are held here until an admin approves them into the master list.'}
        isDark={isDark}
        stats={[{ label: 'Pending', value: rows.length, loading }]}
      />

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500 py-10 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading pending clients…
        </div>
      ) : rows.length === 0 ? (
        <div className={`rounded-2xl border p-10 text-center ${card}`}>
          <ShieldCheck className="h-8 w-8 mx-auto mb-3 text-emerald-500" />
          <p className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Nothing waiting for approval</p>
          <p className="text-xs text-slate-500 mt-1">New clients added by any user will appear here automatically.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map(c => (
            <div key={c.id} className={`rounded-2xl border p-4 flex flex-col sm:flex-row sm:items-center gap-4 ${card}`}>
              <div className="p-2.5 rounded-xl shrink-0" style={{ background: '#F59E0B18' }}>
                <Building2 className="h-5 w-5" style={{ color: '#F59E0B' }} />
              </div>
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-bold truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{c.company_name}</p>
                <p className="text-xs text-slate-500 truncate">
                  {[c.client_type, c.email, c.phone, c.gst_number].filter(Boolean).join(' · ') || 'No additional details'}
                </p>
                <p className="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
                  <Clock className="h-3 w-3" /> Submitted {c.created_at ? String(c.created_at).slice(0, 10) : '—'}
                </p>
              </div>
              {canApprove ? (
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    disabled={busyId === c.id}
                    onClick={() => decide(c, 'approve')}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60"
                  >
                    <CheckCircle2 className="h-4 w-4" /> Approve
                  </button>
                  <button
                    disabled={busyId === c.id}
                    onClick={() => decide(c, 'reject')}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold text-rose-600 border border-rose-200 hover:bg-rose-50 dark:hover:bg-rose-500/10 disabled:opacity-60"
                  >
                    <XCircle className="h-4 w-4" /> Reject
                  </button>
                </div>
              ) : (
                <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-amber-100 text-amber-700 shrink-0">
                  Awaiting admin approval
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
