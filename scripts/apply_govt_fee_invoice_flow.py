from pathlib import Path
import re

p = Path('frontend/src/pages/Invoicing.jsx')
s = p.read_text(encoding='utf-8')

# Remove the existing client-selection auto-invoice population block.
s, n = re.subn(r'\n    // ── Auto-populate pending government fees into invoice items ────────────────.*?\n  \}, \[clients, form\.invoice_date\]\);', '\n  }, [clients]);', s, count=1, flags=re.S)
assert n == 1, f'auto government-fee block count={n}'

# State.
anchor = "  const [dragOverIdx, setDragOverIdx] = useState(null);     // which item is the drop target\n"
assert anchor in s
s = s.replace(anchor, anchor + "  const [govtFees, setGovtFees] = useState([]);\n  const [govtFeeSelection, setGovtFeeSelection] = useState(new Set());\n  const [govtFeeLoading, setGovtFeeLoading] = useState(false);\n", 1)

# Clear Government Fee selection whenever the client changes.
anchor = "  const handleClientSelect = useCallback(async (client) => {\n"
assert anchor in s
s = s.replace(anchor, anchor + "    setGovtFees([]);\n    setGovtFeeSelection(new Set());\n", 1)

# Controlled loader + apply function.
anchor = "  const tabs = [\n"
assert anchor in s
logic = '''  const loadGovernmentFees = useCallback(async () => {
    if (!form.client_id) { setGovtFees([]); setGovtFeeSelection(new Set()); return; }
    setGovtFeeLoading(true);
    try {
      const [complianceRes, standaloneRes] = await Promise.all([
        api.get(`/compliance/by-client/${form.client_id}`, { params: { govt_fees: true } }),
        api.get('/compliance/standalone-govt-fees', { params: { client_id: form.client_id } }),
      ]);
      const cycle = String(form.invoice_date || format(new Date(), 'yyyy-MM-dd')).slice(0, 7);
      const notBilled = (x) => {
        if (x.govt_fee_invoice_id || x.invoice_id || x.invoice_no) return false;
        if (x.bill_in_next_cycle) {
          const deferred = String(x.govt_fee_deferred_at || '').slice(0, 7);
          if (deferred && cycle <= deferred) return false;
        }
        return true;
      };
      const complianceFees = (complianceRes.data?.items || []).filter(x => notBilled(x) && Number(x.govt_fees_amount) > 0).map(x => ({
        marker: `compliance_govt_fee:${x.assignment_id}`, source: 'compliance', title: x.name || 'Government Fee', category: x.category || 'OTHER',
        amount: Number(x.govt_fees_amount) || 0, srn: x.govt_fees_srn || '', payment_date: x.govt_fee_billed_at || x.updated_at || '', notes: x.govt_fees_notes || '',
      }));
      const standaloneFees = (standaloneRes.data?.items || []).filter(x => notBilled(x) && (!x.status || x.status === 'paid') && Number(x.amount) > 0).map(x => ({
        marker: `standalone_govt_fee:${x.id}`, source: 'standalone', title: x.title || 'Government Fee', category: x.category || 'OTHER',
        amount: Number(x.amount) || 0, srn: x.srn || '', payment_date: x.payment_date || '', notes: x.notes || '',
      }));
      const fees = [...complianceFees, ...standaloneFees];
      setGovtFees(fees); setGovtFeeSelection(new Set());
    } catch (err) {
      console.warn('Could not load Government Fees:', err); setGovtFees([]); setGovtFeeSelection(new Set()); toast.error('Could not load Government Fees for this client');
    } finally { setGovtFeeLoading(false); }
  }, [form.client_id, form.invoice_date]);

  useEffect(() => {
    if (activeTab === 'govt_fees' && form.client_id && !editingInv?.id) loadGovernmentFees();
  }, [activeTab, form.client_id, form.invoice_date, editingInv?.id, loadGovernmentFees]);

  const applyGovernmentFees = useCallback((mode) => {
    const selected = mode === 'all' ? govtFees : mode === 'selected' ? govtFees.filter(f => govtFeeSelection.has(f.marker)) : [];
    const items = (form.items || []).filter(i => !String(i.product_id || '').startsWith('compliance_govt_fee:') && !String(i.product_id || '').startsWith('standalone_govt_fee:'));
    const feeItems = selected.map(f => ({ ...emptyItem(), product_id: f.marker, description: f.title || `${f.category} Govt Fees`, unit_price: f.amount, gst_rate: 0, cgst_rate: 0, sgst_rate: 0, igst_rate: 0, item_details: [f.category ? `${f.category} Govt Fees` : 'Government Fee', f.srn ? `SRN: ${f.srn}` : ''].filter(Boolean).join(' | ') }));
    setForm(p => ({ ...p, items: [...items, ...feeItems] }));
    setGovtFeeSelection(new Set(selected.map(f => f.marker)));
    if (mode === 'all') toast.success(selected.length ? `Added all ${selected.length} Government Fees to the invoice` : 'No unbilled Government Fees found');
    else if (mode === 'selected') toast.success(selected.length ? `Added ${selected.length} selected Government Fee${selected.length > 1 ? 's' : ''}` : 'No Government Fees selected');
    else toast.success('Government Fees skipped for this invoice');
  }, [govtFees, govtFeeSelection, form.items]);

'''
s = s.replace(anchor, logic + anchor, 1)

# Tab.
old = "    { id: 'totals', label: 'Totals', icon: IndianRupee },\n    { id: 'settings', label: 'Settings', icon: Layers },"
new = "    { id: 'totals', label: 'Totals', icon: IndianRupee },\n    { id: 'govt_fees', label: 'Government Fees', icon: Receipt },\n    { id: 'settings', label: 'Settings', icon: Layers },"
assert old in s
s = s.replace(old, new, 1)

# Government Fee review tab.
anchor = "            {activeTab === 'settings' && (\n"
assert anchor in s
ui = '''            {activeTab === 'govt_fees' && (
              <div className="space-y-5">
                <div className={sectionCls}>
                  <div className="flex items-start justify-between gap-4 mb-4">
                    <div><h3 className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Government Fees</h3><p className="text-xs text-slate-400 mt-1">Nothing is added automatically. Choose what to recover on this invoice.</p></div>
                    <div className="text-right"><div className="text-[10px] uppercase tracking-wider text-slate-400">Available</div><div className="text-base font-bold" style={{ color: COLORS.mediumBlue }}>{govtFees.length}</div></div>
                  </div>
                  {govtFeeLoading ? (
                    <div className="min-h-[280px] flex items-center justify-center text-sm text-slate-400"><MiniLoader /> Loading Government Fees…</div>
                  ) : !form.client_id ? (
                    <div className="min-h-[280px] flex items-center justify-center text-sm text-slate-400">Select a client first to review Government Fees.</div>
                  ) : govtFees.length === 0 ? (
                    <div className={`min-h-[280px] flex flex-col items-center justify-center rounded-xl border border-dashed ${isDark ? 'border-slate-700 text-slate-400' : 'border-slate-200 text-slate-400'}`}><Receipt className="h-8 w-8 mb-2 opacity-40" /><p className="text-sm font-medium">No unbilled Government Fees</p><p className="text-xs mt-1">Fees already billed on an invoice are excluded.</p></div>
                  ) : (
                    <div className="rounded-xl border overflow-hidden">
                      <div className={`grid grid-cols-[36px_minmax(0,1.7fr)_minmax(100px,1fr)_100px_110px] gap-2 px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider ${isDark ? 'bg-slate-800 border-slate-700 text-slate-400' : 'bg-slate-50 border-slate-100 text-slate-400'}`}><span /><span>Compliance / Fee</span><span>SRN</span><span>Date</span><span className="text-right">Amount</span></div>
                      <div className="max-h-[360px] overflow-y-auto divide-y">{govtFees.map(fee => { const checked = govtFeeSelection.has(fee.marker); return (
                        <label key={fee.marker} className={`grid grid-cols-[36px_minmax(0,1.7fr)_minmax(100px,1fr)_100px_110px] gap-2 items-center px-4 py-3 cursor-pointer transition-colors ${checked ? (isDark ? 'bg-blue-900/20' : 'bg-blue-50/60') : (isDark ? 'hover:bg-slate-800/70' : 'hover:bg-slate-50')}`}>
                          <input type="checkbox" checked={checked} onChange={() => setGovtFeeSelection(prev => { const next = new Set(prev); if (next.has(fee.marker)) next.delete(fee.marker); else next.add(fee.marker); return next; })} className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                          <span className="min-w-0"><span className={`block text-xs font-semibold truncate ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{fee.title}</span><span className="block text-[10px] text-slate-400 truncate">{fee.category}{fee.source === 'standalone' ? ' · Standalone' : ''}</span></span>
                          <span className="text-xs font-medium truncate text-slate-500" title={fee.srn}>{fee.srn || '—'}</span><span className="text-[11px] text-slate-500">{fee.payment_date ? String(fee.payment_date).slice(0, 10) : '—'}</span><span className={`text-xs font-bold text-right ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{fmtC(fee.amount)}</span>
                        </label>); })}</div>
                    </div>
                  )}
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><div className="text-xs text-slate-500">Selected: <span className="font-bold" style={{ color: COLORS.mediumBlue }}>{fmtC(govtFees.filter(f => govtFeeSelection.has(f.marker)).reduce((s, f) => s + f.amount, 0))}</span></div><div className="flex items-center gap-2"><Button type="button" variant="outline" onClick={() => applyGovernmentFees('skip')} className="h-10 px-5 rounded-xl text-xs">Skip</Button><Button type="button" variant="outline" onClick={() => applyGovernmentFees('selected')} className="h-10 px-5 rounded-xl text-xs" disabled={govtFeeSelection.size === 0}>Add Selected</Button><Button type="button" onClick={() => applyGovernmentFees('all')} className="h-10 px-5 rounded-xl text-xs text-white" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>Add All</Button></div></div>
                </div>
              </div>
            )}
'''
s = s.replace(anchor, ui + anchor, 1)

# Fixed modal dimensions.
old = 'max-w-5xl max-h-[94vh] overflow-hidden flex flex-col rounded-2xl'
new = 'w-[95vw] max-w-5xl h-[94vh] overflow-hidden flex flex-col rounded-2xl'
assert old in s
s = s.replace(old, new, 1)

# Next button order.
old = "const order = ['details', 'items', 'totals', 'settings', 'design'];"
new = "const order = ['details', 'items', 'totals', 'govt_fees', 'settings', 'design'];"
assert old in s
s = s.replace(old, new, 1)

p.write_text(s, encoding='utf-8')
print('Government Fee invoice flow applied')
