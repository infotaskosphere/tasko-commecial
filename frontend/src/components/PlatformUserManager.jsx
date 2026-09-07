import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, CheckCircle2, Edit3, Loader2, Mail, Search, ShieldCheck, UserPlus, UserX, Users2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import api from '@/lib/api';
import { toast } from 'sonner';

const EMPTY = { full_name: '', email: '', password: '', role: 'staff', phone: '', designation: '', employee_code: '', department_id: '', departments: [] };
const DEPARTMENTS = ['GST', 'IT', 'ACC', 'TDS', 'ROC', 'TM', 'MSME', 'FEMA', 'DSC', 'OTHER'];

export default function PlatformUserManager({ companies = [] }) {
  const [companyId, setCompanyId] = useState(companies[0]?.id || '');
  const [users, setUsers] = useState([]);
  const [license, setLicense] = useState(null);
  const [company, setCompany] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(null);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);

  useEffect(() => {
    if (!companyId && companies[0]?.id) setCompanyId(companies[0].id);
    if (companyId && !companies.some(c => String(c.id) === String(companyId))) setCompanyId(companies[0]?.id || '');
  }, [companies, companyId]);

  const load = useCallback(async () => {
    if (!companyId) { setUsers([]); setCompany(null); setLicense(null); return; }
    setLoading(true);
    try {
      const r = await api.get('/commercial-master-data/platform-users', { params: { company_id: companyId } });
      setUsers(r.data?.users || []); setCompany(r.data?.company || null); setLicense(r.data?.license || null);
    } catch (e) { toast.error(e?.response?.data?.detail || 'Could not load company users'); }
    finally { setLoading(false); }
  }, [companyId]);
  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(u => [u.full_name, u.email, u.role, u.designation, u.employee_code, u.department_id].filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [users, search]);

  const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
  const newUser = () => { setEditing(null); setForm({ ...EMPTY }); setOpen(true); };
  const editUser = u => { setEditing(u); setForm({ ...EMPTY, ...u, password: '', departments: Array.isArray(u.departments) ? u.departments : [] }); setOpen(true); };
  const toggleDept = d => set('departments', form.departments.includes(d) ? form.departments.filter(x => x !== d) : [...form.departments, d]);

  const save = async () => {
    if (!companyId) return toast.error('Select a company first');
    if (!form.full_name.trim() || !form.email.trim()) return toast.error('Full name and email are required');
    if (!editing && form.password.length < 8) return toast.error('Password must be at least 8 characters');
    setSaving(true);
    try {
      const payload = { ...form, company_id: companyId };
      if (!payload.password) delete payload.password;
      if (editing) await api.put(`/commercial-master-data/platform-users/${editing.id}`, payload, { params: { company_id: companyId } });
      else await api.post('/commercial-master-data/platform-users', payload);
      toast.success(editing ? 'User updated' : 'User created');
      setOpen(false); setEditing(null); setForm({ ...EMPTY }); await load();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Could not save user'); }
    finally { setSaving(false); }
  };

  const statusAction = async (u, action) => {
    setBusy(u.id);
    try { await api.post(`/commercial-master-data/platform-users/${u.id}/${action}`, null, { params: { company_id: companyId } }); toast.success(action === 'activate' ? 'User activated' : 'User deactivated'); await load(); }
    catch (e) { toast.error(e?.response?.data?.detail || 'Could not update user'); }
    finally { setBusy(null); }
  };

  return <section className="master-data-users-card">
    <header className="master-data-section-header">
      <div className="master-data-section-heading"><span className="master-data-icon master-data-icon-blue"><Users2 /></span><div><div className="flex items-center gap-2 flex-wrap"><h2>User Details &amp; Access</h2><Badge className="master-data-badge">{users.length}</Badge></div><p>Platform-level user administration. Select a licensed customer company, then add and maintain its users without leaving Master Data.</p></div></div>
      <div className="master-data-section-actions"><div className="master-data-company-picker"><Building2 /><select value={companyId} onChange={e => setCompanyId(e.target.value)}><option value="">Select company…</option>{companies.map(c => <option key={c.id} value={c.id}>{c.name || c.company_name || c.id}</option>)}</select></div><Button onClick={newUser} disabled={!companyId} className="master-data-primary-button"><UserPlus className="h-4 w-4 mr-1.5" />Add User</Button></div>
    </header>
    <div className="master-data-user-toolbar"><div className="master-data-search"><Search /><Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, email, role, employee code…" /></div>{license && <span className="master-data-license-pill"><ShieldCheck />Active users: {users.filter(u => u.status === 'active').length} / {license.max_users}</span>}</div>
    {!companyId ? <div className="master-data-user-empty"><Building2 /><strong>Select a customer company</strong><span>Choose a licensed company above to view and manage its users.</span></div> : loading ? <div className="master-data-user-loading"><Loader2 className="animate-spin" />Loading users…</div> : visible.length === 0 ? <div className="master-data-user-empty"><Users2 /><strong>No users yet</strong><span>Create the first customer user from the <b>Add User</b> button.</span></div> : <div className="master-data-user-table-wrap"><table className="master-data-user-table"><thead><tr><th>User</th><th>Role</th><th>Employee</th><th>Department</th><th>Status</th><th></th></tr></thead><tbody>{visible.map(u => <tr key={u.id}><td><div className="master-data-user-name">{u.full_name || '—'}</div><div className="master-data-user-email"><Mail />{u.email}</div></td><td><Badge variant="outline" className="capitalize">{u.role || 'staff'}</Badge></td><td><span>{u.employee_code || '—'}</span><small>{u.designation || ''}</small></td><td><span>{(u.departments || []).join(', ') || u.department_id || '—'}</span></td><td><span className={`master-data-status master-data-status-${u.status || 'inactive'}`}>{u.status || 'inactive'}</span></td><td><div className="flex justify-end gap-1"><Button size="icon" variant="ghost" onClick={() => editUser(u)} title="Edit"><Edit3 /></Button>{u.status === 'active' ? <Button size="icon" variant="ghost" disabled={busy === u.id} onClick={() => statusAction(u, 'deactivate')} title="Deactivate"><UserX /></Button> : <Button size="icon" variant="ghost" disabled={busy === u.id} onClick={() => statusAction(u, 'activate')} title="Activate"><CheckCircle2 /></Button>}</div></td></tr>)}</tbody></table></div>}
    <footer className="master-data-section-footer"><span><ShieldCheck /> Platform Owner controls</span><span><Building2 /> {company?.name || 'Licensed company'}</span><span>Changes are company-scoped and audit logged.</span></footer>

    <Dialog open={open} onOpenChange={v => { if (!v && !saving) setOpen(false); }}><DialogContent className="max-w-3xl rounded-2xl"><div className="master-data-dialog-header"><div className="master-data-dialog-avatar"><UserPlus /></div><div><DialogTitle>{editing ? 'Edit Customer User' : 'Add Customer User'}</DialogTitle><DialogDescription>{company?.name || 'Selected company'} · licensed user directory</DialogDescription></div></div><div className="p-6 space-y-5"><div className="grid grid-cols-1 md:grid-cols-2 gap-4"><div><Label>Full Name *</Label><Input className="mt-1.5" value={form.full_name} onChange={e => set('full_name', e.target.value)} /></div><div><Label>Email *</Label><Input className="mt-1.5" type="email" value={form.email} onChange={e => set('email', e.target.value)} /></div><div><Label>Phone</Label><Input className="mt-1.5" value={form.phone} onChange={e => set('phone', e.target.value)} /></div><div><Label>{editing ? 'New Password' : 'Password *'}</Label><Input className="mt-1.5" type="password" value={form.password} onChange={e => set('password', e.target.value)} /></div><div><Label>Role</Label><select className="master-data-native-select mt-1.5" value={form.role} onChange={e => set('role', e.target.value)}><option value="staff">User / Staff</option><option value="manager">Manager</option><option value="admin">Company Admin</option></select></div><div><Label>Designation</Label><Input className="mt-1.5" value={form.designation} onChange={e => set('designation', e.target.value)} /></div><div><Label>Employee Code</Label><Input className="mt-1.5" value={form.employee_code} onChange={e => set('employee_code', e.target.value)} /></div><div><Label>Primary Department</Label><Input className="mt-1.5" value={form.department_id} onChange={e => set('department_id', e.target.value)} /></div></div><div><Label>Department Access</Label><div className="flex flex-wrap gap-2 mt-2">{DEPARTMENTS.map(d => <button type="button" key={d} onClick={() => toggleDept(d)} className={`px-3 py-2 border text-xs font-semibold rounded-lg ${form.departments.includes(d) ? 'bg-[#0D3B66] text-white border-[#0D3B66]' : 'bg-white text-slate-600 border-slate-200'}`}>{d}</button>)}</div></div><div className="flex justify-end gap-2 pt-2"><Button variant="outline" onClick={() => setOpen(false)}><X className="h-4 w-4 mr-1" />Cancel</Button><Button onClick={save} disabled={saving}>{saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}{editing ? 'Save Changes' : 'Create User'}</Button></div></div></DialogContent></Dialog>
  </section>;
}
