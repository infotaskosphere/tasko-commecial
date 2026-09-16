import React, { useEffect, useState } from 'react';
import { Target, Receipt, Trophy, Send, Clock3, MessageSquare, Percent } from 'lucide-react';
import api from '@/lib/api';
import useDark from '@/hooks/useDark';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { hasEffectivePermission } from '@/lib/commercialPermissionMatrix';
import { HubBanner, StatCard, LinkCard, HUB_COLORS } from '@/components/SectionHub.jsx';

const fmtC = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const MODULES = [
  {
    path: '/leads', icon: Target, label: 'Lead Management',
    description: 'Pipeline of prospective clients from first contact through to won/lost.',
    color: HUB_COLORS.mediumBlue, permission: 'can_view_all_leads',
  },
  {
    path: '/quotations', icon: Receipt, label: 'Quotations',
    description: 'Create, send and track quotations issued to leads and clients.',
    color: HUB_COLORS.emeraldGreen, permission: 'can_create_quotations',
  },
  {
    path: '/client-discussion', icon: MessageSquare, label: 'Client Discussion',
    description: 'Keep every back-and-forth with a lead or client in one running thread.',
    color: '#F59E0B', permission: 'can_view_client_discussion',
  },
];

export default function ClientProposalsDashboard() {
  const isDark = useDark();
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [leads, setLeads] = useState([]);
  const [quotations, setQuotations] = useState([]);
  const [discussions, setDiscussions] = useState([]);

  // Commercial licensees are capped by the pages/features selected on their
  // license. Do not use role=admin as an override here: the backend correctly
  // rejects unlicensed endpoints, and the dashboard must not create those 403s
  // in the first place. Platform owners remain fully entitled via the shared
  // commercial permission matrix.
  const canSee = (m) => !m.permission || hasEffectivePermission(user, m.permission);
  const visibleModules = MODULES.filter(canSee);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);

      // Only request datasets for pages the current user is actually licensed
      // to access. This keeps the Client Proposals dashboard aligned with the
      // same permission source used by routing and the backend entitlement
      // guard, instead of firing guaranteed-403 requests for unselected pages.
      const canReadLeads = hasEffectivePermission(user, 'can_view_all_leads');
      const canReadQuotes = hasEffectivePermission(user, 'can_create_quotations');
      const canReadDiscussions = hasEffectivePermission(user, 'can_view_client_discussion');

      const [leadsRes, quotesRes, discussionsRes] = await Promise.allSettled([
        canReadLeads ? api.get('/leads', { _silent: true }) : Promise.resolve({ data: [] }),
        canReadQuotes ? api.get('/quotations', { _silent: true }) : Promise.resolve({ data: [] }),
        canReadDiscussions ? api.get('/client-discussion', { _silent: true }) : Promise.resolve({ data: [] }),
      ]);

      if (cancelled) return;
      if (leadsRes.status === 'fulfilled') setLeads(Array.isArray(leadsRes.value.data) ? leadsRes.value.data : []);
      if (quotesRes.status === 'fulfilled') setQuotations(Array.isArray(quotesRes.value.data) ? quotesRes.value.data : []);
      if (discussionsRes.status === 'fulfilled') {
        const d = discussionsRes.value.data;
        setDiscussions(Array.isArray(d) ? d : (Array.isArray(d?.data) ? d.data : []));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user]);

  const wonLeads = leads.filter((l) => l.status === 'won').length;
  const activeLeads = leads.filter((l) => l.status && !['won', 'lost'].includes(l.status)).length;
  const wonValue = leads
    .filter((l) => l.status === 'won')
    .reduce((s, l) => s + (Number(l.quotation_amount) || 0), 0);
  const pendingQuotes = quotations.filter((q) => q.status === 'draft' || q.status === 'sent').length;
  const acceptedQuotes = quotations.filter((q) => q.status === 'accepted').length;
  const acceptedValue = quotations
    .filter((q) => q.status === 'accepted')
    .reduce((s, q) => s + (Number(q.total) || 0), 0);
  const lostLeads = leads.filter((l) => l.status === 'lost').length;
  const closedLeads = wonLeads + lostLeads;
  const winRate = closedLeads > 0 ? Math.round((wonLeads / closedLeads) * 100) : null;
  const openDiscussions = discussions.filter((d) => d.status ? d.status !== 'closed' : true).length;

  const badgeFor = (path) => {
    if (path === '/leads') return loading ? '—' : leads.length;
    if (path === '/quotations') return loading ? '—' : quotations.length;
    if (path === '/client-discussion') return loading ? '—' : discussions.length;
    return null;
  };

  const stats = [
    { label: 'Active Leads', value: loading ? '—' : activeLeads, loading },
    { label: 'Won Value', value: loading ? '—' : fmtC(wonValue), loading },
    { label: 'Pending Quotes', value: loading ? '—' : pendingQuotes, loading },
    { label: 'Win Rate', value: loading ? '—' : (winRate === null ? '—' : `${winRate}%`), loading },
  ];

  return (
    <div>
      <HubBanner
        icon={Target}
        eyebrow="Client Proposals"
        title="Client Proposals Dashboard"
        subtitle="Everything between a first conversation and a signed quotation."
        isDark={isDark}
        stats={stats}
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
        <StatCard icon={Clock3} label="Active Leads" value={loading ? '—' : activeLeads} loading={loading} color={HUB_COLORS.mediumBlue} isDark={isDark} />
        <StatCard icon={Trophy} label="Won Leads" value={loading ? '—' : wonLeads} loading={loading} color={HUB_COLORS.emeraldGreen} isDark={isDark} />
        <StatCard icon={Send} label="Pending Quotations" value={loading ? '—' : pendingQuotes} loading={loading} color="#F59E0B" isDark={isDark} />
        <StatCard icon={Receipt} label="Accepted Quotations" value={loading ? '—' : acceptedQuotes} loading={loading} color="#7C3AED" isDark={isDark} />
        <StatCard icon={Percent} label="Win Rate" value={loading ? '—' : (winRate === null ? 'N/A' : `${winRate}%`)} loading={loading} color="#0EA5E9" isDark={isDark} />
        <StatCard icon={MessageSquare} label="Open Discussions" value={loading ? '—' : openDiscussions} loading={loading} color="#EC4899" isDark={isDark} />
      </div>

      <h2 className={`text-sm font-extrabold uppercase tracking-widest mb-3 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
        Proposal Modules
      </h2>
      {visibleModules.length === 0 ? (
        <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          You don't have access to any proposal modules yet. Contact your admin to request access.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleModules.map((m) => (
            <LinkCard key={m.path} {...m} badge={badgeFor(m.path)} isDark={isDark} />
          ))}
        </div>
      )}

      {acceptedValue > 0 && (
        <p className={`mt-6 text-xs font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          Accepted quotation value this list: <span style={{ color: HUB_COLORS.emeraldGreen }}>{fmtC(acceptedValue)}</span>
        </p>
      )}
    </div>
  );
}
