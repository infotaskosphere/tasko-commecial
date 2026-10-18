import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  UploadCloud, Search, RefreshCw, Building2, FileText, IndianRupee, CheckCircle2, AlertTriangle, ShoppingBag, X,
  Database, Edit, Trash2, Wallet, Ban, FileSpreadsheet, SlidersHorizontal, ArrowUpDown, ArrowUp, ArrowDown,
  LayoutList, Table2, Download, ChevronLeft, ChevronRight, FileCode2, Eye,
} from 'lucide-react';
import GifLoader, { MiniLoader } from '@/components/ui/GifLoader.jsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import SearchableSelect from '@/components/ui/SearchableSelect.jsx';
import api from '@/lib/api';
import { clientOptions, companyOptions, fetchPurchaseMasters, normalizeClients } from '@/lib/companies';
import { useDark } from '@/hooks/useDark';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { canPerformFinixAction } from '@/lib/commercialPermissionMatrix';
import { GuidanceNote } from '@/components/ui/GuidanceNote.jsx';
import InvoiceForm from '@/components/purchase/InvoiceForm.jsx';
import InvoicePreviewDialog from '@/components/purchase/InvoicePreviewDialog.jsx';
import ExportDialog from '@/components/purchase/ExportDialog.jsx';
import {
  COLORS, EMPTY_FILTERS, PURCHASE_STATUS_META, SORT_OPTIONS, SOURCE_OPTIONS, activeFilterCount, buildPurchaseParams,
  datePresets, errorDetail, errorMessage, fmtC, fmtDate, liveIssues, loadPref, num, savePref,
} from '@/lib/purchase';

const PREF_KEY = 'purchase.register.view.v1';
const PAGE_SIZES = [25, 50, 100, 200];
const NUM_KEYS = ['taxable_amount', 'cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount', 'total_gst', 'round_off', 'grand_total'];
const EDITABLE = [
  'company_id', 'client_id', 'supplier_name', 'supplier_gstin', 'buyer_name', 'buyer_gstin', 'invoice_no', 'invoice_date',
  'due_date', ...NUM_KEYS,
];

const nz = (v) => (v == null || v === '' || Number(v) === 0 ? '' : String(v));
const invToForm = (inv) => ({
  company_id: inv.company_id || '', client_id: inv.client_id || '',
  supplier_name: inv.supplier_name || '', supplier_gstin: inv.supplier_gstin || '',
  buyer_name: inv.buyer_name || '', buyer_gstin: inv.buyer_gstin || '',
  invoice_no: inv.invoice_no || '', invoice_date: inv.invoice_date || '', due_date: inv.due_date || '',
  taxable_amount: nz(inv.taxable_amount), cgst_amount: nz(inv.cgst_amount), sgst_amount: nz(inv.sgst_amount),
  igst_amount: nz(inv.igst_amount), cess_amount: nz(inv.cess_amount), total_gst: nz(inv.total_gst),
  round_off: inv.round_off ? String(inv.round_off) : '', grand_total: nz(inv.grand_total),
});

const STATUS_CHIPS = ['outstanding', 'partially_paid', 'paid', 'cancelled'];

function StatusBadge({ status, inv }) {
  const sm = PURCHASE_STATUS_META[status || 'outstanding'] || PURCHASE_STATUS_META.outstanding;
  return (
    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap"
      style={{ background: sm.bg, color: sm.fg, borderColor: sm.border }}
      title={inv?.amount_paid ? `Paid ${fmtC(inv.amount_paid)} of ${fmtC(inv.grand_total)}` : undefined}>
      {sm.label}
    </span>
  );
}

function MastersNotice({ state, count, onRetry, compact = false }) {
  if (state.loading) return <p className="text-[11px] text-slate-400">Loading companies from Master Data…</p>;
  const d = state.diagnostics || {};
  const retry = <button type="button" onClick={onRetry} className="underline font-semibold ml-1">Retry</button>;
  if (count > 0) {
    return d.companies_without_id > 0 ? (
      <p className="text-[11px] text-amber-600">
        {count} {count === 1 ? 'company' : 'companies'} loaded. {d.companies_without_id} more in Master Data {d.companies_without_id === 1 ? 'has' : 'have'} no ID and cannot be chosen — open each in Admin → Master Data → Company Profiles and save it once.
      </p>
    ) : (compact ? null : <p className="text-[11px] text-slate-400">{count} {count === 1 ? 'company' : 'companies'} from Master Data</p>);
  }
  let msg;
  if (state.error) {
    const st = state.error?.response?.status;
    msg = `Couldn’t load companies from Master Data${st ? ` (HTTP ${st})` : ''}. Check your connection or permissions.`;
  } else if (d.restricted_to_company) {
    msg = 'Your login is tied to a company that is not in Master Data.';
  } else if (d.companies_without_id > 0) {
    msg = `${d.companies_without_id} ${d.companies_without_id === 1 ? 'company' : 'companies'} in Master Data have no ID. Open each in Admin → Master Data → Company Profiles and save it once.`;
  } else {
    msg = 'No companies in Master Data yet. Add them in Admin → Master Data → Company Profiles.';
  }
  return <p className="text-[11px] text-amber-600">{msg}{retry}</p>;
}

function Purchase() {
  const isDark = useDark();
  const { user } = useAuth();
  const canEditPurchase = canPerformFinixAction(user, 'can_view_purchase', 'edit');
  const canDeletePurchase = canPerformFinixAction(user, 'can_view_purchase', 'delete');
  const fileRef = useRef(null);
  const gstr2bFileRef = useRef(null);
  const reqId = useRef(0);

  const saved = useMemo(() => loadPref(PREF_KEY, { view: 'table', sortBy: 'invoice_date', sortDir: 'desc', pageSize: 50 }), []);

  // master data
  const [companies, setCompanies] = useState([]);
  const [clients, setClients] = useState([]);
  const [facets, setFacets] = useState({ suppliers: [], ledgers: [] });
  const [mastersLoaded, setMastersLoaded] = useState(false);
  const [mastersState, setMastersState] = useState({ loading: true, error: null, source: '', diagnostics: null });

  // register
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totals, setTotals] = useState({ count: 0, taxable: 0, gst: 0, total: 0, paid: 0, due: 0 });
  const [reviewCount, setReviewCount] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [sortBy, setSortBy] = useState(saved.sortBy);
  const [sortDir, setSortDir] = useState(saved.sortDir);
  const [view, setView] = useState(saved.view);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(saved.pageSize);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState(() => new Set());
  const [exportOpen, setExportOpen] = useState(false);

  // upload → preview
  const [uploadCompanyId, setUploadCompanyId] = useState('auto');
  const [uploadClientId, setUploadClientId] = useState('auto');
  const [queue, setQueue] = useState({ files: [], index: 0 });
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [dragOver, setDragOver] = useState(false);

  // bills the old Zero Touch page read but nobody had booked yet
  const [inbox, setInbox] = useState([]);
  const [inboxBusy, setInboxBusy] = useState('');
  const [dismissing, setDismissing] = useState(null);   // { id, reason }

  // GSTR-2B
  const [gstr2bFile, setGstr2bFile] = useState(null);
  const [gstr2bCompanyId, setGstr2bCompanyId] = useState('');
  const [gstr2bUploading, setGstr2bUploading] = useState(false);
  const [gstr2bResult, setGstr2bResult] = useState(null);

  // edit
  const [editingInvoice, setEditingInvoice] = useState(null);
  const [editForm, setEditForm] = useState(invToForm({}));
  const [editAck, setEditAck] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  // payment
  const [payingInvoice, setPayingInvoice] = useState(null);
  const [payForm, setPayForm] = useState({ amount: 0, payment_date: format(new Date(), 'yyyy-MM-dd'), payment_mode: 'bank', bank_account_id: '', reference_no: '', notes: '' });
  const [savingPayment, setSavingPayment] = useState(false);
  const [bankAccounts, setBankAccounts] = useState([]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // ── master data: companies come from Company Profiles (Master Data), clients from Clients ──
  const loadMasters = useCallback(async () => {
    setMastersState((m) => ({ ...m, loading: true, error: null }));
    const res = await fetchPurchaseMasters();
    setCompanies(res.companies || []);
    setClients(normalizeClients(res.clients || []));
    setMastersState({ loading: false, error: res.error || null, source: res.source, diagnostics: res.diagnostics });
    setMastersLoaded(true);
  }, []);
  useEffect(() => { loadMasters(); }, [loadMasters]);

  const companyOpts = useMemo(() => companyOptions(companies), [companies]);
  const clientOpts = useMemo(() => clientOptions(clients), [clients]);

  // debounce the search box
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(filters.search), 350);
    return () => clearTimeout(t);
  }, [filters.search]);

  const activeFilters = useMemo(() => ({ ...filters, search: debouncedSearch }), [filters, debouncedSearch]);
  const filterKey = JSON.stringify(activeFilters);

  // whenever the filters change: back to page 1 and drop the tick-selection
  useEffect(() => { setPage(1); setSelected(new Set()); }, [filterKey]);
  useEffect(() => { savePref(PREF_KEY, { view, sortBy, sortDir, pageSize }); }, [view, sortBy, sortDir, pageSize]);

  // ── the register ──
  useEffect(() => {
    const id = ++reqId.current;
    setListLoading(true);
    (async () => {
      try {
        const { data } = await api.get('/purchase-invoices', {
          params: buildPurchaseParams(activeFilters, { sort_by: sortBy, sort_dir: sortDir, page, page_size: pageSize }),
        });
        if (id !== reqId.current) return;
        setRows(data?.purchase_invoices || []);
        setTotal(data?.total || 0);
        setTotals(data?.totals || { count: 0, taxable: 0, gst: 0, total: 0, paid: 0, due: 0 });
      } catch (err) {
        if (id !== reqId.current) return;
        toast.error(errorMessage(err, 'Failed to load purchase invoices'));
        setRows([]); setTotal(0);
      } finally {
        if (id === reqId.current) setListLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, sortBy, sortDir, page, pageSize, tick]);

  // facets (supplier / expense-head dropdowns) and the "needs review" count follow the company filter
  useEffect(() => {
    let alive = true;
    const company = filters.company_id !== 'all' ? filters.company_id : undefined;
    api.get('/purchase-invoices/facets', { params: { company_id: company } })
      .then((r) => { if (alive) setFacets({ suppliers: r.data?.suppliers || [], ledgers: r.data?.ledgers || [] }); })
      .catch(() => { if (alive) setFacets({ suppliers: [], ledgers: [] }); });
    api.get('/purchase-invoices', { params: { review: 'yes', page_size: 1, company_id: company } })
      .then((r) => { if (alive) setReviewCount(r.data?.total || 0); })
      .catch(() => {});
    return () => { alive = false; };
  }, [filters.company_id, tick]);

  useEffect(() => {
    let alive = true;
    api.get('/purchase-invoices/inbox')
      .then((r) => { if (alive) setInbox(Array.isArray(r.data?.items) ? r.data.items : []); })
      .catch(() => { if (alive) setInbox([]); });
    return () => { alive = false; };
  }, [tick]);

  const openInboxItem = async (item) => {
    setInboxBusy(item.id);
    try {
      const { data } = await api.get(`/purchase-invoices/inbox/${item.id}/draft`);
      setQueue({ files: [], index: 0 });
      setPreview({ data, file: null });
    } catch (err) {
      toast.error(errorMessage(err, 'Could not open this bill'));
      refresh();
    } finally {
      setInboxBusy('');
    }
  };

  const dismissInboxItem = async () => {
    if (!dismissing) return;
    if (!canDeletePurchase) { toast.error('Delete permission is required. Ask your admin to grant it in Permission Matrix.'); return; }
    if ((dismissing.reason || '').trim().length < 3) { toast.error('Say why this bill is being dismissed'); return; }
    setInboxBusy(dismissing.id);
    try {
      await api.post(`/purchase-invoices/inbox/${dismissing.id}/dismiss`, { reason: dismissing.reason.trim() });
      toast.success('Bill dismissed');
      setDismissing(null);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not dismiss this bill'));
    } finally {
      setInboxBusy('');
    }
  };

  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const clearFilters = () => setFilters(EMPTY_FILTERS);
  const filterCount = activeFilterCount(activeFilters);
  const presets = useMemo(() => datePresets(), []);

  const toggleSort = (field) => {
    if (sortBy === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(field); setSortDir(['supplier_name', 'invoice_no', 'status'].includes(field) ? 'asc' : 'desc'); }
    setPage(1);
  };

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const pageIds = rows.map((r) => r.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const toggleRow = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const togglePage = () => setSelected((s) => {
    const n = new Set(s);
    if (allOnPage) pageIds.forEach((id) => n.delete(id)); else pageIds.forEach((id) => n.add(id));
    return n;
  });

  // ── upload → editable preview → confirm ──
  const pickFiles = (list) => {
    const files = Array.from(list || []);
    if (!files.length) return;
    const ok = files.filter((f) => /\.(pdf|png|jpe?g|webp|txt|csv)$/i.test(f.name));
    if (ok.length !== files.length) toast.error('Some files were skipped — upload PDF, image, TXT or CSV invoices.');
    setQueue({ files: ok.slice(0, 25), index: 0 });
  };

  const openPreviewAt = useCallback(async (files, index) => {
    if (index >= files.length) {
      setQueue({ files: [], index: 0 }); setPreview(null);
      if (fileRef.current) fileRef.current.value = '';
      refresh();
      return;
    }
    const file = files[index];
    setReading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      if (uploadClientId !== 'auto') form.append('client_id', uploadClientId);
      if (uploadCompanyId !== 'auto') form.append('company_id', uploadCompanyId);
      const { data } = await api.post('/purchase-invoices/preview', form, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 130000,
      });
      setQueue({ files, index });
      setPreview({ data, file });
    } catch (err) {
      toast.error(`${file.name}: ${errorMessage(err, 'Could not read this file')}`);
      setPreview(null);
      await openPreviewAt(files, index + 1);
    } finally {
      setReading(false);
    }
  }, [uploadClientId, uploadCompanyId, refresh]);

  const startReading = () => {
    if (!queue.files.length) { toast.error('Select an invoice first'); return; }
    openPreviewAt(queue.files, 0);
  };
  const nextInQueue = () => { setPreview(null); openPreviewAt(queue.files, queue.index + 1); };
  const cancelQueue = () => {
    setPreview(null); setQueue({ files: [], index: 0 });
    if (fileRef.current) fileRef.current.value = '';
    refresh();
  };

  // ── GSTR-2B (unchanged behaviour; company now chosen from Master Data) ──
  const GSTR2B_ACCEPTED_EXT = ['xlsx', 'xls', 'pdf', 'zip'];
  const handleGstr2bUpload = async () => {
    if (!gstr2bFile) { toast.error('Select a GSTR-2B file first (Excel, PDF, or a ZIP of either)'); return; }
    const ext = gstr2bFile.name.split('.').pop()?.toLowerCase();
    if (!GSTR2B_ACCEPTED_EXT.includes(ext)) {
      toast.error('Unsupported file type. Upload the GSTR-2B Excel (.xlsx/.xls), PDF, or a ZIP containing them.');
      return;
    }
    if (!gstr2bCompanyId) { toast.error('Select which company/book this GSTR-2B belongs to'); return; }
    const form = new FormData();
    form.append('file', gstr2bFile);
    form.append('company_id', gstr2bCompanyId);
    setGstr2bUploading(true);
    setGstr2bResult(null);
    try {
      const { data } = await api.post('/purchase-invoices/upload-gstr2b', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      setGstr2bResult(data);
      const fileNote = data.files_processed > 1 ? ` across ${data.files_processed} files` : '';
      if (data.created > 0) {
        toast.success(`Added ${data.created} purchase bill${data.created === 1 ? '' : 's'} from GSTR-2B${fileNote}${data.duplicates ? ` (${data.duplicates} already existed)` : ''}`);
      } else if (data.duplicates > 0) {
        toast.info(`All ${data.duplicates} invoices in this GSTR-2B${fileNote} are already in the Purchase Book.`);
      } else {
        toast.info('No B2B invoices found in this GSTR-2B upload.');
      }
      setGstr2bFile(null);
      if (gstr2bFileRef.current) gstr2bFileRef.current.value = '';
      refresh();
    } catch (err) {
      toast.error(errorMessage(err, 'Failed to read GSTR-2B file'));
    } finally {
      setGstr2bUploading(false);
    }
  };

  // ── edit ──
  const startEdit = (inv) => { setEditingInvoice(inv); setEditForm(invToForm(inv)); setEditAck(false); };
  const editOriginal = useMemo(() => (editingInvoice ? invToForm(editingInvoice) : null), [editingInvoice]);
  const editIssues = useMemo(() => (editingInvoice ? liveIssues(editForm, { requireCompany: false }) : []), [editingInvoice, editForm]);
  const editHasMismatch = editIssues.some((i) => i.code === 'mismatch');
  const editBlockers = editIssues.filter((i) => i.severity === 'error' && i.code !== 'mismatch');
  const swapEditParties = () => setEditForm((f) => ({
    ...f, supplier_name: f.buyer_name, supplier_gstin: f.buyer_gstin, buyer_name: f.supplier_name, buyer_gstin: f.supplier_gstin,
  }));

  const handleSaveEdit = async (force = false) => {
    if (!canEditPurchase) { toast.error('Edit permission is required. Ask your admin to grant it in Permission Matrix.'); return; }
    if (!editingInvoice) return;
    const changes = {};
    EDITABLE.forEach((k) => {
      if (String(editForm[k] ?? '') !== String(editOriginal[k] ?? '')) {
        changes[k] = NUM_KEYS.includes(k) ? num(editForm[k]) : editForm[k];
      }
    });
    if (Object.keys(changes).length === 0) { setEditingInvoice(null); return; }
    setSavingEdit(true);
    try {
      await api.put(`/purchase-invoices/${editingInvoice.id}`, { ...changes, acknowledge_mismatch: editAck, force_duplicate: force });
      toast.success('Purchase invoice updated');
      setEditingInvoice(null);
      refresh();
    } catch (err) {
      const d = errorDetail(err);
      if (d?.code === 'duplicate' && !force && window.confirm(`${d.message}\n\nSave anyway?`)) {
        setSavingEdit(false);
        await handleSaveEdit(true);
        return;
      }
      toast.error(errorMessage(err, 'Failed to update purchase invoice'));
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDelete = async (id) => {
    if (!canDeletePurchase) { toast.error('Delete permission is required. Ask your admin to grant it in Permission Matrix.'); return; }
    if (!window.confirm('Are you sure you want to delete this purchase invoice?')) return;
    try {
      await api.delete(`/purchase-invoices/${id}`);
      toast.success('Purchase invoice deleted');
      setSelected((s) => { const n = new Set(s); n.delete(id); return n; });
      refresh();
    } catch (err) {
      toast.error(errorMessage(err, 'Failed to delete purchase invoice'));
    }
  };

  // ── payments ──
  const startPayment = (inv) => {
    setPayingInvoice(inv);
    setPayForm({ amount: Number(inv.amount_due ?? inv.grand_total ?? 0), payment_date: format(new Date(), 'yyyy-MM-dd'), payment_mode: 'bank', bank_account_id: '', reference_no: '', notes: '' });
    setBankAccounts([]);
    api.get('/bank-accounts', { params: { company_id: inv.company_id || '' } })
      .then((r) => {
        const accts = r.data || [];
        setBankAccounts(accts);
        const primary = accts.find((a) => a.is_primary) || accts[0];
        if (primary) setPayForm((p) => ({ ...p, bank_account_id: primary.id }));
      })
      .catch(() => setBankAccounts([]));
  };

  const handleSavePayment = async () => {
    if (!payingInvoice) return;
    const amt = parseFloat(payForm.amount) || 0;
    if (amt <= 0) { toast.error('Enter a payment amount greater than zero'); return; }
    if (payForm.payment_mode !== 'cash' && bankAccounts.length > 1 && !payForm.bank_account_id) {
      toast.error('Select which bank account this was paid from');
      return;
    }
    setSavingPayment(true);
    try {
      const dueNow = Number(payingInvoice.amount_due ?? payingInvoice.grand_total ?? 0);
      const status = amt >= dueNow - 0.01 ? 'paid' : 'partially_paid';
      const { data } = await api.patch(`/purchase-invoices/${payingInvoice.id}/status`, {
        status, amount: amt, payment_date: payForm.payment_date, payment_mode: payForm.payment_mode,
        bank_account_id: payForm.payment_mode !== 'cash' ? (payForm.bank_account_id || null) : null,
        reference_no: payForm.reference_no, notes: payForm.notes,
      });
      toast.success(data.status === 'paid' ? 'Marked as paid — payment entry posted to ledger' : 'Payment recorded — ledger updated');
      setPayingInvoice(null);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err, 'Failed to record payment'));
    } finally {
      setSavingPayment(false);
    }
  };

  const handleCancelInvoice = async (inv) => {
    if (!canEditPurchase) { toast.error('Edit permission is required. Ask your admin to grant it in Permission Matrix.'); return; }
    if (!window.confirm(`Mark bill ${inv.invoice_no || ''} as cancelled? Its ledger entry will be removed.`)) return;
    try {
      await api.patch(`/purchase-invoices/${inv.id}/status`, { status: 'cancelled' });
      toast.success('Bill cancelled and removed from the ledger');
      refresh();
    } catch (err) {
      toast.error(errorMessage(err, 'Failed to cancel bill'));
    }
  };

  const card = `rounded-3xl border shadow-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`;
  const border = isDark ? '#334155' : '#e2e8f0';
  const fieldCls = `rounded-xl h-9 ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white'}`;
  const miniLabel = 'text-[10px] font-bold uppercase tracking-widest text-slate-400';

  if (!mastersLoaded && listLoading && rows.length === 0 && tick === 0 && total === 0) return <GifLoader />;

  const selectFilter = (key, label, options, width = '') => (
    <div className={width}>
      <label className={miniLabel}>{label}</label>
      <Select value={filters[key]} onValueChange={(v) => setFilter({ [key]: v })}>
        <SelectTrigger className={`mt-1 ${fieldCls}`}><SelectValue /></SelectTrigger>
        <SelectContent>{options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );

  const SortHead = ({ field, children, className = '' }) => (
    <th className={`px-3 py-2 font-semibold text-[11px] uppercase tracking-wider text-slate-400 whitespace-nowrap ${className}`}>
      <button type="button" onClick={() => toggleSort(field)} className="inline-flex items-center gap-1 hover:text-blue-500">
        {children}
        {sortBy === field ? (sortDir === 'asc' ? <ArrowUp className="h-3 w-3 text-blue-500" /> : <ArrowDown className="h-3 w-3 text-blue-500" />) : <ArrowUpDown className="h-3 w-3 opacity-40" />}
      </button>
    </th>
  );

  const RowActions = ({ inv, compact = false }) => (
    <div className="flex items-center gap-1 justify-end flex-nowrap">
      {inv.status !== 'paid' && inv.status !== 'cancelled' && (
        <Button size="sm" onClick={() => startPayment(inv)} className={`h-7 rounded-lg text-white text-xs ${compact ? 'w-7 px-0' : 'px-2'}`} style={{ background: COLORS.emeraldGreen }} title="Record payment — posts a ledger entry" aria-label="Record payment">
          <Wallet className={`h-3.5 w-3.5 ${compact ? '' : 'mr-1'}`} />{!compact && ' Pay'}
        </Button>
      )}
      {canEditPurchase && <Button size="icon" variant="ghost" onClick={() => startEdit(inv)} className="h-7 w-7 rounded-lg text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/40" title="Edit / correct this bill">
        <Edit className="h-3.5 w-3.5" />
      </Button>}
      {canEditPurchase && inv.status !== 'cancelled' && (
        <Button size="icon" variant="ghost" onClick={() => handleCancelInvoice(inv)} className="h-7 w-7 rounded-lg text-slate-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/40" title="Cancel bill (removes it from the ledger)">
          <Ban className="h-3.5 w-3.5" />
        </Button>
      )}
      {canDeletePurchase && <Button size="icon" variant="ghost" onClick={() => handleDelete(inv.id)} className="h-7 w-7 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40" title="Delete purchase invoice">
        <Trash2 className="h-3.5 w-3.5" />
      </Button>}
    </div>
  );

  const TallyBadge = ({ inv }) => (inv.tally_exported_at ? (
    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 whitespace-nowrap" title={`Exported to Tally on ${fmtDate(inv.tally_exported_at)}`}>Tally ✓</span>
  ) : null);

  const stats = [
    { label: 'Purchase Invoices', value: total, icon: FileText, color: COLORS.mediumBlue },
    { label: filterCount ? 'Total (filtered)' : 'Total Purchase', value: fmtC(totals.total), icon: IndianRupee, color: COLORS.emeraldGreen },
    { label: 'Outstanding to Pay', value: fmtC(totals.due), icon: Wallet, color: totals.due ? COLORS.coral : COLORS.emeraldGreen },
    { label: 'Needs Review', value: reviewCount, icon: AlertTriangle, color: reviewCount ? COLORS.amber : COLORS.emeraldGreen },
  ];

  return (
    <div className={`min-h-screen ${isDark ? 'bg-slate-900' : 'bg-slate-50'}`}>
      <div className="p-4 md:p-6 space-y-5 max-w-[1700px] mx-auto">
        {/* header */}
        <div className="rounded-3xl overflow-hidden shadow-xl" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
          <div className="p-6 md:p-7 flex flex-col lg:flex-row lg:items-center justify-between gap-5 text-white">
            <div className="flex items-start gap-4">
              <div className="h-14 w-14 rounded-2xl bg-white/15 border border-white/20 flex items-center justify-center shadow-lg">
                <ShoppingBag className="h-7 w-7" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.25em] text-blue-100 font-bold">Accounts</p>
                <h1 className="text-2xl md:text-3xl font-bold tracking-tight mt-1">Purchase Register</h1>
                <p className="text-sm text-blue-100 mt-1 max-w-2xl">
                  Upload supplier bills, check and correct what was read, then add them to the register. Filter, sort and export the register — including a file to record the purchases in Tally.
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => setExportOpen(true)} variant="outline" className="bg-white/10 border-white/25 text-white hover:bg-white/20">
                <Download className="h-4 w-4 mr-2" /> Export / Tally
              </Button>
              <Button onClick={refresh} variant="outline" className="bg-white/10 border-white/25 text-white hover:bg-white/20">
                <RefreshCw className="h-4 w-4 mr-2" /> Refresh
              </Button>
            </div>
          </div>
        </div>

        <GuidanceNote pageKey="purchase" isDark={isDark} />

        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          {stats.map((s) => (
            <div key={s.label} className={`rounded-2xl border p-4 shadow-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[10px] uppercase tracking-widest font-bold text-slate-400">{s.label}</p>
                  <p className={`text-xl font-bold mt-1 ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{s.value}</p>
                </div>
                <div className="h-10 w-10 rounded-xl flex items-center justify-center text-white" style={{ background: s.color }}>
                  <s.icon className="h-5 w-5" />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* ── bills read earlier by the old Zero Touch page that were never booked ── */}
        {inbox.length > 0 && (
          <div className={`${card} p-5`} style={{ borderColor: COLORS.amber }}>
            <div className="flex items-start gap-3 mb-3">
              <div className="h-10 w-10 shrink-0 rounded-xl flex items-center justify-center text-white" style={{ background: COLORS.amber }}>
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h2 className={`font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Waiting for review ({inbox.length})</h2>
                <p className="text-xs text-slate-400">These bills were read earlier but never booked. Open one, check it, and add it to the register.</p>
              </div>
            </div>
            <ul className={`divide-y ${isDark ? 'divide-slate-700' : 'divide-slate-100'}`}>
              {inbox.map((it) => (
                <li key={it.id} className="py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className={`text-sm font-semibold truncate ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{it.supplier_name || it.file_name || 'Unnamed bill'}</p>
                    <p className="text-xs text-slate-400 truncate">
                      {[it.invoice_no && `Invoice ${it.invoice_no}`, it.invoice_date && fmtDate(it.invoice_date), it.note].filter(Boolean).join(' · ') || it.file_name}
                    </p>
                  </div>
                  <p className={`text-sm font-bold tabular-nums ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                    {it.currency && it.currency !== 'INR' ? `${it.currency} ${Number(it.total || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : fmtC(it.total)}
                  </p>
                  {dismissing?.id === it.id ? (
                    <div className="flex items-center gap-2 w-full sm:w-auto">
                      <Input
                        autoFocus value={dismissing.reason} placeholder="Why dismiss this bill?"
                        onChange={(e) => setDismissing({ id: it.id, reason: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter') dismissInboxItem(); }}
                        className="h-9 text-sm sm:w-64"
                      />
                      <Button size="sm" disabled={inboxBusy === it.id} onClick={dismissInboxItem}>Dismiss</Button>
                      <Button size="sm" variant="ghost" onClick={() => setDismissing(null)}>Cancel</Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button size="sm" disabled={!!inboxBusy} onClick={() => openInboxItem(it)} style={{ background: COLORS.mediumBlue }} className="text-white">
                        {inboxBusy === it.id ? <MiniLoader height={16} /> : <><Eye className="h-4 w-4 mr-1.5" />Review and add</>}
                      </Button>
                      {canDeletePurchase && <Button size="sm" variant="ghost" disabled={!!inboxBusy} onClick={() => setDismissing({ id: it.id, reason: '' })}>Dismiss</Button>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── add bills: upload + GSTR-2B side by side, register gets the full width below ── */}
        <div className="grid lg:grid-cols-2 gap-5 items-stretch">
          <div className={`${card} p-5 flex flex-col`}>
            <div className="flex items-center gap-3 mb-4">
              <div className="h-10 w-10 rounded-xl flex items-center justify-center text-white" style={{ background: COLORS.mediumBlue }}>
                <UploadCloud className="h-5 w-5" />
              </div>
              <div>
                <h2 className={`font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Upload purchase invoice</h2>
                <p className="text-xs text-slate-400">You’ll see an editable preview before anything is added.</p>
              </div>
            </div>

            <div className="space-y-3 flex-1 flex flex-col">
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="min-w-0">
                  <label className={miniLabel}>Concerned company (Master Data)</label>
                  <div className="mt-1.5">
                    <SearchableSelect
                      options={[{ value: 'auto', label: 'Auto-detect from the bill' }, ...companyOpts]}
                      value={uploadCompanyId} onChange={setUploadCompanyId} isDark={isDark}
                      placeholder="Select company…" emptyText="No company in Master Data" loading={mastersState.loading}
                    />
                  </div>
                </div>
                <div className="min-w-0">
                  <label className={miniLabel}>Linked client (optional)</label>
                  <div className="mt-1.5">
                    <SearchableSelect
                      options={[{ value: 'auto', label: 'Auto-detect from the bill' }, ...clientOpts]}
                      value={uploadClientId} onChange={setUploadClientId} isDark={isDark}
                      placeholder="Auto-detect" emptyText="No clients" loading={mastersState.loading}
                    />
                  </div>
                </div>
              </div>
              <MastersNotice state={mastersState} count={companyOpts.length} onRetry={loadMasters} />

              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFiles(e.dataTransfer.files); }}
                className={`border-2 border-dashed rounded-2xl p-4 flex items-center gap-4 transition ${dragOver ? 'border-blue-500 bg-blue-50/70' : isDark ? 'border-slate-700 bg-slate-900/60' : 'border-blue-100 bg-blue-50/60'}`}
              >
                <input ref={fileRef} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.csv" className="hidden" onChange={(e) => pickFiles(e.target.files)} />
                <UploadCloud className="h-9 w-9 flex-shrink-0" style={{ color: COLORS.mediumBlue }} />
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-semibold truncate ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                    {queue.files.length === 0 ? 'Drop invoices here or browse' : queue.files.length === 1 ? queue.files[0].name : `${queue.files.length} invoices selected`}
                  </p>
                  <p className="text-[11px] text-slate-400 truncate">
                    {queue.files.length > 1 ? queue.files.map((f) => f.name).join(', ') : 'PDF, photo or scan · up to 25 bills at once'}
                  </p>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} className="rounded-xl">Browse</Button>
                  {queue.files.length > 0 && (
                    <Button type="button" variant="ghost" onClick={cancelQueue} className="rounded-xl px-2" title="Clear selection"><X className="h-4 w-4" /></Button>
                  )}
                </div>
              </div>

              <Button onClick={startReading} disabled={reading || queue.files.length === 0} className="w-full rounded-xl text-white mt-auto" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
                {reading ? <span className="inline-flex items-center gap-2"><MiniLoader height={18} /> Reading the bill…</span> : <><Eye className="h-4 w-4 mr-2" /> Read & preview</>}
              </Button>
            </div>
          </div>

          <div className={`${card} p-5 flex flex-col`}>
            <div className="flex items-center gap-3 mb-4">
              <div className="h-10 w-10 rounded-xl flex items-center justify-center text-white" style={{ background: `linear-gradient(135deg, ${COLORS.emeraldGreen}, #0F5C63)` }}>
                <FileSpreadsheet className="h-5 w-5" />
              </div>
              <div>
                <h2 className={`font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Import GSTR-2B report</h2>
                <p className="text-xs text-slate-400">Bulk-add every B2B bill from a portal Excel, PDF, or a zipped batch of months.</p>
              </div>
            </div>
            <div className="space-y-3 flex-1 flex flex-col">
              <div>
                <label className={miniLabel}>Company/book (Master Data)</label>
                <div className="mt-1.5">
                  <SearchableSelect options={companyOpts} value={gstr2bCompanyId} onChange={setGstr2bCompanyId} isDark={isDark}
                    placeholder="Select company…" emptyText="No company in Master Data" loading={mastersState.loading} />
                </div>
              </div>
              <MastersNotice state={mastersState} count={companyOpts.length} onRetry={loadMasters} compact />

              <div className={`border-2 border-dashed rounded-2xl p-4 flex items-center gap-4 ${isDark ? 'border-slate-700 bg-slate-900/60' : 'border-emerald-100 bg-emerald-50/60'}`}>
                <input ref={gstr2bFileRef} type="file" accept=".xlsx,.xls,.pdf,.zip" className="hidden" onChange={(e) => setGstr2bFile(e.target.files?.[0] || null)} />
                <FileSpreadsheet className="h-9 w-9 flex-shrink-0" style={{ color: COLORS.emeraldGreen }} />
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-semibold truncate ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{gstr2bFile ? gstr2bFile.name : 'Choose GSTR-2B file — Excel, PDF, or ZIP'}</p>
                  <p className="text-[11px] text-slate-400 truncate">{gstr2bFile ? `${(gstr2bFile.size / 1024).toFixed(0)} KB` : '.xlsx, .xls, .pdf or a .zip of several monthly exports'}</p>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <Button type="button" variant="outline" onClick={() => gstr2bFileRef.current?.click()} className="rounded-xl">Browse</Button>
                  {gstr2bFile && (
                    <Button type="button" variant="ghost" onClick={() => { setGstr2bFile(null); if (gstr2bFileRef.current) gstr2bFileRef.current.value = ''; }} className="rounded-xl px-2" title="Clear file"><X className="h-4 w-4" /></Button>
                  )}
                </div>
              </div>

              <Button onClick={handleGstr2bUpload} disabled={gstr2bUploading || !gstr2bFile} className="w-full rounded-xl text-white mt-auto" style={{ background: `linear-gradient(135deg, ${COLORS.emeraldGreen}, #0F5C63)` }}>
                {gstr2bUploading ? <MiniLoader height={18} /> : <><Database className="h-4 w-4 mr-2" /> Import into Purchase Book</>}
              </Button>
              {gstr2bResult && (
                <div className={`rounded-2xl border p-3 text-xs grid grid-cols-2 gap-x-6 gap-y-1 ${isDark ? 'bg-slate-900/60 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                  {gstr2bResult.files_processed > 1 && <div className="flex justify-between"><span>Files combined</span><span className="font-semibold">{gstr2bResult.files_processed}</span></div>}
                  <div className="flex justify-between"><span>Bills added</span><span className="font-bold text-emerald-500">{gstr2bResult.created}</span></div>
                  <div className="flex justify-between"><span>Already in book</span><span className="font-semibold">{gstr2bResult.duplicates}</span></div>
                  <div className="flex justify-between"><span>ITC not eligible</span><span className="font-semibold">{gstr2bResult.ineligible_itc}</span></div>
                  <div className="flex justify-between col-span-2"><span>Total value imported</span><span className="font-semibold">{fmtC(gstr2bResult.total_value)}</span></div>
                </div>
              )}
            </div>
          </div>
        </div>

          {/* ── right: the register ── */}
          <div className={`${card} overflow-hidden min-w-0`}>
            {/* toolbar */}
            <div className="p-4 border-b space-y-3" style={{ borderColor: border }}>
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                <div>
                  <h2 className={`font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Purchase register</h2>
                  <p className="text-xs text-slate-400">{total} bill{total === 1 ? '' : 's'}{filterCount ? ' match the filters' : ''} · {facets.suppliers.length} suppliers</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className={`flex items-center gap-2 rounded-xl border px-3 h-9 min-w-[220px] ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                    <Search className="h-4 w-4 text-slate-400" />
                    <Input value={filters.search} onChange={(e) => setFilter({ search: e.target.value })} placeholder="Search supplier, bill no., GSTIN…" className="border-0 bg-transparent h-8 px-0 focus-visible:ring-0" />
                    {filters.search && <button type="button" onClick={() => setFilter({ search: '' })} className="text-slate-400 hover:text-slate-600"><X className="h-3.5 w-3.5" /></button>}
                  </div>
                  <Button variant="outline" onClick={() => setShowFilters((v) => !v)} className={`rounded-xl h-9 ${showFilters ? 'border-blue-500 text-blue-600' : ''}`}>
                    <SlidersHorizontal className="h-4 w-4 mr-1.5" /> Filters
                    {filterCount > 0 && <span className="ml-1.5 text-[10px] font-bold px-1.5 rounded-full bg-blue-600 text-white">{filterCount}</span>}
                  </Button>
                  <div className="flex items-center gap-1">
                    <Select value={sortBy} onValueChange={(v) => { setSortBy(v); setPage(1); }}>
                      <SelectTrigger className={`w-[150px] ${fieldCls}`}><SelectValue /></SelectTrigger>
                      <SelectContent>{SORT_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>Sort: {o.label}</SelectItem>)}</SelectContent>
                    </Select>
                    <Button variant="outline" size="icon" className="h-9 w-9 rounded-xl" onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))} title={sortDir === 'asc' ? 'Ascending (A→Z, oldest first)' : 'Descending (Z→A, newest first)'}>
                      {sortDir === 'asc' ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
                    </Button>
                  </div>
                  <div className="flex rounded-xl border overflow-hidden h-9" style={{ borderColor: border }}>
                    <button type="button" onClick={() => setView('table')} className={`px-2.5 ${view === 'table' ? 'bg-blue-600 text-white' : 'text-slate-500'}`} title="Table view"><Table2 className="h-4 w-4" /></button>
                    <button type="button" onClick={() => setView('cards')} className={`px-2.5 ${view === 'cards' ? 'bg-blue-600 text-white' : 'text-slate-500'}`} title="Card view"><LayoutList className="h-4 w-4" /></button>
                  </div>
                </div>
              </div>

              {showFilters && (
                <div className={`rounded-2xl border p-4 space-y-4 ${isDark ? 'bg-slate-900/50 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div>
                      <label className={miniLabel}>Company</label>
                      <div className="mt-1">
                        <SearchableSelect options={[{ value: 'all', label: 'All companies' }, ...companyOpts]} value={filters.company_id} onChange={(v) => setFilter({ company_id: v })} isDark={isDark} />
                      </div>
                    </div>
                    <div>
                      <label className={miniLabel}>Client</label>
                      <div className="mt-1">
                        <SearchableSelect options={[{ value: 'all', label: 'All clients' }, ...clientOpts]} value={filters.client_id} onChange={(v) => setFilter({ client_id: v })} isDark={isDark} />
                      </div>
                    </div>
                    <div>
                      <label className={miniLabel}>Supplier</label>
                      <div className="mt-1">
                        <SearchableSelect
                          options={[{ value: 'all', label: 'All suppliers' }, ...facets.suppliers.map((s) => ({ value: s.name, label: s.name, sublabel: `${s.count} bill${s.count === 1 ? '' : 's'}${s.gstin ? ` · ${s.gstin}` : ''}` }))]}
                          value={filters.supplier} onChange={(v) => setFilter({ supplier: v })} isDark={isDark} />
                      </div>
                    </div>
                    <div>
                      <label className={miniLabel}>Expense head</label>
                      <div className="mt-1">
                        <SearchableSelect
                          options={[{ value: 'all', label: 'All heads' }, ...facets.ledgers.map((l) => ({ value: l.name, label: l.name, sublabel: `${l.count}` }))]}
                          value={filters.ledger} onChange={(v) => setFilter({ ledger: v })} isDark={isDark} />
                      </div>
                    </div>
                  </div>

                  <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div>
                      <label className={miniLabel}>Invoice date from</label>
                      <Input type="date" value={filters.date_from} onChange={(e) => setFilter({ date_from: e.target.value })} className={`mt-1 ${fieldCls}`} />
                    </div>
                    <div>
                      <label className={miniLabel}>Invoice date to</label>
                      <Input type="date" value={filters.date_to} onChange={(e) => setFilter({ date_to: e.target.value })} className={`mt-1 ${fieldCls}`} />
                    </div>
                    <div>
                      <label className={miniLabel}>Total from (₹)</label>
                      <Input type="number" inputMode="decimal" value={filters.amount_min} onChange={(e) => setFilter({ amount_min: e.target.value })} className={`mt-1 ${fieldCls}`} placeholder="0" />
                    </div>
                    <div>
                      <label className={miniLabel}>Total to (₹)</label>
                      <Input type="number" inputMode="decimal" value={filters.amount_max} onChange={(e) => setFilter({ amount_max: e.target.value })} className={`mt-1 ${fieldCls}`} placeholder="any" />
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {presets.map((p) => (
                      <button key={p.key} type="button" onClick={() => setFilter({ date_from: p.from, date_to: p.to })}
                        className={`text-xs px-2.5 py-1 rounded-full border ${filters.date_from === p.from && filters.date_to === p.to ? 'bg-blue-600 text-white border-blue-600' : isDark ? 'border-slate-600 text-slate-300' : 'border-slate-300 text-slate-600 bg-white'}`}>
                        {p.label}
                      </button>
                    ))}
                    {(filters.date_from || filters.date_to) && (
                      <button type="button" onClick={() => setFilter({ date_from: '', date_to: '' })} className="text-xs px-2.5 py-1 text-slate-500 underline">any date</button>
                    )}
                  </div>

                  <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    {selectFilter('source', 'Source', SOURCE_OPTIONS)}
                    {selectFilter('tally', 'Tally', [{ value: 'all', label: 'Any' }, { value: 'pending', label: 'Not yet exported' }, { value: 'exported', label: 'Exported to Tally' }])}
                    {selectFilter('review', 'Review', [{ value: 'all', label: 'Any' }, { value: 'yes', label: 'Needs review only' }])}
                    {selectFilter('gst_type', 'GST type', [{ value: 'all', label: 'Any' }, { value: 'cgst_sgst', label: 'CGST + SGST (same state)' }, { value: 'igst', label: 'IGST (other state)' }, { value: 'none', label: 'No GST' }])}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className={miniLabel}>Status</span>
                    {STATUS_CHIPS.map((st) => {
                      const on = filters.status.includes(st);
                      const sm = PURCHASE_STATUS_META[st];
                      return (
                        <button key={st} type="button"
                          onClick={() => setFilter({ status: on ? filters.status.filter((x) => x !== st) : [...filters.status, st] })}
                          className="text-xs px-2.5 py-1 rounded-full border font-semibold"
                          style={on ? { background: sm.bg, color: sm.fg, borderColor: sm.fg } : { borderColor: sm.border, color: '#64748b' }}>
                          {on && <CheckCircle2 className="inline h-3 w-3 mr-1" />}{sm.label}
                        </button>
                      );
                    })}
                    <div className="flex-1" />
                    <Button variant="ghost" size="sm" onClick={clearFilters} disabled={!filterCount} className="text-xs">Clear all filters</Button>
                  </div>
                </div>
              )}

              {/* active filter chips */}
              {filterCount > 0 && !showFilters && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  {Object.entries(buildPurchaseParams(activeFilters)).map(([k, v]) => (
                    <span key={k} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                      {k.replace('_', ' ')}: <b>{k === 'company_id' ? (companies.find((c) => c.id === v)?.name || v) : k === 'client_id' ? (clients.find((c) => c.id === v)?.company_name || v) : String(v)}</b>
                    </span>
                  ))}
                  <button type="button" onClick={clearFilters} className="text-slate-500 underline ml-1">clear</button>
                </div>
              )}

              {/* totals for what is on screen */}
              <div className={`grid grid-cols-2 md:grid-cols-5 gap-2 text-xs rounded-xl p-2.5 ${isDark ? 'bg-slate-900/60' : 'bg-slate-50'}`}>
                {[
                  ['Taxable', totals.taxable], ['GST', totals.gst], ['Invoice total', totals.total], ['Paid', totals.paid], ['Balance due', totals.due],
                ].map(([l, v]) => (
                  <div key={l}><p className={miniLabel}>{l}</p><p className={`font-bold tabular-nums ${l === 'Balance due' && v > 0 ? 'text-rose-500' : isDark ? 'text-slate-100' : 'text-slate-800'}`}>{fmtC(v)}</p></div>
                ))}
              </div>

              {selected.size > 0 && (
                <div className="flex flex-wrap items-center gap-3 rounded-xl px-3 py-2 bg-blue-50 border border-blue-200 text-sm text-blue-800">
                  <b>{selected.size}</b> selected
                  <Button size="sm" className="h-7 rounded-lg text-white" style={{ background: COLORS.mediumBlue }} onClick={() => setExportOpen(true)}>
                    <FileCode2 className="h-3.5 w-3.5 mr-1" /> Export / Tally
                  </Button>
                  <button type="button" className="underline" onClick={() => setSelected(new Set())}>clear selection</button>
                </div>
              )}
            </div>

            {/* rows */}
            <div className={listLoading ? 'opacity-60 transition-opacity' : ''}>
              {rows.length === 0 && !listLoading ? (
                <div className="py-20 text-center">
                  <FileText className="h-12 w-12 mx-auto text-slate-300 mb-3" />
                  <p className="text-sm font-semibold text-slate-400">{filterCount ? 'No bills match these filters' : 'No purchase invoices found'}</p>
                  <p className="text-xs text-slate-400 mt-1">{filterCount ? 'Try clearing a filter.' : 'Upload an invoice to start the purchase register.'}</p>
                  {filterCount > 0 && <Button variant="outline" size="sm" className="mt-3 rounded-xl" onClick={clearFilters}>Clear filters</Button>}
                </div>
              ) : view === 'table' ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm table-fixed min-w-[1240px]">
                    <colgroup>
                      <col style={{ width: 40 }} />
                      <col style={{ width: 98 }} />
                      <col style={{ width: 150 }} />
                      <col />
                      <col style={{ width: 190 }} />
                      <col style={{ width: 104 }} />
                      <col style={{ width: 94 }} />
                      <col style={{ width: 114 }} />
                      <col style={{ width: 104 }} />
                      <col style={{ width: 140 }} />
                      <col style={{ width: 138 }} />
                    </colgroup>
                    <thead className={isDark ? 'bg-slate-900/60' : 'bg-slate-50'}>
                      <tr className="text-left">
                        <th className="px-3 py-2.5"><input type="checkbox" checked={allOnPage} onChange={togglePage} aria-label="Select all on this page" /></th>
                        <SortHead field="invoice_date">Date</SortHead>
                        <SortHead field="invoice_no">Bill no.</SortHead>
                        <SortHead field="supplier_name">Supplier</SortHead>
                        <th className="px-3 py-2.5 font-semibold text-[11px] uppercase tracking-wider text-slate-400">Company</th>
                        <SortHead field="taxable_amount" className="text-right">Taxable</SortHead>
                        <SortHead field="total_gst" className="text-right">GST</SortHead>
                        <SortHead field="grand_total" className="text-right">Total</SortHead>
                        <SortHead field="amount_due" className="text-right">Due</SortHead>
                        <SortHead field="status">Status</SortHead>
                        <th className="px-3 py-2.5 font-semibold text-[11px] uppercase tracking-wider text-slate-400 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y" style={{ borderColor: border }}>
                      {rows.map((inv) => (
                        <tr key={inv.id} className={`align-middle ${selected.has(inv.id) ? (isDark ? 'bg-blue-950/30' : 'bg-blue-50/60') : ''} ${isDark ? 'hover:bg-slate-700/50' : 'hover:bg-slate-50'}`}>
                          <td className="px-3 py-2.5"><input type="checkbox" checked={selected.has(inv.id)} onChange={() => toggleRow(inv.id)} aria-label={`Select ${inv.invoice_no}`} /></td>
                          <td className="px-3 py-2.5 whitespace-nowrap text-slate-500">{fmtDate(inv.invoice_date)}</td>
                          <td className="px-3 py-2.5 overflow-hidden">
                            <p className="font-semibold truncate" title={inv.invoice_no || ''}>{inv.invoice_no || '—'}</p>
                            {inv.needs_amount_review && (
                              <span title="The figures on this bill don't add up — open Edit to correct them" className="inline-block mt-0.5 text-[10px] font-bold px-1.5 py-px rounded bg-rose-50 text-rose-700 border border-rose-200">Verify amounts</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 overflow-hidden">
                            <p className="truncate font-medium" title={inv.supplier_name || ''}>{inv.supplier_name || 'Unknown supplier'}</p>
                            {inv.supplier_gstin && <p className="text-[11px] text-slate-400 font-mono truncate">{inv.supplier_gstin}</p>}
                          </td>
                          <td className="px-3 py-2.5 overflow-hidden">
                            <p className="truncate text-slate-500" title={inv.company_name || ''}>{inv.company_name || <span className="text-amber-600">Not set</span>}</p>
                            {inv.client_name && <p className="text-[11px] text-slate-400 truncate" title={inv.client_name}>{inv.client_name}</p>}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{fmtC(inv.taxable_amount)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{fmtC(inv.total_gst)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-bold">{fmtC(inv.grand_total)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{inv.status !== 'cancelled' && Number(inv.amount_due) > 0 ? <span style={{ color: COLORS.coral }} className="font-semibold">{fmtC(inv.amount_due)}</span> : <span className="text-slate-300">—</span>}</td>
                          <td className="px-3 py-2.5"><div className="flex items-center gap-1 flex-wrap"><StatusBadge status={inv.status} inv={inv} /><TallyBadge inv={inv} /></div></td>
                          <td className="px-3 py-2.5"><RowActions inv={inv} compact /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="divide-y" style={{ borderColor: border }}>
                  {rows.map((inv) => (
                    <div key={inv.id} className={`p-4 transition ${isDark ? 'hover:bg-slate-700/60' : 'hover:bg-slate-50'}`}>
                      <div className="flex items-start gap-3">
                        <input type="checkbox" className="mt-1.5" checked={selected.has(inv.id)} onChange={() => toggleRow(inv.id)} aria-label={`Select ${inv.invoice_no}`} />
                        <div className="flex items-start justify-between gap-4 flex-1 min-w-0">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className={`font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{inv.invoice_no || 'No invoice no.'}</p>
                              {!inv.company_id && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">No company</span>}
                              {inv.needs_amount_review && (
                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200" title="The figures on this bill don't add up — open Edit to correct them">Verify amount</span>
                              )}
                              <StatusBadge status={inv.status} inv={inv} />
                              <TallyBadge inv={inv} />
                            </div>
                            <p className="text-sm text-slate-500 mt-1 truncate">{inv.supplier_name || 'Unknown supplier'} {inv.supplier_gstin ? `· ${inv.supplier_gstin}` : ''}</p>
                            <p className="text-xs text-slate-400 mt-1 flex items-center gap-1.5">
                              <Building2 className="h-3.5 w-3.5" /> {inv.company_name || inv.client_name || inv.buyer_name || 'No company set'} · {fmtDate(inv.invoice_date)}
                            </p>
                          </div>
                          <div className="text-right flex-shrink-0 flex flex-col items-end">
                            <p className={`text-lg font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{fmtC(inv.grand_total)}</p>
                            <p className="text-xs text-slate-400">GST {fmtC(inv.total_gst)}</p>
                            {inv.status !== 'cancelled' && Number(inv.amount_due) > 0 && <p className="text-xs font-semibold" style={{ color: COLORS.coral }}>Due {fmtC(inv.amount_due)}</p>}
                            <p className="text-[10px] text-slate-400 mt-1 truncate max-w-[180px]">{inv.file_name}</p>
                            <div className="mt-2"><RowActions inv={inv} /></div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* pagination */}
            <div className="p-3 border-t flex flex-wrap items-center justify-between gap-3 text-sm" style={{ borderColor: border }}>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                Rows per page
                <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPage(1); }}>
                  <SelectTrigger className={`w-[80px] ${fieldCls}`}><SelectValue /></SelectTrigger>
                  <SelectContent>{PAGE_SIZES.map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Page {page} of {pages} · {total} bills</span>
                <Button variant="outline" size="icon" className="h-8 w-8 rounded-lg" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>
                <Button variant="outline" size="icon" className="h-8 w-8 rounded-lg" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}><ChevronRight className="h-4 w-4" /></Button>
              </div>
            </div>
          </div>
      </div>

      {/* ── editable preview (after reading, before adding) ── */}
      {preview && (
        <InvoicePreviewDialog
          open
          preview={preview.data}
          file={preview.file}
          queue={queue.files.length > 0 ? { index: queue.index, total: queue.files.length } : null}
          companies={companies}
          clients={clients}
          isDark={isDark}
          onClose={cancelQueue}
          onSkip={nextInQueue}
          onSaved={nextInQueue}
        />
      )}

      <ExportDialog
        open={exportOpen}
        onClose={() => { setExportOpen(false); refresh(); }}
        isDark={isDark}
        selectedIds={Array.from(selected)}
        filters={activeFilters}
        matchingCount={total}
        sortBy={sortBy}
        sortDir={sortDir}
      />

      {/* ── edit ── */}
      <Dialog open={editingInvoice !== null} onOpenChange={(open) => { if (!open) setEditingInvoice(null); }}>
        <DialogContent className={`sm:max-w-3xl max-h-[92vh] overflow-y-auto ${isDark ? 'bg-slate-900 text-slate-100 border-slate-800' : 'bg-white text-slate-900'}`}>
          <DialogHeader>
            <DialogTitle className="text-xl font-bold flex items-center gap-2">
              <ShoppingBag className="h-5 w-5 text-blue-500" /> Edit Purchase Invoice
            </DialogTitle>
          </DialogHeader>
          {editingInvoice && (
            <>
              {editIssues.length > 0 && (
                <ul className={`rounded-xl border p-3 text-xs space-y-1 ${editBlockers.length ? 'border-red-300 bg-red-50 text-red-800' : 'border-amber-300 bg-amber-50 text-amber-800'}`}>
                  {editIssues.map((i, idx) => <li key={idx}>• {i.message}</li>)}
                </ul>
              )}
              <InvoiceForm
                form={editForm}
                onChange={(patch) => setEditForm((f) => ({ ...f, ...patch }))}
                companies={companies}
                clients={clients}
                issues={editIssues}
                original={editOriginal}
                showCurrency={false}
                isDark={isDark}
                onSwapParties={swapEditParties}
              />
              {editHasMismatch && (
                <label className="inline-flex items-center gap-2 text-xs text-amber-700">
                  <input type="checkbox" checked={editAck} onChange={(e) => setEditAck(e.target.checked)} />
                  I checked the document — the bill really adds up differently
                </label>
              )}
              <div className="flex justify-end gap-2 pt-4 border-t" style={{ borderColor: border }}>
                <Button variant="outline" onClick={() => setEditingInvoice(null)} className="rounded-xl">Cancel</Button>
                {canEditPurchase && <Button onClick={() => handleSaveEdit(false)} disabled={savingEdit || editBlockers.length > 0 || (editHasMismatch && !editAck)} className="rounded-xl text-white" style={{ background: COLORS.mediumBlue }}>
                  {savingEdit ? <MiniLoader height={18} /> : 'Save Changes'}
                </Button>}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── payment ── */}
      <Dialog open={payingInvoice !== null} onOpenChange={(open) => { if (!open) setPayingInvoice(null); }}>
        <DialogContent className={`sm:max-w-md ${isDark ? 'bg-slate-900 text-slate-100 border-slate-800' : 'bg-white text-slate-900'}`}>
          <DialogHeader>
            <DialogTitle className="text-xl font-bold flex items-center gap-2"><Wallet className="h-5 w-5 text-emerald-500" /> Record Payment</DialogTitle>
          </DialogHeader>
          {payingInvoice && (
            <div className="space-y-4 my-2">
              <div className={`rounded-xl p-3 text-sm ${isDark ? 'bg-slate-800' : 'bg-slate-50'}`}>
                <p className="font-semibold">{payingInvoice.invoice_no || 'No invoice no.'} — {payingInvoice.supplier_name}</p>
                <p className="text-slate-400 text-xs mt-1">Bill total {fmtC(payingInvoice.grand_total)} · Due {fmtC(payingInvoice.amount_due ?? payingInvoice.grand_total)}</p>
              </div>
              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Amount Paid (₹)</label>
                <Input type="number" step="0.01" value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} className="mt-1 rounded-xl" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Payment Date</label>
                  <Input type="date" value={payForm.payment_date} onChange={(e) => setPayForm({ ...payForm, payment_date: e.target.value })} className="mt-1 rounded-xl" />
                </div>
                <div>
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Mode</label>
                  <Select value={payForm.payment_mode} onValueChange={(v) => setPayForm({ ...payForm, payment_mode: v })}>
                    <SelectTrigger className={`mt-1 rounded-xl ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50'}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bank">Bank / NEFT / UPI</SelectItem>
                      <SelectItem value="cash">Cash</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {payForm.payment_mode !== 'cash' && bankAccounts.length > 0 && (
                <div>
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Bank Account</label>
                  <Select value={payForm.bank_account_id} onValueChange={(v) => setPayForm({ ...payForm, bank_account_id: v })}>
                    <SelectTrigger className={`mt-1 rounded-xl ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50'}`}><SelectValue placeholder="Select bank account" /></SelectTrigger>
                    <SelectContent>
                      {bankAccounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.bank_name} · {a.account_number_masked}{a.is_primary ? ' (Primary)' : ''}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-slate-400">Reference No. (optional)</label>
                <Input value={payForm.reference_no} onChange={(e) => setPayForm({ ...payForm, reference_no: e.target.value })} className="mt-1 rounded-xl" placeholder="UTR / cheque no." />
              </div>
              <p className="text-xs text-slate-400">This posts a ledger entry — Dr Accounts Payable, Cr {payForm.payment_mode === 'cash' ? 'Cash in Hand' : 'Bank Accounts'}.</p>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-4 border-t" style={{ borderColor: border }}>
            <Button variant="outline" onClick={() => setPayingInvoice(null)} className="rounded-xl">Cancel</Button>
            <Button onClick={handleSavePayment} disabled={savingPayment} className="rounded-xl text-white" style={{ background: COLORS.emeraldGreen }}>
              {savingPayment ? <MiniLoader height={18} /> : 'Save Payment'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default Purchase;
