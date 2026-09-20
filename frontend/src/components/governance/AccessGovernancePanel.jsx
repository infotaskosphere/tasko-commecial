// AccessGovernancePanel.jsx — the SINGLE shared Module → Page permission
// editor used by BOTH:
//
//   • Admin → Permission Matrix  (src/pages/PermissionMatrix.jsx)
//   • Users → edit user → Access Governance tab (src/pages/Users.jsx)
//
// Because both screens render this one component, the two places can never
// drift apart again: same module tree, same cascade rules, same guidance
// notes (src/lib/permissionGuidance.js), same high-risk warnings.
//
// Usage — controlled (Users dialog already holds permissions in form state):
//   <AccessGovernancePanel
//      value={formData.permissions}
//      onChange={(next) => setFormData(f => ({ ...f, permissions: next }))}
//      isAdminUser={formData.role === 'admin'}
//   />
//
// Usage — self-loading (Permission Matrix page, one user at a time):
//   <AccessGovernancePanel userId={selectedUserId} showSave />

import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown, ChevronRight, Search, Check, X, ShieldAlert, Info, Save, Loader2,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import api from '@/lib/api';
import { toast } from 'sonner';
import useDark from '@/hooks/useDark';
import { SectionCard, GuidanceNote, LoadingState, HUB_COLORS } from '@/components/ui/PageKit';
import { moduleNote, pageNote, actionNote, isHighRisk } from '@/lib/permissionGuidance';

const MODULE_COLOR = {
  taskosphere: HUB_COLORS.mediumBlue,
  finix: '#7C3AED',
  compliance: '#F59E0B',
  records: HUB_COLORS.emeraldGreen,
  proposals: '#DB2777',
  people_matrix: '#0EA5E9',
  admin: HUB_COLORS.deepBlue,
};

export default function AccessGovernancePanel({
  userId,
  value,
  onChange,
  isAdminUser = false,
  readOnly = false,
  showSave = false,
  onSaved,
}) {
  const isDark = useDark();
  const controlled = typeof onChange === 'function';

  const [moduleTree, setModuleTree] = useState([]);
  const [internal, setInternal] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState({});

  const permissions = controlled ? (value || {}) : internal;
  const setPermissions = (updater) => {
    const next = typeof updater === 'function' ? updater(permissions) : updater;
    if (controlled) onChange(next);
    else setInternal(next);
  };

  // Module tree (shared by both hosts) ────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/permission-governance/module-tree');
        setModuleTree(Array.isArray(data) ? data : []);
      } catch {
        toast.error('Could not load the module tree');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Only the self-loading (Permission Matrix) mode fetches a user's perms.
  useEffect(() => {
    if (controlled || !userId) return;
    (async () => {
      try {
        const { data } = await api.get(`/users/${userId}/permissions`);
        setInternal(data || {});
      } catch {
        toast.error('Could not load this user\u2019s permissions');
      }
    })();
  }, [userId, controlled]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return moduleTree;
    return moduleTree
      .map((mod) => {
        const modHit = (mod.label || '').toLowerCase().includes(q);
        const pages = (mod.pages || []).filter((p) => (p.label || '').toLowerCase().includes(q));
        if (modHit) return mod;
        return pages.length ? { ...mod, pages } : null;
      })
      .filter(Boolean);
  }, [moduleTree, search]);

  const toggleModule = (mod, checked) => {
    setPermissions((prev) => {
      const next = { ...prev, [mod.flag]: checked };
      // Cascade: turning a module off turns off every page inside it.
      if (!checked) (mod.pages || []).forEach((p) => { next[p.flag] = false; });
      return next;
    });
  };

  const togglePage = (flag, checked) =>
    setPermissions((prev) => ({ ...prev, [flag]: checked }));

  const bulkPages = (mod, checked) =>
    setPermissions((prev) => {
      const next = { ...prev };
      (mod.pages || []).forEach((p) => { next[p.flag] = checked; });
      if (checked) next[mod.flag] = true;
      return next;
    });

  const grantedIn = (mod) => (mod.pages || []).filter((p) => permissions[p.flag]).length;
  const totalGranted = moduleTree.reduce((n, m) => n + grantedIn(m), 0);
  const totalPages = moduleTree.reduce((n, m) => n + (m.pages?.length || 0), 0);

  const handleSave = async () => {
    if (!userId) return;
    setSaving(true);
    try {
      await api.put(`/users/${userId}/permissions`, permissions);
      toast.success('Permissions updated');
      onSaved?.(permissions);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingState label="Loading access governance…" />;

  if (isAdminUser) {
    return (
      <GuidanceNote tone="success" icon={ShieldAlert}>
        <strong>This user is an Admin.</strong> Admin access is granted by role, not by these
        switches — they already have unrestricted access to every module, page and action.
        To restrict them, change their role first.
      </GuidanceNote>
    );
  }

  return (
    <div className="space-y-4">
      <GuidanceNote icon={Info}>
        <strong>How access works:</strong> a user reaches a page only when the <em>module</em> switch
        and the <em>page</em> switch are both on. Turning a module off instantly revokes every page
        inside it. Anything marked <span className="font-semibold text-amber-600">High risk</span> exposes
        money, credentials or colleagues&rsquo; personal data — grant it deliberately and review it periodically.
      </GuidanceNote>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 min-w-0 w-full">
        <div className="relative min-w-0 w-full">
          <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-slate-400" />
          <Input
            className="pl-8"
            placeholder="Search modules and pages…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span className={`text-xs font-semibold whitespace-nowrap ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          {totalGranted}/{totalPages} pages granted
        </span>
        {showSave && (
          <Button onClick={handleSave} disabled={saving || readOnly || !userId}>
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
            Save changes
          </Button>
        )}
      </div>

      {filtered.map((mod) => {
        const color = MODULE_COLOR[mod.module] || HUB_COLORS.mediumBlue;
        const pages = mod.pages || [];
        const open = expanded[mod.module] ?? !!search;
        const moduleOn = !!permissions[mod.flag];
        const adminModule = mod.module === 'admin';

        return (
          <SectionCard
            key={mod.module}
            color={color}
            padded={false}
            className="permission-governance-card w-full min-w-0 max-w-full"
            title={
              <span className="flex items-center gap-2 min-w-0 max-w-full flex-wrap break-words">
                {mod.label}
                <span className={`text-[11px] font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {grantedIn(mod)}/{pages.length} pages
                </span>
              </span>
            }
            actions={
              <div className="flex items-center justify-end gap-2 flex-wrap min-w-0 max-w-full">
                <Button
                  size="sm"
                  variant="outline"
                  className="whitespace-nowrap shrink-0"
                  disabled={readOnly || adminModule}
                  onClick={() => bulkPages(mod, true)}
                >
                  <Check className="w-3.5 h-3.5 mr-1" /> Grant all
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="whitespace-nowrap shrink-0"
                  disabled={readOnly || adminModule}
                  onClick={() => bulkPages(mod, false)}
                >
                  <X className="w-3.5 h-3.5 mr-1" /> Clear all
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0"
                  onClick={() => setExpanded((p) => ({ ...p, [mod.module]: !open }))}
                >
                  {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </Button>
              </div>
            }
          >
            <div className="permission-governance-card-body px-5 py-4 space-y-3">
              <div className="flex items-start gap-3">
                <Checkbox
                  className="mt-0.5"
                  checked={moduleOn}
                  disabled={readOnly || adminModule}
                  onCheckedChange={(c) => toggleModule(mod, !!c)}
                />
                <div className="min-w-0">
                  <p className={`text-xs font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                    Module access
                  </p>
                  <p className={`text-xs mt-0.5 leading-relaxed break-words [overflow-wrap:anywhere] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    {moduleNote(mod.module, mod.description)}
                  </p>
                </div>
              </div>

              {open && (
                <div className={`permission-governance-page-list pt-2 border-t space-y-2 ${isDark ? 'border-slate-700/80' : 'border-slate-100'}`}>
                  {pages.length === 0 && (
                    <p className="text-xs text-slate-400">
                      No sub-pages — access to this module is all-or-nothing.
                    </p>
                  )}
                  {pages.map((page) => {
                    const risky = isHighRisk(page.flag);
                    return (
                      <div
                        key={page.flag}
                        className={`rounded-xl px-3 py-2.5 flex items-start gap-3 min-w-0 max-w-full overflow-hidden ${
                          isDark ? 'bg-slate-900/40' : 'bg-slate-50'
                        }`}
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={!!permissions[page.flag]}
                          disabled={readOnly || !moduleOn}
                          onCheckedChange={(c) => togglePage(page.flag, !!c)}
                        />
                        <div className="min-w-0 flex-1 overflow-hidden">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span
                              className={`text-xs font-semibold break-words [overflow-wrap:anywhere] ${
                                !moduleOn ? 'text-slate-400' : isDark ? 'text-slate-100' : 'text-slate-800'
                              }`}
                            >
                              {page.label}
                            </span>
                            {risky && (
                              <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 inline-flex items-center gap-1">
                                <ShieldAlert className="w-3 h-3" /> High risk
                              </span>
                            )}
                          </div>
                          <p className={`text-[11px] mt-0.5 leading-relaxed break-words [overflow-wrap:anywhere] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                            {pageNote(page.flag, page.label)}
                          </p>
                          {!!page.actions?.length && (
                            <p className="text-[10px] mt-1 text-slate-400">
                              Allows:{' '}
                              {page.actions.map((a, i) => (
                                <span key={a} title={actionNote(a)}>
                                  {i > 0 && ' · '}
                                  <span className="font-semibold capitalize">{a}</span>
                                </span>
                              ))}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </SectionCard>
        );
      })}
    </div>
  );
}
