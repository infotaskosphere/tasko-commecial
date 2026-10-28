import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MiniLoader } from '@/components/ui/GifLoader.jsx';
import api from '@/lib/api';
import { COLORS, errorMessage, fmtC, fmtDate } from '@/lib/purchase';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Purchase Return against one bill.
 *
 * A return never edits the bill's own ledger entry: it posts its own reversing
 * entry (Dr Accounts Payable, Cr the bill's expense head, Cr GST Input).
 * Deleting a return removes only that return's entry.
 */
export default function PurchaseReturnDialog({ invoice, onClose, onChanged, canEdit, canDelete, isDark }) {
  const open = invoice !== null && invoice !== undefined;
  const isInterstate = Number(invoice?.igst_amount || 0) > 0;
  const billTaxable = Number(invoice?.taxable_amount || 0);
  const billGst = Number(invoice?.total_gst || 0);
  const gstRate = billTaxable > 0 ? billGst / billTaxable : 0;

  const [returns, setReturns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [form, setForm] = useState({ return_date: '', taxable_amount: '', gst_amount: '', supplier_note_no: '', reason: '' });

  const load = useCallback(async () => {
    if (!invoice?.id) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/purchase-invoices/${invoice.id}/returns`);
      setReturns(Array.isArray(data) ? data : []);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not load purchase returns'));
      setReturns([]);
    } finally {
      setLoading(false);
    }
  }, [invoice?.id]);

  useEffect(() => {
    if (!open) return;
    setForm({ return_date: format(new Date(), 'yyyy-MM-dd'), taxable_amount: '', gst_amount: '', supplier_note_no: '', reason: '' });
    load();
  }, [open, load]);

  const returnedTotal = useMemo(() => r2(returns.reduce((s, r) => s + Number(r.grand_total || 0), 0)), [returns]);
  const returnedGst = useMemo(() => r2(returns.reduce((s, r) => s + Number(r.gst_amount || 0), 0)), [returns]);
  const remaining = r2(Number(invoice?.grand_total || 0) - returnedTotal);
  const remainingGst = r2(billGst - returnedGst);

  const taxable = r2(form.taxable_amount);
  const gst = r2(form.gst_amount);
  const total = r2(taxable + gst);
  const problems = [];
  if (total <= 0) problems.push('Enter the value being returned.');
  if (total > remaining + 0.005) problems.push(`Only ${fmtC(remaining)} is left to return on this bill.`);
  if (gst > remainingGst + 0.005) problems.push(`GST returned cannot exceed the bill's remaining GST of ${fmtC(remainingGst)}.`);

  const setTaxable = (value) => {
    // Default the GST to the bill's own rate; the user can still override it.
    const t = r2(value);
    setForm((f) => ({ ...f, taxable_amount: value, gst_amount: value === '' ? '' : String(r2(t * gstRate)) }));
  };

  const save = async () => {
    if (problems.length) { toast.error(problems[0]); return; }
    setSaving(true);
    try {
      const split = isInterstate
        ? { igst_amount: gst, cgst_amount: 0, sgst_amount: 0 }
        : { cgst_amount: r2(gst / 2), sgst_amount: r2(gst - r2(gst / 2)), igst_amount: 0 };
      await api.post(`/purchase-invoices/${invoice.id}/returns`, {
        return_date: form.return_date, taxable_amount: taxable, gst_amount: gst, ...split,
        supplier_note_no: form.supplier_note_no, reason: form.reason,
      });
      toast.success('Purchase return recorded — reversing entry posted to the ledger');
      setForm((f) => ({ ...f, taxable_amount: '', gst_amount: '', supplier_note_no: '', reason: '' }));
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(errorMessage(err, 'Failed to record purchase return'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (ret) => {
    if (!window.confirm(`Delete purchase return ${ret.return_no}? Its ledger entry will be removed and the bill's outstanding goes back up.`)) return;
    setDeletingId(ret.id);
    try {
      await api.delete(`/purchase-returns/${ret.id}`);
      toast.success('Purchase return deleted');
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(errorMessage(err, 'Failed to delete purchase return'));
    } finally {
      setDeletingId(null);
    }
  };

  const label = 'text-xs font-bold uppercase tracking-wider text-slate-400';
  const field = `mt-1 rounded-xl ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : ''}`;
  const panel = `rounded-xl p-3 text-sm ${isDark ? 'bg-slate-800' : 'bg-slate-50'}`;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose?.(); }}>
      <DialogContent className={`sm:max-w-lg max-h-[92vh] overflow-y-auto ${isDark ? 'bg-slate-900 text-slate-100 border-slate-800' : 'bg-white text-slate-900'}`}>
        <DialogHeader>
          <DialogTitle className="text-xl font-bold flex items-center gap-2">
            <RotateCcw className="h-5 w-5 text-amber-500" /> Purchase Return
          </DialogTitle>
        </DialogHeader>
        {open && (
          <div className="space-y-4 my-2">
            <div className={panel}>
              <p className="font-semibold">{invoice.invoice_no || 'No invoice no.'} — {invoice.supplier_name}</p>
              <p className="text-slate-400 text-xs mt-1">
                Bill total {fmtC(invoice.grand_total)} · Returned {fmtC(returnedTotal)} · Can still return {fmtC(remaining)}
              </p>
            </div>

            {canEdit && remaining > 0 && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={label}>Return date</label>
                    <Input type="date" value={form.return_date} onChange={(e) => setForm({ ...form, return_date: e.target.value })} className={field} />
                  </div>
                  <div>
                    <label className={label}>Supplier note no.</label>
                    <Input value={form.supplier_note_no} onChange={(e) => setForm({ ...form, supplier_note_no: e.target.value })} className={field} placeholder="Credit / debit note no." />
                  </div>
                  <div>
                    <label className={label}>Value returned (₹, before GST)</label>
                    <Input type="number" step="0.01" min="0" value={form.taxable_amount} onChange={(e) => setTaxable(e.target.value)} className={field} />
                  </div>
                  <div>
                    <label className={label}>GST on it (₹){isInterstate ? ' · IGST' : ' · CGST+SGST'}</label>
                    <Input type="number" step="0.01" min="0" value={form.gst_amount} onChange={(e) => setForm({ ...form, gst_amount: e.target.value })} className={field} />
                  </div>
                </div>
                <div>
                  <label className={label}>Reason (optional)</label>
                  <Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className={field} placeholder="Damaged goods, short supply…" />
                </div>
                <p className="text-xs text-slate-400">
                  Return total {fmtC(total)}. This posts its own reversing entry — Dr Accounts Payable,
                  Cr {invoice.expense_ledger_name || 'Purchases'}{gst > 0 ? ', Cr GST Input Credit' : ''}. The bill's own entry is not changed.
                </p>
                {total > 0 && problems.length > 0 && <p className="text-xs text-red-500">{problems[0]}</p>}
                <div className="flex justify-end">
                  <Button onClick={save} disabled={saving || problems.length > 0} className="rounded-xl text-white" style={{ background: COLORS.mediumBlue }}>
                    {saving ? <MiniLoader height={18} /> : 'Record Return'}
                  </Button>
                </div>
              </>
            )}

            <div>
              <p className={label}>Returns on this bill</p>
              {loading ? (
                <div className="py-3"><MiniLoader height={20} /></div>
              ) : returns.length === 0 ? (
                <p className="text-sm text-slate-400 mt-2">No returns recorded yet.</p>
              ) : (
                <ul className="mt-2 divide-y" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
                  {returns.map((ret) => (
                    <li key={ret.id} className="py-2 flex items-center justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <p className="font-semibold">{ret.return_no} · {fmtC(ret.grand_total)}</p>
                        <p className="text-xs text-slate-400 truncate">
                          {fmtDate(ret.return_date)} · GST {fmtC(ret.gst_amount)}
                          {ret.supplier_note_no ? ` · Note ${ret.supplier_note_no}` : ''}{ret.reason ? ` · ${ret.reason}` : ''}
                        </p>
                      </div>
                      {canDelete && (
                        <Button size="icon" variant="ghost" disabled={deletingId === ret.id} onClick={() => remove(ret)}
                          className="h-7 w-7 rounded-lg text-slate-400 hover:text-red-500" title="Delete this return (removes its ledger entry)">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
