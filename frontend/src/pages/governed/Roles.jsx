// Roles.jsx — "Admin › Roles" control room.
//
// Three tabs, all powered by backend/roles_admin.py (/api/role-admin/*):
//   Roles        — every role (built-in + custom), create / clone / delete.
//   Permissions  — the default permission governance for the selected role:
//                  Module → Page toggles, e.g. exactly what a Manager can do
//                  by default and which permissions may be added or removed.
//   Users        — every user with their role, change any user's role, and
//                  add a new employee with a role attached from day one.
//
// Admin role is intentionally read-only (always full access). Page access is
// still governed by admin/can_view_roles like before.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus, Trash2, Loader2, Search, ShieldCheck, Users as UsersIcon, Save,
  RotateCcw, Copy, UserPlus, Check, X, Fingerprint, Layers,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import api from '@/lib/api';
import { toast } from 'sonner';
import {
  PageShell, PageBanner, StatRow, SectionCard, EmptyState, LoadingState, HUB_COLORS,
} from '@/components/ui/PageKit';

const TABS = [
  { key: 'roles', label: 'Roles', icon: Fingerprint },
  { key: 'permissions', label: 'Permissions', icon: ShieldCheck },
  { key: 'users', label: 'Users', icon: UsersIcon },
];

function Toggle({ checked, disabled, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`roles-toggle-switch ${checked ? 'is-checked' : ''} ${disabled ? 'is-disabled' : ''}`}
    >
      <span className="roles-toggle-knob" />
    </button>
  );
}

export default function Roles() {
  const [tab, setTab] = useState('roles');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [roles, setRoles] = useState([]);
  const [surface, setSurface] = useState([]);
  const [users, setUsers] = useState([]);
  const [selectedKey, setSelectedKey] = useState('manager');
  const [draftPerms, setDraftPerms] = useState({});
  const [userSearch, setUserSearch] = useState('');
  const [addingRole, setAddingRole] = useState(false);
  const [newRole, setNewRole] = useState({ label: '', description: '', base_role: 'staff', clone_from: 'staff' });
  const [addingUser, setAddingUser] = useState(false);
  const [newUser, setNewUser] = useState({ full_name: '', email: '', password: '', role_key: 'staff', phone: '' });

  const selected = useMemo(() => roles.find((r) => r.key === selectedKey) || null, [roles, selectedKey]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, s, u] = await Promise.all([
        api.get('/role-admin/roles'),
        api.get('/role-admin/permission-surface'),
        api.get('/role-admin/users'),
      ]);
      setRoles(Array.isArray(r.data) ? r.data : []);
      setSurface(Array.isArray(s.data) ? s.data : []);
      setUsers(Array.isArray(u.data) ? u.data : []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not load roles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setDraftPerms(selected ? { ...selected.permissions } : {}); }, [selected]);

  const dirty = useMemo(
    () => selected && Object.keys(draftPerms).some((k) => !!draftPerms[k] !== !!selected.permissions[k]),
    [draftPerms, selected],
  );
  const readOnly = selected?.key === 'admin';

  // ── Permissions tab ──────────────────────────────────────────────────────
  const toggleFlag = (flag, value, pageFlags = null) => {
    setDraftPerms((prev) => {
      const next = { ...prev, [flag]: value };
      if (pageFlags && !value) pageFlags.forEach((pf) => { next[pf] = false; }); // module off → pages off
      return next;
    });
  };

  const savePermissions = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const { data } = await api.put(`/role-admin/roles/${selected.key}`, { permissions: draftPerms });
      setRoles((prev) => prev.map((r) => (r.key === data.key ? { ...r, ...data } : r)));
      toast.success(`${data.label} permissions saved`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not save permissions');
    } finally { setBusy(false); }
  };

  const resetRole = async () => {
    if (!selected?.is_builtin) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/role-admin/roles/${selected.key}/reset`);
      setRoles((prev) => prev.map((r) => (r.key === data.key ? { ...r, ...data } : r)));
      setDraftPerms({ ...data.permissions });
      toast.success('Back to system defaults');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not reset');
    } finally { setBusy(false); }
  };

  const applyToUsers = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/role-admin/roles/${selected.key}/apply-to-users`);
      toast.success(data.message || 'Applied');
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not apply');
    } finally { setBusy(false); }
  };

  // ── Roles tab ────────────────────────────────────────────────────────────
  const createRole = async () => {
    if (!newRole.label.trim()) return toast.error('Give the role a name');
    setBusy(true);
    try {
      const { data } = await api.post('/role-admin/roles', {
        label: newRole.label.trim(),
        description: newRole.description.trim(),
        base_role: newRole.base_role,
        clone_from: newRole.clone_from || null,
      });
      toast.success(`Role "${data.label}" created`);
      setAddingRole(false);
      setNewRole({ label: '', description: '', base_role: 'staff', clone_from: 'staff' });
      await load();
      setSelectedKey(data.key);
      setTab('permissions');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not create role');
    } finally { setBusy(false); }
  };

  const deleteRole = async (role) => {
    if (!window.confirm(`Delete the role "${role.label}"?`)) return;
    setBusy(true);
    try {
      await api.delete(`/role-admin/roles/${role.key}`);
      toast.success('Role deleted');
      if (selectedKey === role.key) setSelectedKey('manager');
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not delete role');
    } finally { setBusy(false); }
  };

  // ── Users tab ────────────────────────────────────────────────────────────
  const changeUserRole = async (user, roleKey) => {
    setBusy(true);
    try {
      const { data } = await api.put(`/role-admin/users/${user.id}/role`, {
        role_key: roleKey,
        apply_defaults: true,
      });
      toast.success(data.message || 'Role updated');
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not change role');
    } finally { setBusy(false); }
  };

  const createUser = async () => {
    const { full_name, email, password } = newUser;
    if (!full_name.trim() || !email.trim() || password.length < 6) {
      return toast.error('Name, email and a 6+ character password are required');
    }
    setBusy(true);
    try {
      await api.post('/role-admin/users', { ...newUser, full_name: full_name.trim(), email: email.trim() });
      toast.success('Employee added');
      setAddingUser(false);
      setNewUser({ full_name: '', email: '', password: '', role_key: 'staff', phone: '' });
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not add employee');
    } finally { setBusy(false); }
  };

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      `${u.full_name || ''} ${u.email || ''} ${u.role_label || ''} ${u.role_key || ''} ${u.role || ''} ${(u.departments || []).join(' ')} ${u.department_id || ''}`
        .toLowerCase()
        .includes(q),
    );
  }, [users, userSearch]);

  const grantedCount = useMemo(
    () => Object.values(draftPerms || {}).filter(Boolean).length, [draftPerms],
  );

  if (loading) return <PageShell className="roles-page-shell"><LoadingState label="Loading roles…" /></PageShell>;

  return (
    <PageShell className="roles-page-shell">
      <PageBanner
        eyebrow="ADMIN"
        title="Roles & Permission Governance"
        subtitle="Define roles, set what each role can do by default, and assign roles to your people."
        icon={Fingerprint}
      />

      <StatRow
        items={[
          { icon: Fingerprint, label: 'Roles', value: roles.length, color: HUB_COLORS.mediumBlue },
          { icon: UsersIcon, label: 'Users', value: users.length, color: HUB_COLORS.mediumBlue },
          { icon: ShieldCheck, label: 'Admins', value: users.filter((u) => u.role === 'admin').length, color: HUB_COLORS.emeraldGreen },
          { icon: Layers, label: 'Custom roles', value: roles.filter((r) => !r.is_builtin).length, color: '#F59E0B' },
        ]}
      />

      <div className="roles-nav-tabs mt-1">
        {TABS.map((t) => {
          const isActive = tab === t.key;
          const count = t.key === 'roles' ? roles.length : t.key === 'users' ? users.length : null;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`roles-nav-tab-btn ${isActive ? 'is-active' : ''}`}
            >
              <t.icon className="h-4 w-4 shrink-0" />
              <span className="whitespace-nowrap">{t.label}</span>
              {count !== null && (
                <span
                  className={`roles-nav-tab-badge ${
                    isActive
                      ? 'bg-white/20 text-white'
                      : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── ROLES ─────────────────────────────────────────────────────── */}
      {tab === 'roles' && (
        <SectionCard
          title="Roles"
          icon={Fingerprint}
          className="overflow-visible"
          actions={
            <Button size="sm" className="h-9 whitespace-nowrap font-medium" onClick={() => setAddingRole((v) => !v)}>
              <Plus className="mr-1.5 h-4 w-4 shrink-0" /> New role
            </Button>
          }
        >
          {addingRole && (
            <div className="mb-4 grid gap-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700 md:grid-cols-2">
              <Input
                placeholder="Role name *  (e.g. Senior Manager)"
                value={newRole.label}
                onChange={(e) => setNewRole({ ...newRole, label: e.target.value })}
              />
              <Input
                placeholder="Description (optional)"
                value={newRole.description}
                onChange={(e) => setNewRole({ ...newRole, description: e.target.value })}
              />
              <label className="text-sm">
                <span className="mb-1 block text-slate-500 font-medium">Behaves like</span>
                <select
                  className="w-full h-10 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                  value={newRole.base_role}
                  onChange={(e) => setNewRole({ ...newRole, base_role: e.target.value, clone_from: e.target.value })}
                >
                  <option value="staff">Staff (own work only)</option>
                  <option value="manager">Manager (own + team)</option>
                  <option value="admin">Admin (organisation-wide)</option>
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-slate-500 font-medium">Start from the permissions of</span>
                <select
                  className="w-full h-10 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                  value={newRole.clone_from}
                  onChange={(e) => setNewRole({ ...newRole, clone_from: e.target.value })}
                >
                  {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
              </label>
              <div className="flex gap-2 md:col-span-2 pt-1">
                <Button className="h-9 whitespace-nowrap" onClick={createRole} disabled={busy}>
                  {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin shrink-0" /> : <Check className="mr-1.5 h-4 w-4 shrink-0" />}
                  Create
                </Button>
                <Button variant="ghost" className="h-9 whitespace-nowrap" onClick={() => setAddingRole(false)}>
                  <X className="mr-1.5 h-4 w-4 shrink-0" /> Cancel
                </Button>
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 items-stretch">
            {roles.map((r) => (
              <div
                key={r.key}
                className={`rounded-xl border p-5 transition-all hover:shadow-md flex flex-col justify-between min-w-0 bg-white dark:bg-slate-800/60 ${
                  selectedKey === r.key
                    ? 'border-blue-500 ring-2 ring-blue-500/20 shadow-sm'
                    : 'border-slate-200 dark:border-slate-700'
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-start justify-between gap-2 min-w-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap font-semibold text-sm sm:text-base">
                        <span className="text-slate-900 dark:text-slate-100 whitespace-nowrap">{r.label}</span>
                        <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300 whitespace-nowrap">
                          {r.is_builtin ? 'Built-in' : `Custom · like ${r.base_role}`}
                        </span>
                      </div>
                      <p className="mt-1.5 text-xs text-slate-500 break-normal leading-relaxed">{r.description || 'No description'}</p>
                    </div>
                    {!r.is_builtin && (
                      <Button size="icon" variant="ghost" className="shrink-0 h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40" onClick={() => deleteRole(r)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  <div className="mt-4 flex items-center justify-between text-xs text-slate-600 dark:text-slate-400 font-semibold py-1.5 px-2.5 bg-slate-50 dark:bg-slate-800/40 rounded-md">
                    <span className="whitespace-nowrap">{r.user_count || 0} user{(r.user_count || 0) === 1 ? '' : 's'}</span>
                    <span className="whitespace-nowrap">{Object.values(r.permissions || {}).filter(Boolean).length} permissions</span>
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-2 pt-3 border-t border-slate-100 dark:border-slate-700/60">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 whitespace-nowrap h-9 font-semibold text-xs border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                    onClick={() => { setSelectedKey(r.key); setTab('permissions'); }}
                  >
                    <ShieldCheck className="mr-1.5 h-4 w-4 text-blue-600 shrink-0" /> Permissions
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="flex-1 whitespace-nowrap h-9 font-medium text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                    onClick={() => {
                      setNewRole({
                        label: `${r.label} (copy)`, description: r.description,
                        base_role: r.base_role, clone_from: r.key,
                      });
                      setAddingRole(true);
                    }}
                  >
                    <Copy className="mr-1.5 h-4 w-4 text-slate-500 shrink-0" /> Clone
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* ── PERMISSIONS ───────────────────────────────────────────────── */}
      {tab === 'permissions' && (
        <SectionCard
          title={selected ? `${selected.label} — default permissions` : 'Permissions'}
          icon={ShieldCheck}
          className="overflow-visible"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="roles-role-select"
                value={selectedKey}
                onChange={(e) => setSelectedKey(e.target.value)}
              >
                {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select>
              {selected?.is_builtin && !readOnly && (
                <Button size="sm" variant="ghost" className="h-9 whitespace-nowrap font-medium text-slate-700 hover:bg-slate-100" onClick={resetRole} disabled={busy}>
                  <RotateCcw className="mr-1.5 h-4 w-4 shrink-0" /> Reset
                </Button>
              )}
              {!readOnly && (
                <Button size="sm" variant="outline" className="h-9 whitespace-nowrap font-medium border-slate-200" onClick={applyToUsers} disabled={busy}>
                  <UsersIcon className="mr-1.5 h-4 w-4 shrink-0" /> Apply to {selected?.user_count || 0} user(s)
                </Button>
              )}
              {!readOnly && (
                <Button size="sm" className="h-9 whitespace-nowrap font-semibold bg-blue-600 hover:bg-blue-700 text-white" onClick={savePermissions} disabled={busy || !dirty}>
                  {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin shrink-0" /> : <Save className="mr-1.5 h-4 w-4 shrink-0" />}
                  Save
                </Button>
              )}
            </div>
          }
        >
          {readOnly ? (
            <EmptyState
              icon={ShieldCheck}
              title="Admin always has full access"
              hint="The Admin role cannot be restricted. Pick another role to govern its permissions."
            />
          ) : (
            <>
              <p className="mb-4 text-sm text-slate-500 leading-relaxed">
                {grantedCount} permission{grantedCount === 1 ? '' : 's'} granted by default. Turning a module
                off automatically removes every page under it. Saving only changes the role template — use
                “Apply to users” to push it onto people who already hold this role.
              </p>
              <div className="space-y-4">
                {surface.map((mod) => {
                  const pageFlags = mod.pages.map((p) => p.flag);
                  const moduleOn = !!draftPerms[mod.flag];
                  return (
                    <div key={mod.module} className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/40 overflow-hidden shadow-sm">
                      <div className="flex items-center justify-between gap-3 border-b border-slate-100 p-4 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-800/30">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 font-bold text-sm sm:text-base text-slate-900 dark:text-slate-100">
                            <span className="whitespace-nowrap">{mod.label}</span>
                            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-200/50 whitespace-nowrap">
                              {mod.pages.filter((p) => !!draftPerms[p.flag]).length} / {mod.pages.length} active
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-slate-500 break-normal leading-relaxed">{mod.description}</p>
                        </div>
                        <div className="shrink-0 flex items-center gap-3">
                          <span className="text-xs font-medium text-slate-500 dark:text-slate-400 whitespace-nowrap hidden sm:inline-block">
                            {moduleOn ? 'Enabled' : 'Disabled'}
                          </span>
                          <Toggle
                            checked={moduleOn}
                            onChange={(v) => toggleFlag(mod.flag, v, pageFlags)}
                          />
                        </div>
                      </div>
                      <div className="grid gap-x-6 gap-y-2.5 p-4 sm:grid-cols-2">
                        {mod.pages.map((p) => (
                          <div key={p.flag} className="flex items-center justify-between gap-3 py-2 px-3 rounded-lg border border-slate-100 bg-white hover:bg-slate-50 dark:border-slate-700/50 dark:bg-slate-800/40 dark:hover:bg-slate-800/60 min-w-0 transition-colors">
                            <div className={`min-w-0 flex-1 pr-2 ${moduleOn ? '' : 'opacity-40'}`}>
                              <div className="text-sm font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap truncate" title={p.label}>
                                {p.label}
                              </div>
                              <div className="text-[11px] uppercase tracking-wide text-slate-400 font-medium whitespace-nowrap truncate mt-0.5">
                                {(p.actions || []).join(' · ')}
                              </div>
                            </div>
                            <div className="shrink-0 flex items-center">
                              <Toggle
                                checked={!!draftPerms[p.flag]}
                                disabled={!moduleOn}
                                onChange={(v) => toggleFlag(p.flag, v)}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </SectionCard>
      )}

      {/* ── USERS ─────────────────────────────────────────────────────── */}
      {tab === 'users' && (
        <SectionCard
          title={`Users (${users.length})`}
          icon={UsersIcon}
          className="overflow-visible"
          actions={
            <Button size="sm" className="h-9 whitespace-nowrap font-medium" onClick={() => setAddingUser((v) => !v)}>
              <UserPlus className="mr-1.5 h-4 w-4 shrink-0" /> Add employee
            </Button>
          }
        >
          {addingUser && (
            <div className="mb-4 grid gap-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700 md:grid-cols-2">
              <Input placeholder="Full name *" value={newUser.full_name}
                onChange={(e) => setNewUser({ ...newUser, full_name: e.target.value })} />
              <Input placeholder="Work email *" type="email" value={newUser.email}
                onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} />
              <Input placeholder="Temporary password * (min 6 chars)" type="text" value={newUser.password}
                onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} />
              <Input placeholder="Phone (optional)" value={newUser.phone}
                onChange={(e) => setNewUser({ ...newUser, phone: e.target.value })} />
              <label className="text-sm">
                <span className="mb-1 block text-slate-500 font-medium">Role</span>
                <select
                  className="w-full h-10 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                  value={newUser.role_key}
                  onChange={(e) => setNewUser({ ...newUser, role_key: e.target.value })}
                >
                  {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
              </label>
              <div className="flex items-end gap-2">
                <Button className="h-9 whitespace-nowrap" onClick={createUser} disabled={busy}>
                  {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin shrink-0" /> : <Check className="mr-1.5 h-4 w-4 shrink-0" />}
                  Add employee
                </Button>
                <Button variant="ghost" className="h-9 whitespace-nowrap" onClick={() => setAddingUser(false)}>
                  <X className="mr-1.5 h-4 w-4 shrink-0" /> Cancel
                </Button>
              </div>
            </div>
          )}

          <div className="relative mb-4">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input className="pl-9 bg-white dark:bg-slate-900 h-10" placeholder="Search people by name, email, department or role…" value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)} />
          </div>

          {filteredUsers.length === 0 ? (
            <EmptyState icon={UsersIcon} title="No users found" hint="Try a different search." />
          ) : (
            <div className="w-full overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm">
              <table className="roles-users-table w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80 text-left text-xs uppercase tracking-wider font-bold text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
                    <th className="py-3 px-4 min-w-[170px] whitespace-nowrap">Name</th>
                    <th className="py-3 px-4 min-w-[220px] whitespace-nowrap">Email</th>
                    <th className="py-3 px-4 min-w-[180px] whitespace-nowrap">Departments</th>
                    <th className="py-3 px-4 min-w-[110px] whitespace-nowrap">Status</th>
                    <th className="py-3 px-4 min-w-[190px] whitespace-nowrap">Role</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredUsers.map((u) => (
                    <tr key={u.id} className="transition-colors hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                      <td className="py-3.5 px-4 font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                        {u.full_name || '—'}
                      </td>
                      <td className="py-3.5 px-4 text-slate-600 dark:text-slate-400 whitespace-nowrap font-mono text-xs">
                        {u.email || '—'}
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {Array.isArray(u.departments) && u.departments.length > 0 ? (
                            u.departments.map((d) => (
                              <span key={d} className="inline-flex items-center px-2.5 py-0.5 rounded text-[11px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200/60 dark:border-slate-700 whitespace-nowrap">
                                {d}
                              </span>
                            ))
                          ) : (
                            <span className="text-slate-400 whitespace-nowrap">{u.department_id || '—'}</span>
                          )}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap ${
                          u.is_active
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                            : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 border border-slate-200 dark:border-slate-700'
                        }`}>
                          {u.is_active ? 'Active' : (u.status || 'Inactive')}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <select
                          className="roles-user-role-select w-full min-w-[140px] max-w-[210px] rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs sm:text-sm font-medium text-slate-800 shadow-sm transition-colors hover:border-slate-300 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                          value={u.role_key || u.role || 'staff'}
                          disabled={busy}
                          onChange={(e) => changeUserRole(u, e.target.value)}
                        >
                          {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                          {!roles.some((r) => r.key === (u.role_key || u.role)) && (
                            <option value={u.role_key || u.role}>{u.role_label || u.role_key || u.role}</option>
                          )}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      )}
    </PageShell>
  );
}
