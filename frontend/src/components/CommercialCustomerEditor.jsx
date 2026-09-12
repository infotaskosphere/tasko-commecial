import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Mail,
  Phone,
  Save,
  ShieldCheck,
  X,
  Users2,
  UserPlus,
  Pencil,
  Trash2,
  CheckCircle2,
  UserX,
  Search,
  Shield,
  KeyRound,
  AlertCircle,
  Briefcase,
  Clock,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";
import { updateCommercialCustomer, updateCommercialLicense } from "@/lib/licenseApi";
import "@/styles/commercialConsoleLayout.css";

const MODULE_LABELS = {
  taskosphere: "Taskosphere",
  finix: "Finix",
  compliance: "Compliance",
  records: "Records",
  proposals: "Client Proposals",
  people_matrix: "People Matrix",
};

const DEPARTMENTS = ["GST", "IT", "ACC", "TDS", "ROC", "TM", "MSME", "FEMA", "DSC", "OTHER"];

const EMPTY_USER_FORM = {
  full_name: "",
  email: "",
  password: "",
  role: "staff",
  phone: "",
  designation: "",
  employee_code: "",
  department_id: "",
  departments: [],
  punch_in_time: "10:30",
  grace_time: "00:10",
  punch_out_time: "19:00",
};

const prettyFlag = (flag) => String(flag || "").replace(/^can_(view|manage)_/, "").replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase());

export default function CommercialCustomerEditor({ license, customer, modules = [], onClose, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("company");
  const [expanded, setExpanded] = useState({});
  const [company, setCompany] = useState({
    company_name: customer?.company_name || license?.customer_name || "",
    contact_name: customer?.contact_name || "",
    email: customer?.email || "",
    phone: customer?.phone || "",
    gstin: customer?.gstin || "",
    address: customer?.address || "",
    gst_address: customer?.gst_address || "",
    city: customer?.city || "",
    state: customer?.state || "",
    pincode: customer?.pincode || "",
  });
  const [selectedModules, setSelectedModules] = useState(() => [...(license?.modules || [])]);
  const [selectedFeatures, setSelectedFeatures] = useState(() => ({ ...(license?.selected_features || {}) }));
  const [limits, setLimits] = useState({
    max_users: license?.max_users ?? 10,
    max_installations: license?.max_installations ?? 1,
  });

  // ── User Management State ──────────────────────────────────────────────────
  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState("all");
  const [userStatusFilter, setUserStatusFilter] = useState("all");
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [userForm, setUserForm] = useState(EMPTY_USER_FORM);
  const [userSaving, setUserSaving] = useState(false);
  const [userBusyId, setUserBusyId] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const customerId = customer?.id || license?.customer_id || license?.company_id || "";

  const activeCatalog = useMemo(() => modules.filter((m) => m.active !== false), [modules]);

  const loadUsers = useCallback(async () => {
    if (!customerId && !license?.id) return;
    setUsersLoading(true);
    try {
      const res = await api.get("/commercial-master-data/platform-users", {
        params: {
          customer_id: customerId,
          company_id: customerId,
          license_id: license?.id,
        },
      });
      setUsers(res.data?.users || []);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to load company users");
    } finally {
      setUsersLoading(false);
    }
  }, [customerId, license?.id]);

  useEffect(() => {
    if (tab === "users") {
      loadUsers();
    }
  }, [tab, loadUsers]);

  const toggleModule = (moduleId) => {
    const module = activeCatalog.find((m) => m.id === moduleId);
    if (!module) return;
    setSelectedModules((current) => {
      if (current.includes(moduleId)) return current.filter((id) => id !== moduleId);
      return [...current, moduleId];
    });
    setSelectedFeatures((current) => ({
      ...current,
      [moduleId]: current[moduleId]?.length ? current[moduleId] : (module.features || []).map((feature) => feature.id),
    }));
  };

  const toggleFeature = (moduleId, featureId) => {
    setSelectedFeatures((current) => {
      const existing = current[moduleId] || [];
      const next = existing.includes(featureId) ? existing.filter((id) => id !== featureId) : [...existing, featureId];
      return { ...current, [moduleId]: next };
    });
  };

  const save = async (event) => {
    event.preventDefault();
    if (saving) return;
    if (!company.company_name.trim()) { toast.error("Company name is required."); return; }
    if (!company.email.trim()) { toast.error("Email is required."); return; }
    if (!selectedModules.length) { toast.error("Select at least one licensed module."); return; }
    const invalid = selectedModules.some((moduleId) => !(selectedFeatures[moduleId] || []).length);
    if (invalid) { toast.error("Every licensed module must retain at least one feature."); return; }

    setSaving(true);
    try {
      const [updatedCustomer, updatedLicense] = await Promise.all([
        updateCommercialCustomer(license.customer_id, company),
        updateCommercialLicense(license.id, {
          modules: selectedModules,
          selected_features: selectedFeatures,
          max_users: Math.max(1, Number(limits.max_users || 1)),
          max_installations: Math.max(1, Number(limits.max_installations || 1)),
        }),
      ]);
      toast.success("Customer and license details updated.");
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("license-updated", { detail: { license: updatedLicense, customer: updatedCustomer } }));
        window.dispatchEvent(new CustomEvent("commercial-license-updated", { detail: { license: updatedLicense, customer: updatedCustomer } }));
      }
      onSaved?.({ customer: updatedCustomer, license: updatedLicense });
      onClose?.();
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Unable to save customer details.");
    } finally {
      setSaving(false);
    }
  };

  // ── User Management Handlers ───────────────────────────────────────────────
  const openNewUserModal = () => {
    setEditingUser(null);
    setUserForm({ ...EMPTY_USER_FORM, departments: [] });
    setUserModalOpen(true);
  };

  const openEditUserModal = (u) => {
    setEditingUser(u);
    setUserForm({
      full_name: u.full_name || "",
      email: u.email || "",
      password: "",
      role: u.role || "staff",
      phone: u.phone || "",
      designation: u.designation || "",
      employee_code: u.employee_code || "",
      department_id: u.department_id || "",
      departments: Array.isArray(u.departments) ? [...u.departments] : [],
      punch_in_time: u.punch_in_time || "10:30",
      grace_time: u.grace_time || "00:10",
      punch_out_time: u.punch_out_time || "19:00",
    });
    setUserModalOpen(true);
  };

  const toggleUserDept = (dept) => {
    setUserForm((prev) => {
      const current = prev.departments || [];
      const updated = current.includes(dept) ? current.filter((d) => d !== dept) : [...current, dept];
      return { ...prev, departments: updated };
    });
  };

  const saveUserModal = async (e) => {
    if (e) e.preventDefault();
    if (!userForm.full_name.trim()) return toast.error("Full name is required.");
    if (!userForm.email.trim()) return toast.error("Email address is required.");
    if (!editingUser && (!userForm.password || userForm.password.length < 8)) {
      return toast.error("Password must be at least 8 characters.");
    }

    setUserSaving(true);
    try {
      const payload = {
        ...userForm,
        customer_id: customerId,
        company_id: customerId,
        license_id: license?.id,
      };
      if (!payload.password) delete payload.password;

      if (editingUser) {
        await api.put(`/commercial-master-data/platform-users/${editingUser.id}`, payload, {
          params: { customer_id: customerId, company_id: customerId },
        });
        toast.success(`User ${userForm.full_name} updated successfully.`);
      } else {
        await api.post("/commercial-master-data/platform-users", payload, {
          params: { customer_id: customerId, company_id: customerId },
        });
        toast.success(`User ${userForm.full_name} created successfully.`);
      }
      setUserModalOpen(false);
      setEditingUser(null);
      await loadUsers();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Could not save user.");
    } finally {
      setUserSaving(false);
    }
  };

  const toggleUserStatus = async (u) => {
    const isAct = u.status === "active" || u.is_active;
    const action = isAct ? "deactivate" : "activate";
    setUserBusyId(u.id);
    try {
      await api.post(`/commercial-master-data/platform-users/${u.id}/${action}`, null, {
        params: { customer_id: customerId, company_id: customerId },
      });
      toast.success(`User ${isAct ? "deactivated" : "activated"} successfully.`);
      await loadUsers();
    } catch (err) {
      toast.error(err.response?.data?.detail || `Could not ${action} user.`);
    } finally {
      setUserBusyId(null);
    }
  };

  const confirmDeleteUser = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await api.delete(`/commercial-master-data/platform-users/${deleteTarget.id}`, {
        params: { customer_id: customerId, company_id: customerId },
      });
      toast.success(`User ${deleteTarget.full_name || deleteTarget.email} deleted.`);
      setDeleteTarget(null);
      await loadUsers();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Could not delete user.");
    } finally {
      setDeleteBusy(false);
    }
  };

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    return users.filter((u) => {
      const matchRole = userRoleFilter === "all" || u.role === userRoleFilter;
      const isAct = u.status === "active" || u.is_active;
      const matchStatus =
        userStatusFilter === "all" ||
        (userStatusFilter === "active" && isAct) ||
        (userStatusFilter === "inactive" && !isAct);
      if (!matchRole || !matchStatus) return false;
      if (!q) return true;
      return [
        u.full_name,
        u.email,
        u.phone,
        u.employee_code,
        u.designation,
        u.role,
        u.department_id,
        ...(u.departments || []),
      ]
        .filter(Boolean)
        .some((val) => String(val).toLowerCase().includes(q));
    });
  }, [users, userSearch, userRoleFilter, userStatusFilter]);

  const activeUsersCount = useMemo(() => {
    return users.filter((u) => u.status === "active" || u.is_active).length;
  }, [users]);

  const maxAllowedUsers = Math.max(1, Number(limits.max_users || 10));

  const tabs = [
    ["company", "Company Details"],
    ["license", "License Access"],
    ["users", "User Management"],
  ];

  const editor = (
    <div className="commercial-customer-editor-root" role="dialog" aria-modal="true" aria-label="Commercial customer details">
      <form onSubmit={save} className="commercial-customer-editor-panel relative rounded-3xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 px-5 py-4 md:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-900 text-white"><Building2 size={20} /></div>
            <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">License Registry</p><h2 className="truncate text-xl font-bold text-slate-950">{company.company_name || "Customer Details"}</h2><p className="mt-0.5 truncate text-xs text-slate-500">{license?.license_key || "No license key"}</p></div>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 disabled:opacity-40"><X size={20} /></button>
        </div>

        <div className="flex shrink-0 gap-1 border-b border-slate-100 px-5 pt-3 md:px-7">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`flex items-center gap-2 rounded-t-xl px-4 py-2.5 text-sm font-semibold transition ${
                tab === id ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"
              }`}
            >
              {id === "users" && <Users2 size={15} />}
              {label}
              {id === "users" && users.length > 0 && (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                    tab === "users" ? "bg-white/20 text-white" : "bg-slate-200 text-slate-700"
                  }`}
                >
                  {users.length}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5 md:p-7">
          {tab === "company" && <div className="space-y-5">
            <section className="rounded-2xl border border-slate-200 p-5">
              <div className="mb-4 flex items-center gap-2 font-bold text-slate-900"><Building2 size={17} /> Company &amp; Contact</div>
              <div className="grid gap-4 md:grid-cols-2">
                {[["Company Name", "company_name", "text"], ["Contact Person", "contact_name", "text"], ["Email", "email", "email"], ["Mobile / Phone", "phone", "text"], ["GSTIN", "gstin", "text"], ["Pincode", "pincode", "text"], ["City", "city", "text"], ["State", "state", "text"]].map(([label, key, type]) => <label key={key} className="text-sm font-medium text-slate-700"><span className="mb-1.5 block">{label}</span><input type={type} value={company[key]} onChange={(e) => setCompany((current) => ({ ...current, [key]: key === "gstin" ? e.target.value.toUpperCase() : e.target.value }))} disabled={saving} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 outline-none focus:border-slate-400 disabled:bg-slate-50" /></label>)}
                <label className="text-sm font-medium text-slate-700 md:col-span-2"><span className="mb-1.5 block">Registered Address</span><textarea rows="2" value={company.address} onChange={(e) => setCompany((current) => ({ ...current, address: e.target.value }))} disabled={saving} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 outline-none focus:border-slate-400 disabled:bg-slate-50" /></label>
                <label className="text-sm font-medium text-slate-700 md:col-span-2"><span className="mb-1.5 block">GST Address</span><textarea rows="2" value={company.gst_address} onChange={(e) => setCompany((current) => ({ ...current, gst_address: e.target.value }))} disabled={saving} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 outline-none focus:border-slate-400 disabled:bg-slate-50" /></label>
              </div>
            </section>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 p-4"><Mail size={16} className="text-slate-400" /><p className="mt-2 text-xs text-slate-400">Login / billing email</p><p className="mt-1 break-all text-sm font-semibold">{company.email || "—"}</p></div>
              <div className="rounded-2xl border border-slate-200 p-4"><Phone size={16} className="text-slate-400" /><p className="mt-2 text-xs text-slate-400">Contact number</p><p className="mt-1 text-sm font-semibold">{company.phone || "—"}</p></div>
              <div className="rounded-2xl border border-slate-200 p-4"><ShieldCheck size={16} className="text-slate-400" /><p className="mt-2 text-xs text-slate-400">License status</p><p className="mt-1 text-sm font-semibold capitalize">{license?.status || "—"}</p></div>
            </div>
          </div>}

          {tab === "license" && <div className="space-y-5">
            <section className="rounded-2xl border border-slate-200 p-5">
              <div className="mb-4 flex items-start justify-between gap-4"><div><h3 className="font-bold text-slate-900">Licensed Modules</h3><p className="mt-1 text-xs text-slate-500">Control which modules and individual features this customer can use.</p></div><ShieldCheck size={18} className="text-slate-400" /></div>
              <div className="grid gap-3 md:grid-cols-2">{activeCatalog.map((module) => {
                const enabled = selectedModules.includes(module.id);
                const features = module.features || [];
                return <div key={module.id} className={`rounded-2xl border p-4 ${enabled ? "border-slate-900 bg-slate-50" : "border-slate-200"}`}>
                  <div className="flex items-center gap-3"><input type="checkbox" checked={enabled} disabled={saving} onChange={() => toggleModule(module.id)} /><div className="min-w-0 flex-1"><p className="font-semibold text-slate-900">{module.name}</p><p className="text-xs text-slate-400">{(selectedFeatures[module.id] || []).length} of {features.length} features enabled</p></div><button type="button" disabled={!enabled || saving} onClick={() => setExpanded((current) => ({ ...current, [module.id]: !current[module.id] }))} className="rounded-lg p-1.5 text-slate-400 hover:bg-white disabled:opacity-30">{expanded[module.id] ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button></div>
                  {enabled && expanded[module.id] && <div className="mt-3 space-y-1 border-t border-slate-200 pt-3">{features.map((feature) => <label key={feature.id} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-white"><input type="checkbox" disabled={saving} checked={(selectedFeatures[module.id] || []).includes(feature.id)} onChange={() => toggleFeature(module.id, feature.id)} /><span className="text-xs font-medium text-slate-700">{feature.label || prettyFlag(feature.id)}</span></label>)}</div>}
                </div>;
              })}</div>
            </section>

            <section className="rounded-2xl border border-slate-200 p-5"><h3 className="font-bold text-slate-900">License Limits</h3><div className="mt-4 grid gap-4 md:grid-cols-2"><label className="text-sm font-medium text-slate-700"><span className="mb-1.5 block">Maximum Users</span><input type="number" min="1" value={limits.max_users} onChange={(e) => setLimits((current) => ({ ...current, max_users: e.target.value }))} disabled={saving} className="w-full rounded-xl border border-slate-200 px-3 py-2.5" /></label><label className="text-sm font-medium text-slate-700"><span className="mb-1.5 block">Maximum Installations</span><input type="number" min="1" value={limits.max_installations} onChange={(e) => setLimits((current) => ({ ...current, max_installations: e.target.value }))} disabled={saving} className="w-full rounded-xl border border-slate-200 px-3 py-2.5" /></label></div></section>
          </div>}

          {tab === "users" && (
            <div className="space-y-4">
              {/* Header card with counts and quick action */}
              <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-white">
                    <Users2 size={18} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-slate-950">Licensee Users Directory</h3>
                      <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700">
                        {users.length} Total
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                      Users belonging strictly to {company.company_name || "this licensee company"}. Isolated from platform operations.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700">
                    <ShieldCheck size={14} className="text-emerald-600" />
                    <span>Seats:</span>
                    <span className={activeUsersCount >= maxAllowedUsers ? "font-bold text-amber-600" : "font-bold text-slate-900"}>
                      {activeUsersCount} / {maxAllowedUsers} Active
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={openNewUserModal}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-slate-800"
                  >
                    <UserPlus size={14} /> Add User
                  </button>
                </div>
              </div>

              {/* Filters row */}
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="relative min-w-[220px] flex-1">
                  <Search size={14} className="absolute left-3 top-3 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search by name, email, employee code, role…"
                    value={userSearch}
                    onChange={(e) => setUserSearch(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-8 pr-3 text-xs outline-none focus:border-slate-400"
                  />
                </div>

                <select
                  value={userRoleFilter}
                  onChange={(e) => setUserRoleFilter(e.target.value)}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 outline-none"
                >
                  <option value="all">All Roles</option>
                  <option value="admin">Admin</option>
                  <option value="manager">Manager</option>
                  <option value="staff">User / Staff</option>
                </select>

                <select
                  value={userStatusFilter}
                  onChange={(e) => setUserStatusFilter(e.target.value)}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 outline-none"
                >
                  <option value="all">All Statuses</option>
                  <option value="active">Active Only</option>
                  <option value="inactive">Inactive Only</option>
                </select>

                <button
                  type="button"
                  onClick={loadUsers}
                  disabled={usersLoading}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  title="Refresh users"
                >
                  <RefreshCw size={13} className={usersLoading ? "animate-spin" : ""} />
                  Refresh
                </button>
              </div>

              {/* Users table */}
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                {usersLoading ? (
                  <div className="flex items-center justify-center gap-2 py-16 text-xs text-slate-400">
                    <Loader2 size={16} className="animate-spin" /> Loading licensee users…
                  </div>
                ) : filteredUsers.length === 0 ? (
                  <div className="py-14 text-center">
                    <Users2 size={32} className="mx-auto text-slate-300" />
                    <p className="mt-3 text-sm font-semibold text-slate-700">No users found</p>
                    <p className="mt-1 text-xs text-slate-400">
                      {userSearch || userRoleFilter !== "all" || userStatusFilter !== "all"
                        ? "No users match your current filters."
                        : `No users have been added for ${company.company_name || "this company"} yet.`}
                    </p>
                    <button
                      type="button"
                      onClick={openNewUserModal}
                      className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                    >
                      <UserPlus size={14} /> Add Company User
                    </button>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-slate-100 bg-slate-50 uppercase tracking-wider text-slate-400">
                        <tr>
                          <th className="px-4 py-3 font-semibold">User</th>
                          <th className="px-4 py-3 font-semibold">Role</th>
                          <th className="px-4 py-3 font-semibold">Employee / Designation</th>
                          <th className="px-4 py-3 font-semibold">Departments</th>
                          <th className="px-4 py-3 font-semibold">Status</th>
                          <th className="px-4 py-3 text-right font-semibold">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-slate-700">
                        {filteredUsers.map((u) => {
                          const isAct = u.status === "active" || u.is_active;
                          return (
                            <tr key={u.id} className="transition hover:bg-slate-50/70">
                              <td className="px-4 py-3.5">
                                <div className="flex items-center gap-2.5">
                                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-800 font-bold text-white">
                                    {(u.full_name || u.email || "U").charAt(0).toUpperCase()}
                                  </div>
                                  <div className="min-w-0">
                                    <p className="font-bold text-slate-900">{u.full_name || "—"}</p>
                                    <p className="text-[11px] text-slate-400">{u.email}</p>
                                    {(u.company_name || company.company_name) && (
                                      <p className="flex items-center gap-1 text-[10px] text-slate-400">
                                        <Building2 size={10} className="shrink-0" />
                                        <span className="truncate">{u.company_name || company.company_name}</span>
                                      </p>
                                    )}
                                    {u.phone && <p className="text-[10px] text-slate-400">{u.phone}</p>}
                                  </div>
                                </div>
                              </td>

                              <td className="px-4 py-3.5">
                                <span
                                  className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold capitalize ${
                                    u.role === "admin"
                                      ? "bg-purple-50 text-purple-700"
                                      : u.role === "manager"
                                      ? "bg-blue-50 text-blue-700"
                                      : "bg-slate-100 text-slate-700"
                                  }`}
                                >
                                  {u.role || "staff"}
                                </span>
                              </td>

                              <td className="px-4 py-3.5">
                                <p className="font-semibold text-slate-800">{u.employee_code || "—"}</p>
                                <p className="text-[11px] text-slate-400">{u.designation || "—"}</p>
                              </td>

                              <td className="px-4 py-3.5">
                                <div className="flex max-w-[200px] flex-wrap gap-1">
                                  {(u.departments && u.departments.length > 0
                                    ? u.departments
                                    : u.department_id
                                    ? [u.department_id]
                                    : []
                                  ).map((d) => (
                                    <span
                                      key={d}
                                      className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600"
                                    >
                                      {d}
                                    </span>
                                  ))}
                                  {(!u.departments || u.departments.length === 0) && !u.department_id && (
                                    <span className="text-slate-400">—</span>
                                  )}
                                </div>
                              </td>

                              <td className="px-4 py-3.5">
                                <span
                                  className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                    isAct ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
                                  }`}
                                >
                                  <span
                                    className={`h-1.5 w-1.5 rounded-full ${
                                      isAct ? "bg-emerald-500" : "bg-slate-400"
                                    }`}
                                  />
                                  {isAct ? "Active" : "Inactive"}
                                </span>
                              </td>

                              <td className="px-4 py-3.5 text-right">
                                <div className="inline-flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => openEditUserModal(u)}
                                    title="Edit user"
                                    className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-800"
                                  >
                                    <Pencil size={14} />
                                  </button>

                                  <button
                                    type="button"
                                    onClick={() => toggleUserStatus(u)}
                                    disabled={userBusyId === u.id}
                                    title={isAct ? "Deactivate user" : "Activate user"}
                                    className={`rounded-lg p-1.5 transition ${
                                      isAct
                                        ? "text-slate-400 hover:bg-amber-50 hover:text-amber-600"
                                        : "text-slate-400 hover:bg-emerald-50 hover:text-emerald-600"
                                    }`}
                                  >
                                    {userBusyId === u.id ? (
                                      <Loader2 size={14} className="animate-spin" />
                                    ) : isAct ? (
                                      <UserX size={14} />
                                    ) : (
                                      <CheckCircle2 size={14} />
                                    )}
                                  </button>

                                  <button
                                    type="button"
                                    onClick={() => setDeleteTarget(u)}
                                    title="Delete user"
                                    className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-100 bg-slate-50 px-5 py-4 md:px-7">
          <p className="text-xs text-slate-500">
            {tab === "users"
              ? `Managing ${users.length} users for ${company.company_name || "licensee company"}. Isolated from platform owner directory.`
              : "Changes are restricted to the Platform Owner and are recorded against the commercial customer/license."}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50"
            >
              {tab === "users" ? "Close" : "Cancel"}
            </button>
            {tab !== "users" && (
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                {saving ? "Saving…" : "Save Changes"}
              </button>
            )}
          </div>
        </div>

        {saving && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/65 backdrop-blur-[1px]">
            <div className="rounded-2xl border border-slate-200 bg-white px-6 py-5 text-center shadow-xl">
              <Loader2 size={24} className="mx-auto animate-spin text-slate-800" />
              <p className="mt-2 text-sm font-semibold">Saving customer details…</p>
            </div>
          </div>
        )}
      </form>

      {/* Add / Edit User Modal Dialog */}
      {userModalOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/60 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !userSaving) setUserModalOpen(false);
          }}
        >
          <div className="relative max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between border-b border-slate-100 pb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-white">
                  <UserPlus size={18} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-950">
                    {editingUser ? "Edit Licensee User" : "Add New Licensee User"}
                  </h3>
                  <p className="text-xs text-slate-500">
                    For {company.company_name || "Company"} ({license?.license_key || "Licensee"})
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setUserModalOpen(false)}
                disabled={userSaving}
                className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-100"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4 py-4 text-xs">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-semibold text-slate-700">Full Name *</label>
                  <input
                    type="text"
                    required
                    value={userForm.full_name}
                    onChange={(e) => setUserForm({ ...userForm, full_name: e.target.value })}
                    placeholder="e.g. Rahul Mehta"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-slate-400"
                  />
                </div>

                <div>
                  <label className="mb-1 block font-semibold text-slate-700">Email Address *</label>
                  <input
                    type="email"
                    required
                    value={userForm.email}
                    onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                    placeholder="e.g. rahul@company.com"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-slate-400"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-semibold text-slate-700">
                    {editingUser ? "Password (leave blank to keep unchanged)" : "Password * (min 8 chars)"}
                  </label>
                  <input
                    type="password"
                    value={userForm.password}
                    onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
                    placeholder={editingUser ? "••••••••" : "Minimum 8 characters"}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-slate-400"
                  />
                </div>

                <div>
                  <label className="mb-1 block font-semibold text-slate-700">Phone Number</label>
                  <input
                    type="text"
                    value={userForm.phone}
                    onChange={(e) => setUserForm({ ...userForm, phone: e.target.value })}
                    placeholder="e.g. +91 98765 43210"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-slate-400"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block font-semibold text-slate-700">Role</label>
                  <select
                    value={userForm.role}
                    onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-slate-400"
                  >
                    <option value="staff">User / Staff</option>
                    <option value="manager">Manager</option>
                    <option value="admin">Company Admin</option>
                  </select>
                </div>

                <div>
                  <label className="mb-1 block font-semibold text-slate-700">Designation</label>
                  <input
                    type="text"
                    value={userForm.designation}
                    onChange={(e) => setUserForm({ ...userForm, designation: e.target.value })}
                    placeholder="e.g. Tax Consultant"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-slate-400"
                  />
                </div>

                <div>
                  <label className="mb-1 block font-semibold text-slate-700">Employee Code</label>
                  <input
                    type="text"
                    value={userForm.employee_code}
                    onChange={(e) => setUserForm({ ...userForm, employee_code: e.target.value })}
                    placeholder="e.g. EMP-001"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-slate-400"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block font-semibold text-slate-700">Department Access</label>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {DEPARTMENTS.map((dept) => {
                    const selected = (userForm.departments || []).includes(dept);
                    return (
                      <button
                        key={dept}
                        type="button"
                        onClick={() => toggleUserDept(dept)}
                        className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition ${
                          selected
                            ? "bg-slate-900 text-white"
                            : "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
                        }`}
                      >
                        {dept}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block font-semibold text-slate-700">Punch In</label>
                  <input
                    type="time"
                    value={userForm.punch_in_time}
                    onChange={(e) => setUserForm({ ...userForm, punch_in_time: e.target.value })}
                    className="w-full rounded-xl border border-slate-200 px-3 py-1.5 text-xs outline-none focus:border-slate-400"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-semibold text-slate-700">Grace Time</label>
                  <input
                    type="time"
                    value={userForm.grace_time}
                    onChange={(e) => setUserForm({ ...userForm, grace_time: e.target.value })}
                    className="w-full rounded-xl border border-slate-200 px-3 py-1.5 text-xs outline-none focus:border-slate-400"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-semibold text-slate-700">Punch Out</label>
                  <input
                    type="time"
                    value={userForm.punch_out_time}
                    onChange={(e) => setUserForm({ ...userForm, punch_out_time: e.target.value })}
                    className="w-full rounded-xl border border-slate-200 px-3 py-1.5 text-xs outline-none focus:border-slate-400"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
              <button
                type="button"
                onClick={() => setUserModalOpen(false)}
                disabled={userSaving}
                className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveUserModal}
                disabled={userSaving}
                className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-5 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {userSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {editingUser ? "Update User" : "Create User"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete User Confirmation Modal */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/60 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !deleteBusy) setDeleteTarget(null);
          }}
        >
          <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-50 text-red-600">
                <Trash2 size={18} />
              </div>
              <div>
                <h4 className="font-bold text-slate-950">Delete Licensee User?</h4>
                <p className="text-xs text-slate-500">This action cannot be undone.</p>
              </div>
            </div>

            <p className="mt-3 text-xs text-slate-600">
              Are you sure you want to permanently delete{" "}
              <strong className="text-slate-900">{deleteTarget.full_name || deleteTarget.email}</strong> from{" "}
              <strong>{company.company_name || "this company"}</strong>?
            </p>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleteBusy}
                className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDeleteUser}
                disabled={deleteBusy}
                className="inline-flex items-center gap-1.5 rounded-xl bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleteBusy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                Delete User
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return createPortal(editor, document.body);
}
