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
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        checked ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-600'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
      aria-pressed={checked}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
          checked ? 'left-[1.15rem]' : 'left-0.5'
        }`}
      />
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
    return users.filter((u) => `${u.full_name} ${u.email} ${u.role_label}`.toLowerCase().includes(q));
  }, [users, userSearch]);

  const grantedCount = useMemo(
    () => Object.values(draftPerms).filter(Boolean).length, [draftPerms],
  );

  if (loading) return <PageShell width="wide"><LoadingState label="Loading roles…" /></PageShell>;

  return (
    <PageShell width="wide">
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

      <div className="mt-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-2 rounded-none px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200'
            }`}
          >
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>

      {/* ── ROLES ─────────────────────────────────────────────────────── */}
      {tab === 'roles' && (
        <SectionCard
          title="Roles"
          icon={Fingerprint}
          actions={
            <Button size="sm" onClick={() => setAddingRole((v) => !v)}>
              <Plus className="mr-1 h-4 w-4" /> New role
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
                <span className="mb-1 block text-slate-500">Behaves like</span>
                <select
                  className="w-full rounded-md border border-slate-200 bg-transparent px-3 py-2 text-sm dark:border-slate-700"
                  value={newRole.base_role}
                  onChange={(e) => setNewRole({ ...newRole, base_role: e.target.value, clone_from: e.target.value })}
                >
                  <option value="staff">Staff (own work only)</option>
                  <option value="manager">Manager (own + team)</option>
                  <option value="admin">Admin (organisation-wide)</option>
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-slate-500">Start from the permissions of</span>
                <select
                  className="w-full rounded-md border border-slate-200 bg-transparent px-3 py-2 text-sm dark:border-slate-700"
                  value={newRole.clone_from}
                  onChange={(e) => setNewRole({ ...newRole, clone_from: e.target.value })}
                >
                  {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
              </label>
              <div className="flex gap-2 md:col-span-2">
                <Button onClick={createRole} disabled={busy}>
                  {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Check className="mr-1 h-4 w-4" />}
                  Create
                </Button>
                <Button variant="ghost" onClick={() => setAddingRole(false)}>
                  <X className="mr-1 h-4 w-4" /> Cancel
                </Button>
              </div>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {roles.map((r) => (
              <div
                key={r.key}
                className={`rounded-xl border p-4 transition-shadow hover:shadow-sm ${
                  selectedKey === r.key
                    ? 'border-blue-500 ring-1 ring-blue-500/30'
                    : 'border-slate-200 dark:border-slate-700'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 font-semibold break-words">
                      <span className="break-words">{r.label}</span>
                      <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        {r.is_builtin ? 'Built-in' : `Custom · like ${r.base_role}`}
                      </span>
                    </div>
                    <p className="mt-1 break-words text-xs text-slate-500">{r.description || 'No description'}</p>
                  </div>
                  {!r.is_builtin && (
                    <Button size="icon" variant="ghost" className="shrink-0" onClick={() => deleteRole(r)}>
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  )}
                </div>
                <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                  <span>{r.user_count} user{r.user_count === 1 ? '' : 's'}</span>
                  <span>{Object.values(r.permissions).filter(Boolean).length} permissions</span>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { setSelectedKey(r.key); setTab('permissions'); }}
                  >
                    <ShieldCheck className="mr-1 h-4 w-4" /> Permissions
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setNewRole({
                        label: `${r.label} (copy)`, description: r.description,
                        base_role: r.base_role, clone_from: r.key,
                      });
                      setAddingRole(true);
                    }}
                  >
                    <Copy className="mr-1 h-4 w-4" /> Clone
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
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="rounded-md border border-slate-200 bg-transparent px-3 py-1.5 text-sm dark:border-slate-700"
                value={selectedKey}
                onChange={(e) => setSelectedKey(e.target.value)}
              >
                {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select>
              {selected?.is_builtin && !readOnly && (
                <Button size="sm" variant="ghost" onClick={resetRole} disabled={busy}>
                  <RotateCcw className="mr-1 h-4 w-4" /> Reset
                </Button>
              )}
              {!readOnly && (
                <Button size="sm" variant="outline" onClick={applyToUsers} disabled={busy}>
                  <UsersIcon className="mr-1 h-4 w-4" /> Apply to {selected?.user_count || 0} user(s)
                </Button>
              )}
              {!readOnly && (
                <Button size="sm" onClick={savePermissions} disabled={busy || !dirty}>
                  {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
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
              <p className="mb-4 text-sm text-slate-500">
                {grantedCount} permission{grantedCount === 1 ? '' : 's'} granted by default. Turning a module
                off automatically removes every page under it. Saving only changes the role template — use
                “Apply to users” to push it onto people who already hold this role.
              </p>
              <div className="space-y-4">
                {surface.map((mod) => {
                  const pageFlags = mod.pages.map((p) => p.flag);
                  const moduleOn = !!draftPerms[mod.flag];
                  return (
                    <div key={mod.module} className="rounded-xl border border-slate-200 dark:border-slate-700">
                      <div className="flex items-start justify-between gap-3 border-b border-slate-100 p-4 dark:border-slate-800">
                        <div>
                          <div className="font-semibold">{mod.label}</div>
                          <p className="mt-0.5 text-xs text-slate-500">{mod.description}</p>
                        </div>
                        <Toggle
                          checked={moduleOn}
                          onChange={(v) => toggleFlag(mod.flag, v, pageFlags)}
                        />
                      </div>
                      <div className="grid gap-x-6 gap-y-2 p-4 md:grid-cols-2">
                        {mod.pages.map((p) => (
                          <div key={p.flag} className="flex items-center justify-between gap-3 py-1">
                            <div className={moduleOn ? '' : 'opacity-50'}>
                              <div className="text-sm">{p.label}</div>
                              <div className="text-[11px] uppercase tracking-wide text-slate-400">
                                {(p.actions || []).join(' · ')}
                              </div>
                            </div>
                            <Toggle
                              checked={!!draftPerms[p.flag]}
                              disabled={!moduleOn}
                              onChange={(v) => toggleFlag(p.flag, v)}
                            />
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
          actions={
            <Button size="sm" onClick={() => setAddingUser((v) => !v)}>
              <UserPlus className="mr-1 h-4 w-4" /> Add employee
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
                <span className="mb-1 block text-slate-500">Role</span>
                <select
                  className="w-full rounded-md border border-slate-200 bg-transparent px-3 py-2 text-sm dark:border-slate-700"
                  value={newUser.role_key}
                  onChange={(e) => setNewUser({ ...newUser, role_key: e.target.value })}
                >
                  {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
              </label>
              <div className="flex items-end gap-2">
                <Button onClick={createUser} disabled={busy}>
                  {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Check className="mr-1 h-4 w-4" />}
                  Add employee
                </Button>
                <Button variant="ghost" onClick={() => setAddingUser(false)}>
                  <X className="mr-1 h-4 w-4" /> Cancel
                </Button>
              </div>
            </div>
          )}

          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input className="pl-9" placeholder="Search people…" value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)} />
          </div>

          {filteredUsers.length === 0 ? (
            <EmptyState icon={UsersIcon} title="No users found" hint="Try a different search." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-700">
                    <th className="py-2 pr-3">Name</th>
                    <th className="py-2 pr-3">Email</th>
                    <th className="py-2 pr-3">Departments</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Role</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map((u) => (
                    <tr key={u.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                      <td className="py-2 pr-3 font-medium">{u.full_name}</td>
                      <td className="py-2 pr-3 text-slate-500">{u.email}</td>
                      <td className="py-2 pr-3 text-slate-500">{(u.departments || []).join(', ') || '—'}</td>
                      <td className="py-2 pr-3">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] ${
                          u.is_active
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                            : 'bg-slate-100 text-slate-500 dark:bg-slate-800'
                        }`}>
                          {u.is_active ? 'Active' : (u.status || 'Inactive')}
                        </span>
                      </td>
                      <td className="py-2 pr-3">
                        <select
                          className="rounded-md border border-slate-200 bg-transparent px-2 py-1 text-sm dark:border-slate-700"
                          value={u.role_key}
                          disabled={busy}
                          onChange={(e) => changeUserRole(u, e.target.value)}
                        >
                          {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
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
