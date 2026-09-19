// PermissionMatrix.jsx — Admin → Permission Matrix.
//
// Redesigned to match the Dashboard / section-hub look (gradient banner,
// KPI tiles, SectionCards) via @/components/ui/PageKit, and rebuilt on top
// of the SHARED <AccessGovernancePanel />, which is the very same editor
// rendered inside Users → Access Governance. One component, one set of
// rules, one set of guidance notes — the two screens can no longer drift.

import React, { useEffect, useMemo, useState } from 'react';
import { Search, ShieldCheck, Users as UsersIcon, KeyRound, UserCog } from 'lucide-react';
import { Input } from '@/components/ui/input';
import api from '@/lib/api';
import { toast } from 'sonner';
import useDark from '@/hooks/useDark';
import {
  PageShell, PageBanner, StatRow, SectionCard, LoadingState, EmptyState, HUB_COLORS,
} from '@/components/ui/PageKit';
import AccessGovernancePanel from '@/components/governance/AccessGovernancePanel';

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
          { icon: UserCog, label: 'Editing', value: selectedUser ? (selectedUser.full_name || selectedUser.email) : '—', color: '#7C3AED' },
        ]}
      />

      {loading ? (
        <LoadingState label="Loading permission matrix…" />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(240px,280px)_minmax(0,1fr)] gap-5 items-start min-w-0">
          <SectionCard icon={UsersIcon} title="Users" badge={filteredUsers.length} className="h-fit overflow-hidden">
            <div className="relative mb-3">
              <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-slate-400" />
              <Input
                className="pl-8"
                placeholder="Search users…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="space-y-1 max-h-[64vh] min-h-0 overflow-y-auto overflow-x-hidden pr-1">
              {filteredUsers.length === 0 && (
                <p className="text-xs text-slate-400 py-6 text-center">No users match “{search}”.</p>
              )}
              {filteredUsers.map((u) => {
                const active = u.id === selectedUserId;
                return (
                  <button
                    key={u.id}
                    onClick={() => setSelectedUserId(u.id)}
                    className={`w-full min-w-0 text-left px-3 py-2 rounded-xl text-sm flex items-center justify-between gap-2 transition-colors ${
                      active
                        ? 'bg-[#1F6FB2]/12 font-semibold'
                        : isDark ? 'hover:bg-slate-700/50' : 'hover:bg-slate-100'
                    }`}
                  >
                    <span className="min-w-0">
                      <span className={`block truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                        {u.full_name || u.email}
                      </span>
                      <span className="block text-[11px] text-slate-400 capitalize">{u.role || 'user'}</span>
                    </span>
                    {(u.role || '').toLowerCase() === 'admin' && (
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          </SectionCard>

          <div className="space-y-4 min-w-0">
            {!selectedUserId ? (
              <SectionCard icon={KeyRound} title="Access Governance">
                <EmptyState
                  icon={KeyRound}
                  title="Pick a user"
                  hint="Select someone on the left to review and change what they can reach."
                />
              </SectionCard>
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