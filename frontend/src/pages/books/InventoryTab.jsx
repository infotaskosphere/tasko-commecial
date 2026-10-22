import React, { useState } from 'react';
import { Ban } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { ReportCard, fmtC, fmtN } from '@/components/reports/ReportShared.jsx';
import { todayIso } from '@/lib/books';
import { MOVEMENT_KINDS, needsRate, rateMissing, stockStatus } from '@/lib/inventory';
import {
  DataTable, ErrorNote, FormGrid, GhostButton, Loading, Pill, PrimaryButton, Section, Stat, SubNav, clean, field, mutedCls, runAction, useLoad,
} from './ui.jsx';

const API = '/accounting-books/inventory';
const NUMERIC = ['reorder_level', 'nrv_per_unit', 'opening_quantity', 'opening_rate', 'quantity', 'rate', 'other_costs', 'discount'];

/* ── Items ── */
const ITEM_FIELDS = [
  { key: 'name', label: 'Item name', span: 2 },
  { key: 'sku', label: 'Code (optional)' },
  { key: 'unit', label: 'Unit', placeholder: 'Nos' },
  { key: 'group', label: 'Group (optional)' },
  { key: 'reorder_level', label: 'Reorder level', type: 'number', min: 0 },
  { key: 'nrv_per_unit', label: 'Net realisable value per unit (₹)', type: 'number', min: 0, step: '0.01', hint: 'Selling price less costs to sell. Leave blank if not below cost.' },
  { key: 'opening_quantity', label: 'Opening quantity', type: 'number', min: 0 },
  { key: 'opening_rate', label: 'Opening rate (₹)', type: 'number', min: 0, step: '0.01' },
  { key: 'opening_date', label: 'Opening date', type: 'date' },
];

function NrvCell({ item, companyId, isDark, onSaved }) {
  const [v, setV] = useState(item.nrv_per_unit ?? '');
  const save = async () => {
    const next = v === '' ? null : Number(v);
    if ((next ?? null) === (item.nrv_per_unit ?? null)) return;
    const body = next === null ? { company_id: companyId, clear_nrv: true } : { company_id: companyId, nrv_per_unit: next };
    if (await runAction(null, () => api.put(`${API}/items/${item.id}`, body), 'Net realisable value updated')) onSaved();
  };
  return <input aria-label={`NRV per unit for ${item.name}`} type="number" min="0" step="0.01" value={v} onChange={(e) => setV(e.target.value)} onBlur={save}
    placeholder="—" className={`${field(isDark)} w-24 font-mono text-right`} />;
}

function LedgerRows({ itemId, companyId, isDark }) {
  const { data, loading, error } = useLoad(() => api.get(`${API}/items/${itemId}/ledger`, { params: { company_id: companyId } }).then((r) => r.data), [itemId, companyId]);
  if (loading) return <Loading />;
  if (error) return <ErrorNote error={error} isDark={isDark} />;
  return (
    <DataTable isDark={isDark} rows={data.rows.map((r, i) => ({ ...r, id: r.id || i }))} empty="No movements yet."
      columns={[
        { key: 'date', label: 'Date' }, { key: 'kind', label: 'Type', render: (r) => MOVEMENT_KINDS[r.kind]?.label || r.kind },
        { key: 'ref_no', label: 'Reference' },
        { key: 'quantity', label: 'Qty', align: 'right', render: (r) => `${r.direction === 'in' ? '+' : '−'}${fmtN(r.quantity, 4)}` },
        { key: 'unit_cost', label: 'Unit cost', align: 'right', mono: true, render: (r) => fmtC(r.unit_cost) },
        { key: 'balance_quantity', label: 'Balance qty', align: 'right', render: (r) => fmtN(r.balance_quantity, 4) },
        { key: 'balance_value', label: 'Balance value', align: 'right', mono: true, render: (r) => fmtC(r.balance_value) },
      ]} />
  );
}

function ItemsPanel({ companyId, isDark }) {
  const { data, loading, error, reload } = useLoad(() => api.get(`${API}/items`, { params: { company_id: companyId } }).then((r) => r.data), [companyId]);
  const [form, setForm] = useState({ unit: 'Nos', opening_date: todayIso() });
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);

  const add = async () => {
    if (!form.name?.trim()) { toast.error('Enter the item name.'); return; }
    const ok = await runAction(setBusy, () => api.post(`${API}/items`, { company_id: companyId, ...clean(form, NUMERIC) }), 'Stock item added');
    if (ok) { setForm({ unit: 'Nos', opening_date: todayIso() }); reload(); }
  };

  return (
    <div className="space-y-4">
      {data && (
        <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
          <Stat label="Stock value" value={fmtC(data.total_value)} hint={`as of ${data.as_of}`} isDark={isDark} />
          <Stat label="Items" value={data.items.length} isDark={isDark} />
          <Stat label="At or below reorder level" value={data.items.filter((i) => i.below_reorder).length} tone={data.items.some((i) => i.below_reorder) ? 'bad' : undefined} isDark={isDark} />
          <Stat label="Cost formula" value={data.method === 'FIFO' ? 'FIFO' : 'Weighted avg'} hint="Change it in Settings" isDark={isDark} />
        </div>
      )}
      <Section title="Add a stock item" isDark={isDark}>
        <FormGrid fields={ITEM_FIELDS} values={form} onChange={setForm} isDark={isDark} />
        <div className="mt-3 flex justify-end"><PrimaryButton onClick={add} disabled={busy}>{busy ? 'Adding…' : 'Add item'}</PrimaryButton></div>
      </Section>
      <Section title="Stock items" isDark={isDark}>
        {loading ? <Loading /> : error ? <ErrorNote error={error} isDark={isDark} /> : (
          <DataTable isDark={isDark} rows={data.items} empty="No stock items yet. Add one above."
            columns={[
              { key: 'name', label: 'Item', render: (r) => (<div><span className="font-medium">{r.name}</span>{r.sku && <span className={`block text-xs ${mutedCls(isDark)}`}>{r.sku}</span>}</div>) },
              { key: 'quantity', label: 'Quantity', align: 'right', render: (r) => `${fmtN(r.quantity, 4)} ${r.unit}` },
              { key: 'unit_cost', label: 'Unit cost', align: 'right', mono: true, render: (r) => fmtC(r.unit_cost) },
              { key: 'value', label: 'Value', align: 'right', mono: true, render: (r) => fmtC(r.value) },
              { key: 'nrv', label: 'NRV / unit', align: 'right', render: (r) => <NrvCell item={r} companyId={companyId} isDark={isDark} onSaved={reload} /> },
              { key: 'status', label: 'Status', render: (r) => { const s = stockStatus(r); return <Pill tone={s.tone}>{s.label}</Pill>; } },
              { key: 'act', label: '', render: (r) => (<GhostButton isDark={isDark} onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide ledger' : 'Ledger'}</GhostButton>) },
            ]} />
        )}
        {open && <div className="mt-4"><LedgerRows itemId={open} companyId={companyId} isDark={isDark} /></div>}
      </Section>
    </div>
  );
}

/* ── Movements ── */
function MovementsPanel({ companyId, isDark }) {
  const items = useLoad(() => api.get(`${API}/items`, { params: { company_id: companyId } }).then((r) => r.data.items), [companyId]);
  const [filter, setFilter] = useState('');
  const list = useLoad(() => api.get(`${API}/movements`, { params: { company_id: companyId, item_id: filter || undefined, page_size: 50 } }).then((r) => r.data), [companyId, filter]);
  const [form, setForm] = useState({ kind: 'purchase', date: todayIso() });
  const [busy, setBusy] = useState(false);

  const fields = [
    { key: 'item_id', label: 'Item', type: 'select', placeholder: 'Choose an item', options: (items.data || []).map((i) => ({ value: i.id, label: `${i.name} (${fmtN(i.quantity, 4)} ${i.unit})` })), span: 2 },
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'kind', label: 'Type', type: 'select', options: Object.entries(MOVEMENT_KINDS).map(([value, k]) => ({ value, label: k.label })) },
    { key: 'quantity', label: 'Quantity', type: 'number', min: 0, step: '0.0001' },
    { key: 'rate', label: needsRate(form.kind) ? 'Rate (₹)' : 'Rate (₹, optional)', type: 'number', min: 0, step: '0.01', show: (v) => MOVEMENT_KINDS[v.kind]?.direction === 'in' },
    { key: 'other_costs', label: 'Freight and other costs (₹)', type: 'number', min: 0, step: '0.01', show: (v) => MOVEMENT_KINDS[v.kind]?.direction === 'in' },
    { key: 'discount', label: 'Trade discount (₹)', type: 'number', min: 0, step: '0.01', show: (v) => MOVEMENT_KINDS[v.kind]?.direction === 'in' },
    { key: 'party', label: 'Supplier or customer' },
    { key: 'ref_no', label: 'Bill or reference no.' },
    { key: 'note', label: 'Note', span: 3 },
  ];

  const save = async () => {
    if (!form.item_id) { toast.error('Choose the item.'); return; }
    if (!(Number(form.quantity) > 0)) { toast.error('Enter the quantity.'); return; }
    if (rateMissing(form)) { toast.error('Enter the rate for this receipt.'); return; }
    const ok = await runAction(setBusy, () => api.post(`${API}/movements`, { company_id: companyId, ...clean(form, NUMERIC) }), 'Stock movement recorded');
    if (ok) { setForm({ ...form, quantity: '', rate: '', other_costs: '', discount: '', ref_no: '', note: '' }); list.reload(); items.reload(); }
  };

  const cancel = async (m) => {
    if (await runAction(null, () => api.post(`${API}/movements/${m.id}/cancel`, null, { params: { company_id: companyId } }), 'Movement cancelled')) { list.reload(); items.reload(); }
  };

  const sync = async () => {
    const r = await runAction(setBusy, () => api.post(`${API}/sync-sales`, null, { params: { company_id: companyId } }).then((x) => x.data));
    if (!r) return;
    if (r.message) toast.info(r.message);
    else toast.success(`${r.created} issue${r.created === 1 ? '' : 's'} created from sales invoices`);
    r.problems?.slice(0, 3).forEach((p) => toast.warning(p));
    list.reload(); items.reload();
  };

  return (
    <div className="space-y-4">
      <Section title="Record a stock movement" isDark={isDark}
        action={<GhostButton isDark={isDark} onClick={sync} disabled={busy}>Pull issues from sales invoices</GhostButton>}>
        <FormGrid fields={fields} values={form} onChange={setForm} isDark={isDark} />
        <div className="mt-3 flex justify-end"><PrimaryButton onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Record movement'}</PrimaryButton></div>
      </Section>
      <Section title="Recent movements" isDark={isDark}
        action={(
          <select aria-label="Filter by item" value={filter} onChange={(e) => setFilter(e.target.value)} className={field(isDark)}>
            <option value="">All items</option>
            {(items.data || []).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        )}>
        {list.loading ? <Loading /> : list.error ? <ErrorNote error={list.error} isDark={isDark} /> : (
          <DataTable isDark={isDark} empty="No movements recorded."
            rows={list.data.movements.map((m) => ({ ...m, _muted: m.status === 'cancelled' }))}
            columns={[
              { key: 'date', label: 'Date' }, { key: 'item_name', label: 'Item' }, { key: 'kind_label', label: 'Type' },
              { key: 'quantity', label: 'Qty', align: 'right', render: (m) => `${m.direction === 'in' ? '+' : '−'}${fmtN(m.quantity, 4)}` },
              { key: 'rate', label: 'Unit cost', align: 'right', mono: true, render: (m) => (m.rate === null || m.rate === undefined ? '—' : fmtC(m.rate)) },
              { key: 'ref_no', label: 'Reference', render: (m) => m.ref_no || m.party || '' },
              { key: 'act', label: '', align: 'right', render: (m) => (m.status === 'cancelled' ? <Pill>Cancelled</Pill> : (
                <button type="button" aria-label="Cancel movement" onClick={() => cancel(m)} className="h-8 w-8 rounded-lg text-slate-400 hover:text-red-600"><Ban className="h-4 w-4 mx-auto" /></button>)) },
            ]} />
        )}
      </Section>
    </div>
  );
}

/* ── Closing stock valuation ── */
function ValuationPanel({ companyId, isDark }) {
  const [asOf, setAsOf] = useState(todayIso());
  const val = useLoad(() => api.get(`${API}/valuation`, { params: { company_id: companyId, as_of: asOf } }).then((r) => r.data), [companyId, asOf]);
  const history = useLoad(() => api.get(`${API}/valuations`, { params: { company_id: companyId } }).then((r) => r.data), [companyId]);
  const [busy, setBusy] = useState(false);

  const post = async () => {
    const r = await runAction(setBusy, () => api.post(`${API}/valuations`, { company_id: companyId, as_of: asOf }).then((x) => x.data));
    if (!r) return;
    toast.success(r.message || `Closing stock posted as voucher ${r.voucher_no}`);
    val.reload(); history.reload();
  };
  const cancel = async (v) => {
    if (await runAction(null, () => api.post(`${API}/valuations/${v.id}/cancel`, null, { params: { company_id: companyId } }), 'Valuation cancelled')) { val.reload(); history.reload(); }
  };
  const d = val.data;

  return (
    <div className="space-y-4">
      <ReportCard title="Closing stock" isDark={isDark}
        action={<input aria-label="Value stock as of" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className={field(isDark)} />}>
        {val.loading ? <Loading /> : val.error ? <ErrorNote error={val.error} isDark={isDark} /> : (
          <>
            <p className={`text-xs mb-3 ${mutedCls(isDark)}`}>{d.note}</p>
            <DataTable isDark={isDark} empty="No stock items to value." rowKey="item_id" rows={d.lines}
              columns={[
                { key: 'name', label: 'Item' },
                { key: 'quantity', label: 'Quantity', align: 'right', render: (r) => `${fmtN(r.quantity, 4)} ${r.unit}` },
                { key: 'unit_cost', label: 'Unit cost', align: 'right', mono: true, render: (r) => fmtC(r.unit_cost) },
                { key: 'cost', label: 'Cost', align: 'right', mono: true, render: (r) => fmtC(r.cost) },
                { key: 'nrv', label: 'NRV', align: 'right', mono: true, render: (r) => (r.nrv === null ? '—' : fmtC(r.nrv)) },
                { key: 'write_down', label: 'Write-down', align: 'right', mono: true, render: (r) => (r.write_down ? fmtC(r.write_down) : '—') },
                { key: 'carrying', label: 'Carrying value', align: 'right', mono: true, render: (r) => <strong>{fmtC(r.carrying)}</strong> },
              ]} />
            <div className="mt-4 grid gap-3 grid-cols-2 md:grid-cols-4">
              <Stat label="Cost" value={fmtC(d.total_cost)} isDark={isDark} />
              <Stat label="Written down to NRV" value={fmtC(d.total_write_down)} isDark={isDark} />
              <Stat label="Closing stock" value={fmtC(d.total_carrying)} isDark={isDark} />
              <Stat label="Inventory account holds" value={fmtC(d.book_balance)} isDark={isDark} />
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm" aria-live="polite">
                {Math.abs(d.adjustment_needed) < 0.01 ? 'The Inventory account already matches this valuation.'
                  : `Posting will ${d.adjustment_needed > 0 ? 'increase' : 'reduce'} Inventory by ${fmtC(Math.abs(d.adjustment_needed))}, against Cost of Goods Sold.`}
              </p>
              <PrimaryButton onClick={post} disabled={busy || !d.lines.length || d.lines.some((l) => l.negative_on)}>{busy ? 'Posting…' : 'Post closing stock'}</PrimaryButton>
            </div>
            {d.lines.some((l) => l.negative_on) && <p role="alert" className="mt-2 text-sm text-red-500">Some items show negative stock. Correct their movements before posting.</p>}
          </>
        )}
      </ReportCard>
      <Section title="Valuations posted" isDark={isDark}>
        {history.loading ? <Loading /> : (
          <DataTable isDark={isDark} empty="No closing stock has been posted yet." rows={(history.data || []).map((v) => ({ ...v, _muted: v.status === 'cancelled' }))}
            columns={[
              { key: 'as_of', label: 'As of' }, { key: 'method', label: 'Formula', render: (v) => (v.method === 'FIFO' ? 'FIFO' : 'Weighted average') },
              { key: 'total_carrying', label: 'Closing stock', align: 'right', mono: true, render: (v) => fmtC(v.total_carrying) },
              { key: 'delta', label: 'Posted', align: 'right', mono: true, render: (v) => fmtC(v.delta) },
              { key: 'status', label: 'Status', render: (v) => <Pill tone={v.status === 'posted' ? 'good' : 'mute'}>{v.status === 'posted' ? 'Posted' : 'Cancelled'}</Pill> },
              { key: 'act', label: '', align: 'right', render: (v) => (v.status === 'posted' ? <GhostButton isDark={isDark} onClick={() => cancel(v)}>Cancel</GhostButton> : null) },
            ]} />
        )}
      </Section>
    </div>
  );
}

export default function InventoryTab({ companyId, isDark }) {
  const [sub, setSub] = useState('items');
  return (
    <div className="space-y-4">
      <SubNav isDark={isDark} value={sub} onChange={setSub} label="Inventory section" tabs={[['items', 'Items'], ['movements', 'Movements'], ['valuation', 'Closing stock']]} />
      {sub === 'items' && <ItemsPanel companyId={companyId} isDark={isDark} />}
      {sub === 'movements' && <MovementsPanel companyId={companyId} isDark={isDark} />}
      {sub === 'valuation' && <ValuationPanel companyId={companyId} isDark={isDark} />}
    </div>
  );
}
