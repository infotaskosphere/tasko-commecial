// PermissionMatrix.jsx — Admin → Permission Matrix.
//
// Redesigned to match the Dashboard / section-hub look (gradient banner,
// KPI tiles) via @/components/ui/PageKit, and rebuilt on top of the SHARED
// <AccessGovernancePanel />, which is the very same editor rendered inside
// Users → Access Governance. One component, one set of rules, one set of
// guidance notes — the two screens can no longer drift.
//
// LAYOUT NOTE: the cards on this screen use <GovCard> (plain <div>s) rather
// than <SectionCard>. SectionCard renders a real <header> element, and the
// app's global CSS forces `#root header { height: 64px }` and
// `#root header + div { height: 40px }`, which squashed every card body and
// made the page look "distorted". See the notes in AccessGovernancePanel.jsx.

import React, { useEffect, useMemo, useState } from 'react';
import { Search, ShieldCheck, Users as UsersIcon, KeyRound, UserCog } from 'lucide-react';
import { Input } from '@/components/ui/input';
import api from '@/lib/api';
import { toast } from 'sonner';
import useDark from '@/hooks/useDark';
import {
  PageShell, PageBanner, StatRow, LoadingState, EmptyState, HUB_COLORS,
} from '@/components/ui/PageKit';
import AccessGovernancePanel, { GovCard } from '@/components/governance/AccessGovernancePanel';

// Inline so it beats the global `#root p/span/label/button { overflow-wrap:anywhere }`.
const TXT = { overflowWrap: 'break-word', wordBreak: 'normal' };

const initialOf = (u) => (u.full_name || u.email || '?').trim().charAt(0).toUpperCase();

export default function PermissionMatrix() {
  const isDark = useDark();
  const [users, setUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/users');
        const list = Array.isArray(data) ? data : data?.users || [];
        setUsers(list);
        if (list.length) setSelectedUserId(list[0].id);
      } catch {
        toast.error('Could not load users');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const selectedUser = users.find((u) => u.id === selectedUserId);
  const isAdminUser = (selectedUser?.role || '').toLowerCase() === 'admin';

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => `${u.full_name || ''} ${u.email || ''}`.toLowerCase().includes(q));
  }, [users, search]);

  const adminCount = users.filter((u) => (u.role || '').toLowerCase() === 'admin').length;
  const editingName = selectedUser ? (selectedUser.full_name || selectedUser.email) : '—';

  return (
    <PageShell>
      <PageBanner
        icon={ShieldCheck}
        eyebrow="Admin"
        title="Permission Governance"
        subtitle="Module → Page → Action access, per user. Every switch here is explained inline so you always know what you are granting."
      />

      <StatRow
        columns={3}
        items={[
          { icon: UsersIcon, label: 'Team members', value: users.length, color: HUB_COLORS.mediumBlue },
          { icon: ShieldCheck, label: 'Admins (unrestricted)', value: adminCount, color: HUB_COLORS.emeraldGreen },
          {
            icon: UserCog,
            label: 'Editing',
            // Long names truncate instead of pushing the tile out of shape.
            value: <span className="block truncate max-w-full" title={editingName}>{editingName}</span>,
            color: '#7C3AED',
          },
        ]}
      />

      {loading ? (
        <LoadingState label="Loading permission matrix…" />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(220px,260px)_minmax(0,1fr)] gap-5 items-start min-w-0">
          {/* ── Users ─────────────────────────────────────────────── */}
          <GovCard
            icon={UsersIcon}
            title="Users"
            badge={filteredUsers.length}
            className="w-full lg:sticky lg:top-2"
            bodyClassName="p-3 space-y-3"
          >
            <div className="relative w-full min-w-0">
              <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <Input
                className="pl-8"
                placeholder="Search users…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="w-full min-w-0 space-y-1 max-h-[45vh] lg:max-h-[60vh] overflow-y-auto overflow-x-hidden">
              {filteredUsers.length === 0 && (
                <p style={TXT} className="text-xs text-slate-400 py-6 text-center">
                  No users match &ldquo;{search}&rdquo;.
                </p>
              )}
              {filteredUsers.map((u) => {
                const active = u.id === selectedUserId;
                const admin = (u.role || '').toLowerCase() === 'admin';
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => setSelectedUserId(u.id)}
                    title={u.email || undefined}
                    aria-pressed={active}
                    className={`w-full min-w-0 text-left px-2.5 py-2 flex items-center gap-3 border-l-[3px] cursor-pointer transition-colors ${
                      active
                        ? 'border-[#1F6FB2] bg-[#1F6FB2]/10'
                        : `border-transparent ${isDark ? 'hover:bg-slate-700/50' : 'hover:bg-slate-100'}`
                    }`}
                  >
                    <span
                      className="flex items-center justify-center w-8 h-8 shrink-0 text-xs font-bold text-white"
                      style={{ background: `linear-gradient(135deg, ${HUB_COLORS.deepBlue}, ${HUB_COLORS.mediumBlue})` }}
                    >
                      {initialOf(u)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        style={TXT}
                        className={`block truncate text-sm ${active ? 'font-bold' : 'font-semibold'} ${
                          isDark ? 'text-slate-100' : 'text-slate-800'
                        }`}
                      >
                        {u.full_name || u.email}
                      </span>
                      <span style={TXT} className="block truncate text-[11px] text-slate-400 capitalize">
                        {u.role || 'user'}
                      </span>
                    </span>
                    {admin && <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </GovCard>

          {/* ── Access editor ─────────────────────────────────────── */}
          <div className="w-full min-w-0 max-w-full space-y-4">
            {!selectedUserId ? (
              <GovCard icon={KeyRound} title="Access Governance">
                <EmptyState
                  icon={KeyRound}
                  title="Pick a user"
                  hint="Select someone on the left to review and change what they can reach."
                />
              </GovCard>
            ) : (
              <AccessGovernancePanel
                key={selectedUserId}
                userId={selectedUserId}
                isAdminUser={isAdminUser}
                showSave
              />
            )}
          </div>
        </div>
      )}
    </PageShell>
  );
}
