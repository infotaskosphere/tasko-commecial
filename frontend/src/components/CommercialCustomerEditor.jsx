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

const DASHBOARD_FLAG_BY_MODULE = Object.freeze({
  taskosphere: "can_view_dashboard",
  finix: "can_view_accounting_reports",
  compliance: "can_view_compliance",
  records: "can_view_documents",
  proposals: "can_view_all_leads",
  people_matrix: "can_view_user_page",
});

const dashboardReady = (module, selected) => {
  const dashboardFlag = DASHBOARD_FLAG_BY_MODULE[module?.id];
  if (!dashboardFlag) return false;
  const required = (module?.features || []).map((feature) => feature.id).filter((id) => id !== dashboardFlag);
  return required.length > 0 && required.every((id) => (selected || []).includes(id));
};

const normalizeDashboardSelection = (catalog, selections) => {
  const next = { ...(selections || {}) };
  (catalog || []).forEach((module) => {
    const dashboardFlag = DASHBOARD_FLAG_BY_MODULE[module.id];
    if (!dashboardFlag) return;
    const current = Array.from(new Set(next[module.id] || []));
    next[module.id] = dashboardReady(module, current)
      ? Array.from(new Set([...current, dashboardFlag]))
      : current.filter((id) => id !== dashboardFlag);
  });
  return next;
};

const isFeatureChecked = (module, feature, selected) => {
  const dashboardFlag = DASHBOARD_FLAG_BY_MODULE[module?.id];
  return feature.id === dashboardFlag ? dashboardReady(module, selected) : (selected || []).includes(feature.id);
};

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

  useEffect(() => {
    setSelectedFeatures((current) => normalizeDashboardSelection(activeCatalog, current));
  }, [activeCatalog]);

  const loadUsers = useCallback(async () => {
    if (!customerId && !license?.id) return;
    setUsersLoading(true);
    try {
      const res = await api.get("/commercial-master-data/platform-users", {
        params: { customer_id: customerId, company_id: customerId, license_id: license?.id },
      });
      setUsers(res.data?.users || []);
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to load company users");
    } finally {
      setUsersLoading(false);
    }
  }, [customerId, license?.id]);

  useEffect(() => {
    if (tab === "users") loadUsers();
  }, [tab, loadUsers]);

  const toggleModule = (moduleId) => {
    const module = activeCatalog.find((m) => m.id === moduleId);
    if (!module) return;
    setSelectedModules((current) => {
      if (current.includes(moduleId)) return current.filter((id) => id !== moduleId);
      return [...current, moduleId];
    });
    setSelectedFeatures((current) => normalizeDashboardSelection(activeCatalog, {
      ...current,
      [moduleId]: current[moduleId]?.length ? current[moduleId] : (module.features || []).map((feature) => feature.id),
    }));
  };

  const toggleFeature = (moduleId, featureId) => setSelectedFeatures((current) => {
    const dashboardFlag = DASHBOARD_FLAG_BY_MODULE[moduleId];
    if (featureId === dashboardFlag) return current;
    const existing = current[moduleId] || [];
    const next = existing.includes(featureId) ? existing.filter((id) => id !== featureId) : [...existing, featureId];
    return normalizeDashboardSelection(activeCatalog, { ...current, [moduleId]: next });
  });

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
      const normalizedFeatures = normalizeDashboardSelection(activeCatalog, selectedFeatures);
      const [updatedCustomer, updatedLicense] = await Promise.all([
        updateCommercialCustomer(license.customer_id, company),
        updateCommercialLicense(license.id, {
          modules: selectedModules,
          selected_features: normalizedFeatures,
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

  const openNewUserModal = () => {
    setEditingUser(null);
    setUserForm({ ...EMPTY_USER_FORM, departments: [] });
    setUserModalOpen(true);
  };
  const openEditUserModal = (u) => {
    setEditingUser(u);
    setUserForm({ full_name: u.full_name || "", email: u.email || "", password: "", role: u.role || "staff", phone: u.phone || "", designation: u.designation || "", employee_code: u.employee_code || "", department_id: u.department_id || "", departments: Array.isArray(u.departments) ? [...u.departments] : [], punch_in_time: u.punch_in_time || "10:30", grace_time: u.grace_time || "00:10", punch_out_time: u.punch_out_time || "19:00" });
    setUserModalOpen(true);
  };
  const toggleUserDept = (dept) => setUserForm((prev) => {
    const current = prev.departments || [];
    return { ...prev, departments: current.includes(dept) ? current.filter((d) => d !== dept) : [...current, dept] };
  });
  const saveUserModal = async (e) => {
    if (e) e.preventDefault();
    if (!userForm.full_name.trim()) return toast.error("Full name is required.");
    if (!userForm.email.trim()) return toast.error("Email address is required.");
    if (!editingUser && (!userForm.password || userForm.password.length < 8)) return toast.error("Password must be at least 8 characters.");
    setUserSaving(true);
    try {
      const payload = { ...userForm, customer_id: customerId, company_id: customerId, license_id: license?.id };
      if (!payload.password) delete payload.password;
      if (editingUser) {
        await api.put(`/commercial-master-data/platform-users/${editingUser.id}`, payload, { params: { customer_id: customerId, company_id: customerId } });
        toast.success(`User ${userForm.full_name} updated successfully.`);
      } else {
        await api.post("/commercial-master-data/platform-users", payload, { params: { customer_id: customerId, company_id: customerId } });
        toast.success(`User ${userForm.full_name} created successfully.`);
      }
      setUserModalOpen(false); setEditingUser(null); await loadUsers();
    } catch (err) { toast.error(err.response?.data?.detail || "Could not save user."); }
    finally { setUserSaving(false); }
  };
  const toggleUserStatus = async (u) => {
    const isAct = u.status === "active" || u.is_active; const action = isAct ? "deactivate" : "activate"; setUserBusyId(u.id);
    try {
      await api.post(`/commercial-master-data/platform-users/${u.id}/${action}`, null, { params: { customer_id: customerId, company_id: customerId } });
      toast.success(`User ${isAct ? "deactivated" : "activated"} successfully.`); await loadUsers();
    } catch (err) { toast.error(err.response?.data?.detail || `Could not ${action} user.`); }
    finally { setUserBusyId(null); }
  };
  const confirmDeleteUser = async () => {
    if (!deleteTarget) return; setDeleteBusy(true);
    try {
      await api.delete(`/commercial-master-data/platform-users/${deleteTarget.id}`, { params: { customer_id: customerId, company_id: customerId } });
      toast.success(`User ${deleteTarget.full_name || deleteTarget.email} deleted.`); setDeleteTarget(null); await loadUsers();
    } catch (err) { toast.error(err.response?.data?.detail || "Could not delete user."); }
    finally { setDeleteBusy(false); }
  };
  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    return users.filter((u) => {
      const matchRole = userRoleFilter === "all" || u.role === userRoleFilter;
      const isAct = u.status === "active" || u.is_active;
      const matchStatus = userStatusFilter === "all" || (userStatusFilter === "active" && isAct) || (userStatusFilter === "inactive" && !isAct);
      if (!matchRole || !matchStatus) return false;
      if (!q) return true;
      return [u.full_name, u.email, u.phone, u.employee_code, u.designation, u.role, u.department_id, ...(u.departments || [])].filter(Boolean).some((val) => String(val).toLowerCase().includes(q));
    });
  }, [users, userSearch, userRoleFilter, userStatusFilter]);
  const activeUsersCount = useMemo(() => users.filter((u) => u.status === "active" || u.is_active).length, [users]);
  const maxAllowedUsers = Math.max(1, Number(limits.max_users || 10));
  const tabs = [["company", "Company Details"], ["license", "License Access"], ["users", "User Management"]];

  const editor = (
    <div className="commercial-customer-editor-root" role="dialog" aria-modal="true" aria-label="Commercial customer details">
      <form onSubmit={save} className="commercial-customer-editor-panel relative rounded-3xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 px-5 py-4 md:px-7">
          <div className="flex min-w-0 items-center gap-3"><div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-900 text-white"><Building2 size={20} /></div><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">License Registry</p><h2 className="truncate text-xl font-bold text-slate-950">{company.company_name || "Customer Details"}</h2><p className="mt-0.5 truncate text-xs text-slate-500">{license?.license_key || "No license key"}</p></div></div>
          <button type="button" onClick={onClose} disabled={saving} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 disabled:opacity-40"><X size={20} /></button>
        </div>
        <div className="flex shrink-0 gap-1 border-b border-slate-100 px-5 pt-3 md:px-7">{tabs.map(([id, label]) => <button key={id} type="button" onClick={() => setTab(id)} className={`flex items-center gap-2 rounded-t-xl px-4 py-2.5 text-sm font-semibold transition ${tab === id ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}>{id === "users" && <Users2 size={15} />}{label}{id === "users" && users.length > 0 && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${tab === "users" ? "bg-white/20 text-white" : "bg-slate-200 text-slate-700"}`}>{users.length}</span>}</button>)}</div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5 md:p-7">
          {tab === "company" && <div className="space-y-5">
            <section className="rounded-2xl border border-slate-200 p-5"><div className="mb-4 flex items-center gap-2 font-bold text-slate-900"><Building2 size={17} /> Company &amp; Contact</div><div className="grid gap-4 md:grid-cols-2">{[["Company Name", "company_name", "text"], ["Contact Person", "contact_name", "text"], ["Email", "email", "email"], ["Mobile / Phone", "phone", "text"], ["GSTIN", "gstin", "text"], ["Pincode", "pincode", "text"], ["City", "city", "text"], ["State", "state", "text"]].map(([label, key, type]) => <label key={key} className="text-sm font-medium text-slate-700"><span className="mb-1.5 block">{label}</span><input type={type} value={company[key]} onChange={(e) => setCompany((v) => ({ ...v, [key]: key === "gstin" ? e.target.value.toUpperCase() : e.target.value }))} className="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-slate-400" /></label>)}<label className="text-sm font-medium text-slate-700"><span className="mb-1.5 block">Registered Address</span><input value={company.address} onChange={(e) => setCompany((v) => ({ ...v, address: e.target.value }))} className="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-slate-400" /></label><label className="text-sm font-medium text-slate-700"><span className="mb-1.5 block">GST Address</span><input value={company.gst_address} onChange={(e) => setCompany((v) => ({ ...v, gst_address: e.target.value }))} className="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-slate-400" /></label></div></section>
            <section className="rounded-2xl border border-slate-200 p-5"><div className="mb-4 flex items-center gap-2 font-bold text-slate-900"><ShieldCheck size={17} /> License Limits</div><div className="grid gap-4 md:grid-cols-2"><label className="text-sm font-medium text-slate-700"><span className="mb-1.5 block">Max Users</span><input type="number" min="1" value={limits.max_users} onChange={(e) => setLimits((v) => ({ ...v, max_users: e.target.value }))} className="w-full rounded-xl border border-slate-200 px-3 py-2.5" /></label><label className="text-sm font-medium text-slate-700"><span className="mb-1.5 block">Max Installations</span><input type="number" min="1" value={limits.max_installations} onChange={(e) => setLimits((v) => ({ ...v, max_installations: e.target.value }))} className="w-full rounded-xl border border-slate-200 px-3 py-2.5" /></label></div></section>
          </div>}
          {tab === "license" && <div className="space-y-4">{activeCatalog.map((module) => { const enabled = selectedModules.includes(module.id); const features = module.features || []; return <section key={module.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4"><div className="flex items-center gap-3"><input type="checkbox" disabled={saving} checked={enabled} onChange={() => toggleModule(module.id)} /><div className="flex-1"><div className="font-semibold text-slate-900">{module.name}</div><div className="text-xs text-slate-500">{MODULE_LABELS[module.id] || module.id}</div></div><button type="button" onClick={() => setExpanded((v) => ({ ...v, [module.id]: !v[module.id] }))} className="rounded-lg p-1 text-slate-400">{expanded[module.id] ? <ChevronDown size={17}/> : <ChevronRight size={17}/>}</button></div>{enabled && expanded[module.id] && <div className="mt-3 space-y-1 border-t border-slate-200 pt-3">{features.map((feature) => <label key={feature.id} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-white"><input type="checkbox" disabled={saving || feature.id === DASHBOARD_FLAG_BY_MODULE[module.id]} checked={isFeatureChecked(module, feature, selectedFeatures[module.id] || [])} onChange={() => toggleFeature(module.id, feature.id)} /><span className="text-xs font-medium text-slate-700">{feature.label || prettyFlag(feature.id)}</span></label>)}</div>}</section>; })}</div>}
          {tab === "users" && <div className="space-y-5"><section className="rounded-2xl border border-slate-200 p-5"><div className="flex items-center justify-between"><div><h3 className="font-bold">User Management</h3><p className="text-xs text-slate-500">{activeUsersCount} active of {maxAllowedUsers} allowed users</p></div><button type="button" onClick={openNewUserModal} disabled={users.length >= maxAllowedUsers} className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white"><UserPlus size={15}/> Add User</button></div><div className="mt-4 flex flex-wrap gap-2"><input value={userSearch} onChange={(e) => setUserSearch(e.target.value)} placeholder="Search users" className="rounded-xl border border-slate-200 px-3 py-2 text-sm"/><select value={userRoleFilter} onChange={(e) => setUserRoleFilter(e.target.value)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm"><option value="all">All roles</option><option value="admin">Admin</option><option value="staff">Staff</option></select><select value={userStatusFilter} onChange={(e) => setUserStatusFilter(e.target.value)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm"><option value="all">All status</option><option value="active">Active</option><option value="inactive">Inactive</option></select></div><div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-400"><tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Email</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">Department</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Actions</th></tr></thead><tbody className="divide-y divide-slate-100">{usersLoading ? <tr><td colSpan="6" className="px-3 py-8 text-center text-slate-400"><Loader2 className="mx-auto animate-spin" size={18}/></td></tr> : filteredUsers.map((u) => <tr key={u.id}><td className="px-3 py-3 font-semibold">{u.full_name}</td><td className="px-3 py-3 text-slate-500">{u.email}</td><td className="px-3 py-3">{u.role}</td><td className="px-3 py-3">{u.department_id || (u.departments || []).join(", ") || "—"}</td><td className="px-3 py-3">{u.status || (u.is_active ? "active" : "inactive")}</td><td className="px-3 py-3 text-right"><button type="button" onClick={() => openEditUserModal(u)} className="mr-1 rounded-lg border border-slate-200 p-2"><Pencil size={14}/></button><button type="button" onClick={() => toggleUserStatus(u)} disabled={userBusyId === u.id} className="mr-1 rounded-lg border border-slate-200 p-2"><RefreshCw size={14}/></button><button type="button" onClick={() => setDeleteTarget(u)} className="rounded-lg border border-red-200 p-2 text-red-600"><Trash2 size={14}/></button></td></tr>)}{!usersLoading && !filteredUsers.length && <tr><td colSpan="6" className="px-3 py-8 text-center text-slate-400">No users found.</td></tr>}</tbody></table></div></section></div>}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-slate-100 px-5 py-4 md:px-7"><button type="button" onClick={onClose} disabled={saving} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold">Cancel</button><button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white">{saving ? <Loader2 size={16} className="animate-spin"/> : <Save size={16}/>} Save Changes</button></div>
      </form>
      {userModalOpen && <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 p-4"><form onSubmit={saveUserModal} className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl"><div className="flex items-center justify-between"><h3 className="text-lg font-bold">{editingUser ? "Edit User" : "Add User"}</h3><button type="button" onClick={() => setUserModalOpen(false)}><X size={18}/></button></div><div className="mt-5 grid gap-4 md:grid-cols-2">{[["Full Name", "full_name"], ["Email", "email"], ["Phone", "phone"], ["Designation", "designation"], ["Employee Code", "employee_code"], ["Department", "department_id"], ["Punch In", "punch_in_time"], ["Grace Time", "grace_time"], ["Punch Out", "punch_out_time"]].map(([label, key]) => <label key={key} className="text-sm font-medium text-slate-700"><span className="mb-1.5 block">{label}</span><input type={key === "email" ? "email" : "text"} value={userForm[key]} onChange={(e) => setUserForm((v) => ({ ...v, [key]: e.target.value }))} className="w-full rounded-xl border border-slate-200 px-3 py-2.5"/></label>)}<label className="text-sm font-medium text-slate-700"><span className="mb-1.5 block">Role</span><select value={userForm.role} onChange={(e) => setUserForm((v) => ({ ...v, role: e.target.value }))} className="w-full rounded-xl border border-slate-200 px-3 py-2.5"><option value="staff">Staff</option><option value="admin">Admin</option></select></label>{!editingUser && <label className="text-sm font-medium text-slate-700"><span className="mb-1.5 block">Password</span><input type="password" value={userForm.password} onChange={(e) => setUserForm((v) => ({ ...v, password: e.target.value }))} className="w-full rounded-xl border border-slate-200 px-3 py-2.5"/></label>}</div><div className="mt-4"><div className="text-sm font-semibold text-slate-700">Departments</div><div className="mt-2 flex flex-wrap gap-2">{DEPARTMENTS.map((dept) => <button key={dept} type="button" onClick={() => toggleUserDept(dept)} className={`rounded-lg border px-2.5 py-1.5 text-xs ${userForm.departments?.includes(dept) ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200"}`}>{dept}</button>)}</div></div><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setUserModalOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold">Cancel</button><button type="submit" disabled={userSaving} className="rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white">{userSaving ? "Saving…" : "Save User"}</button></div></form></div>}
      {deleteTarget && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/50 p-4"><div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"><div className="flex items-center gap-3"><AlertCircle className="text-red-600" size={22}/><h3 className="font-bold">Delete user?</h3></div><p className="mt-3 text-sm text-slate-500">Delete {deleteTarget.full_name || deleteTarget.email}? This action cannot be undone.</p><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setDeleteTarget(null)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold">Cancel</button><button type="button" onClick={confirmDeleteUser} disabled={deleteBusy} className="rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white">{deleteBusy ? "Deleting…" : "Delete"}</button></div></div></div>}
    </div>
  );

  return typeof document !== "undefined" ? createPortal(editor, document.body) : editor;
}
