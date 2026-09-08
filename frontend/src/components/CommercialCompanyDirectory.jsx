import React, { useEffect, useMemo, useState } from 'react';
import { Building2, Plus, RefreshCw, ShieldCheck, Users2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import api from '@/lib/api';
import { toast } from 'sonner';

const EMPTY = {
  commercial_customer_id: '', name: '', email: '', phone: '', website: '', address: '',
  city: '', state: '', pincode: '', gstin: '', pan: '', has_gst: true,
};

export default function CommercialCompanyDirectory() {
  const [customers, setCustomers] = useState([]);
  const [unlinked, setUnlinked] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);

  const load = async () => {
    setLoading(true);
    try {
      const response = await api.get('/commercial-master-data/company-directory');
      setCustomers(response.data?.customers || []);
      setUnlinked(response.data?.unlinked_companies || []);
    } catch (error) {
      toast.error(error?.response?.data?.detail || 'Unable to load commercial company directory');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const activeCustomers = useMemo(() => customers.filter((customer) => customer.license), [customers]);
  const totalLegalCompanies = useMemo(() => customers.reduce((sum, customer) => sum + (customer.legal_companies?.length || 0), 0), [customers]);

  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const openNew = () => {
    setForm({ ...EMPTY, commercial_customer_id: activeCustomers[0]?.id || '' });
    setOpen(true);
  };

  const create = async () => {
    if (!form.commercial_customer_id) return toast.error('Select a licensed commercial customer');
    if (!form.name.trim()) return toast.error('Legal company name is required');
    setSaving(true);
    try {
      await api.post('/commercial-master-data/company-directory', {
        ...form,
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        gstin: form.gstin.trim().toUpperCase(),
        pan: form.pan.trim().toUpperCase(),
      });
      toast.success('Legal company added to the customer');
      setOpen(false);
      setForm(EMPTY);
      await load();
    } catch (error) {
      toast.error(error?.response?.data?.detail || 'Unable to create legal company');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="master-data-section-shell">
      <div className="master-data-section-header">
        <div className="master-data-section-heading">
          <span className="master-data-icon master-data-icon-blue"><Building2 /></span>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2>Customer Companies &amp; Legal Entities</h2>
              <span className="master-data-badge">{totalLegalCompanies}</span>
            </div>
            <p>Commercial customers own licenses; each customer can have multiple legal companies. Operational data remains company-scoped.</p>
          </div>
        </div>
        <div className="master-data-section-actions">
          <Button variant="outline" onClick={load} disabled={loading}><RefreshCw className={loading ? 'animate-spin' : ''} />Refresh</Button>
          <Button onClick={openNew} disabled={!activeCustomers.length} className="master-data-primary-button"><Plus />Add Legal Company</Button>
        </div>
      </div>

      {loading ? (
        <div className="master-data-user-loading"><RefreshCw className="animate-spin" />Loading commercial customers…</div>
      ) : customers.length === 0 ? (
        <div className="master-data-user-empty"><ShieldCheck /><strong>No licensed customers yet</strong><span>Generate a commercial license first; its customer will appear here.</span></div>
      ) : (
        <div className="space-y-3">
          {customers.map((customer) => (
            <div key={customer.id} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-bold text-slate-900">{customer.company_name || 'Unnamed customer'}</h3>
                    {customer.license ? <span className="master-data-status master-data-status-active">Licensed</span> : <span className="master-data-status master-data-status-inactive">No active license</span>}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{customer.contact_name || '—'} · {customer.email || '—'} · {customer.phone || '—'}</p>
                  {customer.license && <p className="mt-1 text-[11px] text-slate-400">License: {customer.license.license_key || '—'} · Users: {customer.license.max_users}</p>}
                </div>
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-500"><Users2 className="h-4 w-4" />{customer.legal_companies?.length || 0} legal companies</div>
              </div>
              <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {(customer.legal_companies || []).map((company) => (
                  <div key={company.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                    <p className="font-semibold text-sm text-slate-800">{company.name || company.company_name}</p>
                    <p className="mt-1 text-[11px] text-slate-500">{company.gstin || company.pan || 'GST/PAN not set'}</p>
                    <p className="mt-1 text-[10px] text-slate-400">Company ID: {company.id}</p>
                  </div>
                ))}
                {!customer.legal_companies?.length && <div className="rounded-xl border border-dashed border-slate-200 p-4 text-xs text-slate-400">No legal company linked yet.</div>}
              </div>
            </div>
          ))}

          {unlinked.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              {unlinked.length} legacy Company Master record{unlinked.length === 1 ? '' : 's'} are not linked to a commercial customer yet. They are intentionally not exposed as customer operational data until linked.
            </div>
          )}
        </div>
      )}

      <Dialog open={open} onOpenChange={(value) => { if (!saving) setOpen(value); }}>
        <DialogContent className="max-w-2xl rounded-2xl">
          <DialogHeader>
            <DialogTitle>Add Legal Company</DialogTitle>
            <DialogDescription>Create a legal operational company under an existing licensed commercial customer.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2 max-h-[65vh] overflow-y-auto">
            <div className="md:col-span-2"><Label>Commercial Customer *</Label><select className="master-data-native-select mt-1.5" value={form.commercial_customer_id} onChange={(e) => set('commercial_customer_id', e.target.value)}><option value="">Select customer…</option>{activeCustomers.map((customer) => <option key={customer.id} value={customer.id}>{customer.company_name} · {customer.license?.license_key || 'licensed'}</option>)}</select></div>
            <div className="md:col-span-2"><Label>Legal Company Name *</Label><Input className="mt-1.5" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. ABC Private Limited" /></div>
            <div><Label>Email</Label><Input className="mt-1.5" value={form.email} onChange={(e) => set('email', e.target.value)} /></div>
            <div><Label>Phone</Label><Input className="mt-1.5" value={form.phone} onChange={(e) => set('phone', e.target.value)} /></div>
            <div><Label>GSTIN</Label><Input className="mt-1.5" value={form.gstin} onChange={(e) => set('gstin', e.target.value)} /></div>
            <div><Label>PAN</Label><Input className="mt-1.5" value={form.pan} onChange={(e) => set('pan', e.target.value)} /></div>
            <div><Label>City</Label><Input className="mt-1.5" value={form.city} onChange={(e) => set('city', e.target.value)} /></div>
            <div><Label>State</Label><Input className="mt-1.5" value={form.state} onChange={(e) => set('state', e.target.value)} /></div>
            <div><Label>Pincode</Label><Input className="mt-1.5" value={form.pincode} onChange={(e) => set('pincode', e.target.value)} /></div>
            <div><Label>Website</Label><Input className="mt-1.5" value={form.website} onChange={(e) => set('website', e.target.value)} /></div>
            <div className="md:col-span-2"><Label>Address</Label><textarea className="mt-1.5 w-full min-h-20 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400" value={form.address} onChange={(e) => set('address', e.target.value)} /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setOpen(false)} disabled={saving}><X className="h-4 w-4 mr-1" />Cancel</Button><Button onClick={create} disabled={saving}>{saving ? 'Creating…' : 'Create Legal Company'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
