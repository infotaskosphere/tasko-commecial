from pathlib import Path

FRONTEND = Path("frontend/src/pages/Invoicing.jsx")
BACKEND = Path("backend/invoicing.py")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly 1 match, found {count}")
    return text.replace(old, new, 1)


# -----------------------------
# Backend
# -----------------------------
b = BACKEND.read_text(encoding="utf-8")
b = replace_once(
    b,
    '''class PaymentCreate(BaseModel):\n    invoice_id: str\n    amount: float\n    payment_date: str\n    payment_mode: str = "neft"\n    reference_no: str = ""\n    notes: str = ""\n''',
    '''class PaymentCreate(BaseModel):\n    invoice_id: str\n    amount: float\n    payment_date: str\n    payment_mode: str = "neft"\n    reference_no: str = ""\n    notes: str = ""\n    # Distinguishes an advance receipt from a later partial receipt while\n    # keeping both as canonical records in db.payments for the Party Ledger.\n    payment_type: Literal["advance", "partial", "payment"] = "payment"\n''',
    "PaymentCreate model",
)

# -----------------------------
# Frontend
# -----------------------------
f = FRONTEND.read_text(encoding="utf-8")

f = replace_once(
    f,
    '''gst_rate: 18, discount_amount: 0, shipping_charges: 0, other_charges: 0, advance_received: 0,\n    payment_terms: 'Due on receipt', notes: '', terms_conditions: '', reference_no: '',\n''',
    '''gst_rate: 18, discount_amount: 0, shipping_charges: 0, other_charges: 0,\n    advance_received: 0, partial_payment: 0,\n    payment_terms: 'Due on receipt', notes: '', terms_conditions: '', reference_no: '',\n''',
    "defaultForm partial payment field",
)

f = replace_once(
    f,
    '''  const handlePreview = useCallback(() => {\n    const company = (companies || []).find(c => c.id === form.company_id) || {};\n    const advance = parseFloat(form.advance_received) || 0;\n    const grand   = totals.grand_total || 0;\n    const previewInv = {\n''',
    '''  const handlePreview = useCallback(() => {\n    const company = (companies || []).find(c => c.id === form.company_id) || {};\n    const advance = parseFloat(form.advance_received) || 0;\n    const partial = parseFloat(form.partial_payment) || 0;\n    const existingPaid = parseFloat(editingInv?.amount_paid) || 0;\n    const grand   = totals.grand_total || 0;\n    const received = editingInv?.id ? Math.max(existingPaid, advance) + partial : advance + partial;\n    const previewInv = {\n''',
    "handlePreview payment totals",
)

f = replace_once(
    f,
    '''      advance_received: advance,\n      amount_paid: advance,\n      amount_due:  Math.max(0, Math.round((grand - advance) * 100) / 100),\n''',
    '''      advance_received: advance,\n      amount_paid: received,\n      amount_due:  Math.max(0, Math.round((grand - received) * 100) / 100),\n''',
    "handlePreview amount fields",
)

# Capture the saved invoice response so a newly entered partial receipt can be
# posted against the canonical invoice id. Advance receipts are already created
# by the backend during invoice creation and are deliberately not duplicated here.
f = replace_once(
    f,
    '''      if (editingInv?.id) await api.put(`/invoices/${editingInv.id}`, payload);\n      else if (['credit_note', 'debit_note'].includes(form.invoice_type) && form.original_invoice_id) {\n''',
    '''      let savedInvoice = null;\n      if (editingInv?.id) savedInvoice = await api.put(`/invoices/${editingInv.id}`, payload);\n      else if (['credit_note', 'debit_note'].includes(form.invoice_type) && form.original_invoice_id) {\n''',
    "handleSubmit save response",
)

f = replace_once(
    f,
    '''      } else {\n        await api.post('/invoices', payload);\n        try { localStorage.removeItem(INV_DRAFT_KEY); } catch {}\n      }\n      toast.success(editingInv?.id ? 'Invoice updated successfully' : 'Invoice created successfully');\n''',
    '''      } else {\n        savedInvoice = await api.post('/invoices', payload);\n        try { localStorage.removeItem(INV_DRAFT_KEY); } catch {}\n      }\n\n      // Partial Payment is an actual receipt, not a display-only deduction.\n      // Store it in db.payments so the existing payment journal synchronisation\n      // posts Dr Cash/Bank and Cr Accounts Receivable and the accounting engine\n      // immediately recalculates amount_paid / amount_due.\n      const partial = Math.max(0, parseFloat(form.partial_payment) || 0);\n      const savedInvoiceId = editingInv?.id || savedInvoice?.data?.id;\n      if (partial > 0) {\n        if (!savedInvoiceId) throw new Error('Invoice was saved but its ID was not returned; partial payment was not posted.');\n        await api.post('/payments', {\n          invoice_id: savedInvoiceId,\n          amount: partial,\n          payment_date: form.invoice_date || format(new Date(), 'yyyy-MM-dd'),\n          payment_mode: 'neft',\n          reference_no: '',\n          notes: 'Partial payment received with invoice entry',\n          payment_type: 'partial',\n        });\n      }\n\n      toast.success(\n        partial > 0\n          ? `${editingInv?.id ? 'Invoice updated' : 'Invoice created'} and partial payment of ${fmtC(partial)} recorded`\n          : (editingInv?.id ? 'Invoice updated successfully' : 'Invoice created successfully')\n      );\n''',
    "handleSubmit partial payment posting",
)

old_totals = '''                  <div className={`mt-4 p-4 rounded-xl border-2 border-dashed ${isDark ? 'border-emerald-700/50 bg-emerald-900/10' : 'border-emerald-200 bg-emerald-50/50'}`}>\n                    <div className="flex items-center gap-2 mb-3">\n                      <div className="w-5 h-5 rounded-md bg-emerald-500/20 flex items-center justify-center"><IndianRupee className="h-3 w-3 text-emerald-600" /></div>\n                      <label className={`text-xs font-bold uppercase tracking-widest ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>Advance Received from Client</label>\n                    </div>\n                    <div className="flex items-center gap-3">\n                      <div className="relative flex-1"><span className={`absolute left-3 top-1/2 -translate-y-1/2 font-bold text-sm ${isDark ? 'text-slate-400' : 'text-slate-400'}`}>₹</span><Input type="number" min="0" step="any" className={`${inputCls} pl-7`} placeholder="0.00" value={form.advance_received || ''} onChange={e => setField('advance_received', parseFloat(e.target.value) || 0)} /></div>\n                      <div className="flex gap-1.5">\n                        {[25, 50, 75, 100].map(pct => (\n                          <button key={pct} type="button"\n                            onClick={() => setField('advance_received', Math.round(totals.grand_total * pct / 100 * 100) / 100)}\n                            className={`text-[10px] font-bold px-2.5 py-1.5 rounded-lg transition-colors ${isDark ? 'bg-slate-700 text-slate-300 hover:bg-emerald-900/40 hover:text-emerald-300' : 'bg-slate-100 text-slate-600 hover:bg-emerald-100 hover:text-emerald-700'}`}>\n                            {pct}%\n                          </button>\n                        ))}\n                      </div>\n                    </div>\n                    {(form.advance_received || 0) > 0 && (\n                      <p className={`text-xs mt-2 font-medium ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>\n                        Balance due at delivery: {fmtC(Math.max(0, totals.grand_total - (form.advance_received || 0)))}\n                      </p>\n                    )}\n                  </div>\n'''

new_totals = '''                  <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">\n                    {/* Existing advance receipt */}\n                    <div className={`p-4 rounded-xl border-2 border-dashed ${isDark ? 'border-emerald-700/50 bg-emerald-900/10' : 'border-emerald-200 bg-emerald-50/50'}`}>\n                      <div className="flex items-center gap-2 mb-3">\n                        <div className="w-5 h-5 rounded-md bg-emerald-500/20 flex items-center justify-center"><IndianRupee className="h-3 w-3 text-emerald-600" /></div>\n                        <label className={`text-xs font-bold uppercase tracking-widest ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>Advance Received from Client</label>\n                      </div>\n                      <div className="flex items-center gap-3">\n                        <div className="relative flex-1"><span className={`absolute left-3 top-1/2 -translate-y-1/2 font-bold text-sm ${isDark ? 'text-slate-400' : 'text-slate-400'}`}>₹</span><Input type="number" min="0" step="any" className={`${inputCls} pl-7`} placeholder="0.00" value={form.advance_received || ''} onChange={e => setField('advance_received', parseFloat(e.target.value) || 0)} /></div>\n                        <div className="flex gap-1.5">\n                          {[25, 50, 75, 100].map(pct => (\n                            <button key={pct} type="button"\n                              onClick={() => setField('advance_received', Math.round(totals.grand_total * pct / 100 * 100) / 100)}\n                              className={`text-[10px] font-bold px-2.5 py-1.5 rounded-lg transition-colors ${isDark ? 'bg-slate-700 text-slate-300 hover:bg-emerald-900/40 hover:text-emerald-300' : 'bg-slate-100 text-slate-600 hover:bg-emerald-100 hover:text-emerald-700'}`}>\n                              {pct}%\n                            </button>\n                          ))}\n                        </div>\n                      </div>\n                      {(form.advance_received || 0) > 0 && (\n                        <p className={`text-xs mt-2 font-medium ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>\n                          Balance after advance: {fmtC(Math.max(0, totals.grand_total - (form.advance_received || 0)))}\n                        </p>\n                      )}\n                    </div>\n\n                    {/* New partial receipt — this is posted to db.payments and therefore the Party Ledger */}\n                    <div className={`p-4 rounded-xl border-2 border-dashed ${isDark ? 'border-blue-700/50 bg-blue-900/10' : 'border-blue-200 bg-blue-50/50'}`}>\n                      <div className="flex items-center gap-2 mb-3">\n                        <div className="w-5 h-5 rounded-md bg-blue-500/20 flex items-center justify-center"><IndianRupee className="h-3 w-3 text-blue-600" /></div>\n                        <label className={`text-xs font-bold uppercase tracking-widest ${isDark ? 'text-blue-400' : 'text-blue-700'}`}>Partial Payment</label>\n                      </div>\n                      <div className="relative">\n                        <span className={`absolute left-3 top-1/2 -translate-y-1/2 font-bold text-sm ${isDark ? 'text-slate-400' : 'text-slate-400'}`}>₹</span>\n                        <Input type="number" min="0" step="any" className={`${inputCls} pl-7`} placeholder="Enter payment received" value={form.partial_payment || ''} onChange={e => setField('partial_payment', parseFloat(e.target.value) || 0)} />\n                      </div>\n                      {(form.partial_payment || 0) > 0 && (\n                        <p className={`text-xs mt-2 font-medium ${isDark ? 'text-blue-400' : 'text-blue-700'}`}>\n                          New receipt: {fmtC(form.partial_payment)} · Remaining after receipt: {fmtC(Math.max(0, totals.grand_total - (form.advance_received || 0) - (form.partial_payment || 0)))}\n                        </p>\n                      )}\n                    </div>\n                  </div>\n'''

f = replace_once(f, old_totals, new_totals, "additional charges payment split")

old_summary = '''                  {(form.advance_received || 0) > 0 && (<>\n                    <div className="flex justify-between text-sm py-1.5 border-b border-dashed border-emerald-200 dark:border-emerald-800">\n                      <span className={`font-medium ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>− Advance Received</span>\n                      <span className={`font-semibold ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>− {fmtC(form.advance_received)}</span>\n                    </div>\n                    <div className="flex justify-between text-base font-bold pt-2">\n                      <span className={isDark ? 'text-amber-300' : 'text-amber-700'}>Balance Due at Delivery</span>\n                      <span className={isDark ? 'text-amber-300' : 'text-amber-700'}>{fmtC(Math.max(0, totals.grand_total - (form.advance_received||0)))}</span>\n                    </div>\n                  </>)}\n'''

new_summary = '''                  {((form.advance_received || 0) > 0 || (form.partial_payment || 0) > 0) && (<>\n                    {(form.advance_received || 0) > 0 && (\n                      <div className="flex justify-between text-sm py-1.5 border-b border-dashed border-emerald-200 dark:border-emerald-800">\n                        <span className={`font-medium ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>− Advance Received</span>\n                        <span className={`font-semibold ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>− {fmtC(form.advance_received)}</span>\n                      </div>\n                    )}\n                    {(form.partial_payment || 0) > 0 && (\n                      <div className="flex justify-between text-sm py-1.5 border-b border-dashed border-blue-200 dark:border-blue-800">\n                        <span className={`font-medium ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>− Partial Payment</span>\n                        <span className={`font-semibold ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>− {fmtC(form.partial_payment)}</span>\n                      </div>\n                    )}\n                    <div className="flex justify-between text-base font-bold pt-2">\n                      <span className={isDark ? 'text-amber-300' : 'text-amber-700'}>Balance Due</span>\n                      <span className={isDark ? 'text-amber-300' : 'text-amber-700'}>{fmtC(Math.max(0, totals.grand_total - (form.advance_received||0) - (form.partial_payment||0)))}</span>\n                    </div>\n                  </>)}\n'''

f = replace_once(f, old_summary, new_summary, "invoice summary payment rows")

FRONTEND.write_text(f, encoding="utf-8")
BACKEND.write_text(b, encoding="utf-8")
print("Partial payment patch applied successfully.")
