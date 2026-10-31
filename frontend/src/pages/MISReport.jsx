import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  FileBarChart2, Plus, Upload, X, Loader2, TrendingUp, TrendingDown, Wallet,
  Landmark, ArrowLeftRight, ScrollText, ReceiptText, CheckCircle2, AlertTriangle,
  Clock, ChevronDown, Trash2, Save, Building2, Users, FileSpreadsheet, FileText,
  RefreshCw, Info, Banknote, Target, Download,
} from 'lucide-react';
import { PopupHeader } from '@/components/ui/popup-header';
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import { toast } from 'sonner';
import { getJsPDF, getAutoTable, getXLSX } from '@/lib/lazyLibs';
import { saveAs } from 'file-saver';
import api from '@/lib/api';
import useDark from '@/hooks/useDark';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { HubBanner, HUB_COLORS } from '@/components/SectionHub.jsx';

const fmt = (n) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n || 0);
const PALETTE = ['#1F6FB2', '#1FAF5A', '#F59E0B', '#7C3AED', '#EF4444', '#0EA5E9', '#EC4899', '#14B8A6'];

const DOC_TYPES = [
  { key: 'sales', label: 'Sales Register', icon: ReceiptText, hint: 'PDF, Excel, CSV, ZIP — invoice-wise sales with party name, amount, due date, status' },
  { key: 'purchase', label: 'Purchase Register', icon: FileSpreadsheet, hint: 'PDF, Excel, CSV, ZIP — vendor bills with amount, due date, status' },
  { key: 'bank_statement', label: 'Bank Statement', icon: Landmark, hint: 'PDF, Excel, CSV — Date, Narration, Debit, Credit, Balance' },
  { key: 'balance_sheet', label: 'Provisional Balance Sheet', icon: FileText, hint: 'PDF, Excel, Word — cash, debtors, creditors, revenue (auto-filled into Manual Entry)' },
  { key: 'gst_report', label: 'GST Reports (GSTR-2B/3B)', icon: ScrollText, hint: 'PDF, Excel, CSV, ZIP — GST portal export or invoice-level register' },
];

const TABS = [
  { key: 'dashboard', label: 'Financial Dashboard', icon: FileBarChart2 },
  { key: 'receivables', label: 'Receivables MIS', icon: TrendingUp },
  { key: 'payables', label: 'Payables MIS', icon: TrendingDown },
  { key: 'revenue', label: 'Revenue MIS', icon: Banknote },
  { key: 'expense', label: 'Expense MIS', icon: Wallet },
  { key: 'profitability', label: 'Profitability MIS', icon: Target },
];

function currentFYLabel() {
  const now = new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `FY${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

/* ─────────────────────────────────────────────────────────────────────── */

function Card({ children, isDark, className = '' }) {
  return (
    <div className={`rounded-2xl border p-5 ${isDark ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200'} ${className}`}>
      {children}
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, isDark, color = HUB_COLORS.mediumBlue, sub }) {
  return (
    <div className={`rounded-2xl border p-4 ${isDark ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200'}`}>
      <div className="flex items-center gap-2 mb-2">
        <div className="p-1.5 rounded-lg" style={{ background: `${color}1A` }}>
          <Icon className="h-4 w-4" style={{ color }} />
        </div>
        <p className={`text-[11px] font-bold uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</p>
      </div>
      <p className={`text-xl font-extrabold ${isDark ? 'text-white' : 'text-slate-900'}`}>{value}</p>
      {sub && <p className={`text-xs mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{sub}</p>}
    </div>
  );
}

function SimpleBarChart({ data, isDark, dataKey = 'value', color = HUB_COLORS.mediumBlue, height = 240 }) {
  if (!data?.length) return <EmptyState isDark={isDark} text="No data for this period yet." />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#1e293b' : '#e2e8f0'} />
        <XAxis dataKey="name" tick={{ fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b' }} interval={0} angle={-20} textAnchor="end" height={60} />
        <YAxis tick={{ fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b' }} />
        <Tooltip formatter={(v) => `₹${fmt(v)}`} contentStyle={{ background: isDark ? '#0f172a' : '#fff', border: '1px solid #334155', borderRadius: 8 }} />
        <Bar dataKey={dataKey} fill={color} radius={[6, 6, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function SimplePie({ data, isDark, height = 240 }) {
  if (!data?.length) return <EmptyState isDark={isDark} text="No data for this period yet." />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={85} label={(e) => `${e.name}`}>
          {data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
        </Pie>
        <Tooltip formatter={(v) => `₹${fmt(v)}`} contentStyle={{ background: isDark ? '#0f172a' : '#fff', border: '1px solid #334155', borderRadius: 8 }} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function EmptyState({ isDark, text }) {
  return (
    <div className={`flex flex-col items-center justify-center py-10 text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
      <Info className="h-6 w-6 mb-2 opacity-60" />
      {text}
    </div>
  );
}

function toChartData(obj) {
  if (!obj) return [];
  return Object.entries(obj).map(([name, value]) => ({ name, value: Number(value) || 0 })).filter((d) => d.value !== 0);
}

function SectionTitle({ children, isDark }) {
  return <h3 className={`text-sm font-extrabold uppercase tracking-wide mb-3 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{children}</h3>;
}

function DataTable({ columns, rows, isDark, emptyText = 'No records.' }) {
  if (!rows?.length) return <EmptyState isDark={isDark} text={emptyText} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className={`text-left border-b ${isDark ? 'border-slate-800 text-slate-400' : 'border-slate-200 text-slate-500'}`}>
            {columns.map((c) => <th key={c.key} className="py-2 pr-4 font-semibold whitespace-nowrap">{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={`border-b last:border-0 ${isDark ? 'border-slate-800/60 text-slate-200' : 'border-slate-100 text-slate-700'}`}>
              {columns.map((c) => (
                <td key={c.key} className="py-2 pr-4 whitespace-nowrap">{c.render ? c.render(r) : r[c.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ═══════════════════════════ EXPORT (PDF / WORD / EXCEL) ═══════════════════════════ */

const EXPENSE_CATS = [
  ['rent', 'Rent'], ['employee_expenses', 'Employee Expenses'], ['travel_expenses', 'Travel Expenses'],
  ['office_expenses', 'Office Expenses'], ['software_subscription_cost', 'Software Subscription'],
  ['utility_expenses', 'Utility Expenses'], ['marketing_expenses', 'Marketing Expenses'],
  ['administrative_expenses', 'Administrative Expenses'],
];

/** Flattens whichever tab's report data is currently loaded into a
 *  { title, tabLabel, metrics: [[label, value]], tables: [{ title, columns, rows }] }
 *  shape that all three exporters (PDF / Word / Excel) consume. */
function buildMISExportData(tab, data, clientName, period) {
  if (!data) return null;
  const tabMeta = TABS.find((t) => t.key === tab);
  const tabLabel = tabMeta?.label || 'MIS Report';
  const metrics = [];
  const tables = [];

  const chartTable = (obj, label) => {
    const rows = toChartData(obj);
    if (rows.length) tables.push({ title: label, columns: ['Name', 'Amount (₹)'], rows: rows.map((r) => [r.name, fmt(r.value)]) });
  };

  const dataTable = (label, rows, columns, emptyOk = false) => {
    if (rows?.length || emptyOk) {
      tables.push({
        title: label,
        columns: columns.map((c) => c.label),
        rows: (rows || []).map((r) => columns.map((c) => String(c.render ? c.render(r) : (r[c.key] ?? '')))),
      });
    }
  };

  if (tab === 'dashboard') {
    metrics.push(
      ['Total Revenue', `₹${fmt(data.total_revenue)}`],
      ['Total Expenses', `₹${fmt(data.total_expenses)}`],
      ['Gross Profit', `₹${fmt(data.gross_profit)}`],
      ['Net Profit', `₹${fmt(data.net_profit)}`],
      ['EBITDA', `₹${fmt(data.ebitda)}`],
      ['Cash & Bank Balance', `₹${fmt(data.cash_and_bank_balance)}`],
      ['Accounts Receivable', `₹${fmt(data.accounts_receivable)}`],
      ['Accounts Payable', `₹${fmt(data.accounts_payable)}`],
      ['Working Capital', `₹${fmt(data.working_capital)}`],
      ['Cash Flow Position', `₹${fmt(data.cash_flow_position)} (In ₹${fmt(data.cash_in)} · Out ₹${fmt(data.cash_out)})`],
      ['Revenue Growth %', data.revenue_growth_pct == null ? 'N/A' : `${data.revenue_growth_pct}%`],
    );
    dataTable('Budget vs Actual', data.budget_vs_actual, [
      { key: 'category', label: 'Category', render: (r) => String(r.category || '').replace(/_/g, ' ') },
      { key: 'budget', label: 'Budget', render: (r) => `₹${fmt(r.budget)}` },
      { key: 'actual', label: 'Actual', render: (r) => `₹${fmt(r.actual)}` },
      { key: 'variance', label: 'Variance', render: (r) => `₹${fmt(r.variance)}` },
    ]);
  } else if (tab === 'receivables') {
    const s = data.outstanding_summary || {};
    metrics.push(
      ['Total Outstanding', `₹${fmt(data.total_outstanding)}`],
      ['Collection Efficiency', `${data.collection_reports?.collection_efficiency_pct ?? 0}%`],
      ['Expected Collections', `₹${fmt(data.collection_reports?.expected_collections)}`],
      ['Overdue Total', `₹${fmt(data.collection_reports?.overdue_total)}`],
      ['Bad Debts Total', `₹${fmt(data.collection_reports?.bad_debts_total)}`],
      ['Interest on Delayed Payments', `₹${fmt(data.collection_reports?.interest_on_delayed_payments)}`],
    );
    chartTable(data.ageing_analysis, 'Ageing Analysis');
    chartTable(s.client_wise, 'Client-wise Outstanding');
    chartTable(s.branch_wise, 'Branch-wise Outstanding');
    chartTable(s.partner_wise, 'Partner-wise Outstanding');
    dataTable('Invoice-wise Outstanding', s.invoice_wise, [
      { key: 'invoice_no', label: 'Invoice #' }, { key: 'party_name', label: 'Party' },
      { key: 'due_date', label: 'Due Date' }, { key: 'status', label: 'Status' },
      { key: 'outstanding', label: 'Outstanding', render: (r) => `₹${fmt(r.outstanding)}` },
    ]);
    chartTable(data.collection_reports?.monthly_collections, 'Monthly Collections');
    dataTable('Overdue Invoices', data.collection_reports?.overdue_invoices, [
      { key: 'invoice_no', label: 'Invoice #' }, { key: 'party_name', label: 'Party' },
      { key: 'due_date', label: 'Due Date' }, { key: 'outstanding', label: 'Outstanding', render: (r) => `₹${fmt(r.outstanding)}` },
    ]);
  } else if (tab === 'payables') {
    metrics.push(
      ['Total Payable', `₹${fmt(data.total_payable)}`],
      ['Advances to Vendors', `₹${fmt((data.advances_to_vendors || []).reduce((s, a) => s + (a.amount || 0), 0))}`],
      ['Security Deposits', `₹${fmt((data.security_deposits || []).reduce((s, a) => s + (a.amount || 0), 0))}`],
    );
    chartTable(data.ageing_analysis, 'Ageing Analysis');
    chartTable(data.vendor_wise_payables, 'Vendor-wise Payables');
    chartTable(data.expense_category_wise_payables, 'Expense Category-wise Payables');
    chartTable(data.monthly_payment_summary, 'Monthly Payment Summary');
    dataTable('Due Payments (Upcoming)', data.due_payments, [
      { key: 'invoice_no', label: 'Bill #' }, { key: 'party_name', label: 'Vendor' },
      { key: 'due_date', label: 'Due Date' }, { key: 'outstanding', label: 'Amount', render: (r) => `₹${fmt(r.outstanding)}` },
    ]);
  } else if (tab === 'revenue') {
    metrics.push(
      ['Total Revenue', `₹${fmt(data.total_revenue)}`],
      ['Repeat Client Revenue', `₹${fmt(data.repeat_client_revenue)}`],
      ['New Client Revenue', `₹${fmt(data.new_client_revenue)}`],
    );
    chartTable(data.monthly_revenue_trend, 'Monthly Revenue Trend');
    chartTable(data.daily_revenue, 'Daily Revenue');
    chartTable(data.service_wise_revenue, 'Service-wise Revenue');
    chartTable(data.client_wise_revenue, 'Client-wise Revenue');
    chartTable(data.branch_wise_revenue, 'Branch-wise Revenue');
    chartTable(data.partner_wise_revenue, 'Partner-wise Revenue');
    chartTable(data.employee_wise_billing, 'Employee-wise Billing');
  } else if (tab === 'expense') {
    metrics.push(['Total Expenses', `₹${fmt(data.total_expenses)}`], ['Purchase / COGS', `₹${fmt(data.purchase_cogs)}`]);
    EXPENSE_CATS.forEach(([key, label]) => metrics.push([label, `₹${fmt(data[key])}`]));
    chartTable(data.monthly_expenses, 'Monthly Expenses');
    chartTable(data.department_wise_expenses, 'Department / Category-wise Expenses');
  } else if (tab === 'profitability') {
    const p = data.client_profitability || {};
    metrics.push(
      ['Revenue', `₹${fmt(p.revenue)}`],
      ['Direct Cost', `₹${fmt(p.direct_cost)}`],
      ['Indirect Cost', `₹${fmt(p.indirect_cost)}`],
      ['Profit', `₹${fmt(p.profit)}`],
      ['Profit Margin', `${p.profit_pct ?? 0}%`],
    );
  }

  return { tabLabel, metrics, tables };
}

function exportFileBase(tabLabel, clientName, period) {
  return `MIS_${tabLabel.replace(/\s+/g, '_')}_${(clientName || 'Client').replace(/\s+/g, '_')}_${(period || 'Period').replace(/\s+/g, '_')}`;
}

async function exportMISPDF(tab, data, clientName, period) {
  const exp = buildMISExportData(tab, data, clientName, period);
  if (!exp) { toast.error('No data to export yet'); return; }

  const jsPDF = await getJsPDF();
  await getAutoTable(); // side-effect: patches doc.autoTable(...)
  const doc = new jsPDF('p', 'mm', 'a4');
  let y = 15;
  doc.setFontSize(15);
  doc.setFont(undefined, 'bold');
  doc.text('MIS Report', 14, y); y += 7;
  doc.setFontSize(10);
  doc.setFont(undefined, 'normal');
  doc.text(`${exp.tabLabel} — ${clientName || ''}`, 14, y); y += 5;
  doc.text(`Period: ${period || ''}   |   Generated: ${new Date().toLocaleDateString('en-IN')}`, 14, y); y += 6;

  if (exp.metrics.length) {
    doc.autoTable({
      startY: y,
      head: [['Metric', 'Value']],
      body: exp.metrics,
      theme: 'grid',
      styles: { fontSize: 9 },
      headStyles: { fillColor: [31, 111, 178] },
      margin: { left: 14, right: 14 },
    });
    y = doc.lastAutoTable.finalY + 8;
  }

  exp.tables.forEach((t) => {
    if (y > 260) { doc.addPage(); y = 15; }
    doc.setFontSize(11);
    doc.setFont(undefined, 'bold');
    doc.text(t.title, 14, y);
    y += 4;
    doc.autoTable({
      startY: y,
      head: [t.columns],
      body: t.rows,
      theme: 'striped',
      styles: { fontSize: 8 },
      headStyles: { fillColor: [31, 111, 178] },
      margin: { left: 14, right: 14 },
    });
    y = doc.lastAutoTable.finalY + 8;
  });

  doc.save(`${exportFileBase(exp.tabLabel, clientName, period)}.pdf`);
  toast.success('PDF downloaded');
}

function exportMISWord(tab, data, clientName, period) {
  const exp = buildMISExportData(tab, data, clientName, period);
  if (!exp) { toast.error('No data to export yet'); return; }

  const cell = 'padding:6px 10px;border:1px solid #ddd;';
  const head = `${cell}background:#f1f5f9;text-align:left;font-weight:bold;`;

  const metricsHtml = exp.metrics.map(([k, v]) => `<tr><td style="${cell}">${k}</td><td style="${cell}font-weight:bold;">${v}</td></tr>`).join('');

  const tablesHtml = exp.tables.map((t) => `
    <h3 style="margin-top:22px;color:#1F6FB2;">${t.title}</h3>
    <table style="border-collapse:collapse;width:100%;font-size:12px;">
      <thead><tr>${t.columns.map((c) => `<th style="${head}">${c}</th>`).join('')}</tr></thead>
      <tbody>${t.rows.map((r) => `<tr>${r.map((c) => `<td style="${cell}">${c}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
  `).join('');

  const html = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
    <head><meta charset="utf-8">
      <!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
      <style>body{font-family:Calibri,Arial,sans-serif;} h1{color:#1F6FB2;margin-bottom:2px;} h2{color:#334155;margin-top:0;}</style>
    </head>
    <body>
      <h1>MIS Report — ${exp.tabLabel}</h1>
      <h2>${clientName || ''}</h2>
      <p>Period: ${period || ''} &nbsp;|&nbsp; Generated: ${new Date().toLocaleDateString('en-IN')}</p>
      <table style="border-collapse:collapse;width:100%;font-size:12px;margin-top:10px;">
        <thead><tr><th style="${head}">Metric</th><th style="${head}">Value</th></tr></thead>
        <tbody>${metricsHtml}</tbody>
      </table>
      ${tablesHtml}
    </body>
    </html>
  `;

  const blob = new Blob(['\ufeff', html], { type: 'application/msword' });
  saveAs(blob, `${exportFileBase(exp.tabLabel, clientName, period)}.doc`);
  toast.success('Word document downloaded');
}

async function exportMISExcel(tab, data, clientName, period) {
  const exp = buildMISExportData(tab, data, clientName, period);
  if (!exp) { toast.error('No data to export yet'); return; }

  const XLSX = await getXLSX();
  const wb = XLSX.utils.book_new();
  const summaryRows = [
    ['MIS Report'], [exp.tabLabel], [`Client: ${clientName || ''}`], [`Period: ${period || ''}`], [],
    ['Metric', 'Value'], ...exp.metrics,
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), 'Summary');

  const usedNames = new Set(['Summary']);
  exp.tables.forEach((t, i) => {
    const base = t.title.replace(/[\\/*?:[\]]/g, '').slice(0, 28) || `Table${i + 1}`;
    let name = base, n = 1;
    while (usedNames.has(name)) name = `${base}_${n++}`;
    usedNames.add(name);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([t.columns, ...t.rows]), name);
  });

  XLSX.writeFile(wb, `${exportFileBase(exp.tabLabel, clientName, period)}.xlsx`);
  toast.success('Excel downloaded');
}

/* ─────────────────────────────────────────────────────────────────────── */

export default function MISReport() {
  const isDark = useDark();
  const { user, hasPermission } = useAuth();
  const canManage = user?.role === 'admin' || hasPermission('can_manage_mis_report');

  const [clients, setClients] = useState([]);
  const [clientId, setClientId] = useState('');
  const [period, setPeriod] = useState(currentFYLabel());
  const [periods, setPeriods] = useState([]);
  const [tab, setTab] = useState('dashboard');
  const [showAddClient, setShowAddClient] = useState(false);
  const [showUploads, setShowUploads] = useState(true);
  const [showManual, setShowManual] = useState(false);

  const [uploads, setUploads] = useState([]);
  const [uploading, setUploading] = useState({});
  const [manual, setManual] = useState(null);
  const [savingManual, setSavingManual] = useState(false);

  const [reportData, setReportData] = useState({});
  const [loadingReport, setLoadingReport] = useState(false);

  const fileInputs = useRef({});

  /* ── load client list ─────────────────────────────────────────────── */
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/mis/clients');
        setClients(data || []);
        if (data?.length && !clientId) setClientId(data[0].id);
      } catch (e) {
        toast.error('Could not load clients');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── load periods for selected client ─────────────────────────────── */
  const loadPeriods = useCallback(async (cid) => {
    if (!cid) return;
    try {
      const { data } = await api.get('/mis/periods', { params: { client_id: cid } });
      setPeriods(data?.periods || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { if (clientId) loadPeriods(clientId); }, [clientId, loadPeriods]);

  /* ── load uploads + manual entry ───────────────────────────────────── */
  const loadUploads = useCallback(async () => {
    if (!clientId || !period) return;
    try {
      const { data } = await api.get('/mis/uploads', { params: { client_id: clientId, period } });
      setUploads(data || []);
    } catch { /* ignore */ }
  }, [clientId, period]);

  const loadManual = useCallback(async () => {
    if (!clientId || !period) return;
    try {
      const { data } = await api.get('/mis/manual-entry', { params: { client_id: clientId, period } });
      setManual({
        opening_cash_bank_balance: 0, closing_cash_bank_balance: 0, depreciation_amortization: 0,
        interest_expense: 0, tax_expense: 0, interest_on_delayed_payment_rate: 0,
        bad_debts: [], advances_to_vendors: [], security_deposits: [], budget: {},
        ...data,
      });
    } catch { /* ignore */ }
  }, [clientId, period]);

  useEffect(() => { loadUploads(); loadManual(); }, [loadUploads, loadManual]);

  /* ── load active tab's report ─────────────────────────────────────── */
  const loadReport = useCallback(async () => {
    if (!clientId || !period) return;
    setLoadingReport(true);
    try {
      const { data } = await api.get(`/mis/${tab}`, { params: { client_id: clientId, period } });
      setReportData((prev) => ({ ...prev, [tab]: data }));
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not load report');
    } finally {
      setLoadingReport(false);
    }
  }, [clientId, period, tab]);

  useEffect(() => { loadReport(); }, [loadReport]);

  const refreshAll = () => { loadUploads(); loadManual(); loadReport(); loadPeriods(clientId); };

  /* ── upload handler ───────────────────────────────────────────────── */
  const handleUpload = async (docType, file) => {
    if (!file) return;
    if (!clientId) { toast.error('Select a client first'); return; }
    setUploading((p) => ({ ...p, [docType]: true }));
    const form = new FormData();
    form.append('client_id', clientId);
    form.append('period', period);
    form.append('doc_type', docType);
    form.append('file', file);
    try {
      const { data } = await api.post('/mis/upload', form, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000 });
      const label = DOC_TYPES.find((d) => d.key === docType)?.label;
      if (data.status === 'partial') {
        toast.warning(`${label}: file stored but rows could not be auto-extracted. ${data.error || 'You can fill in figures manually.'}`, { duration: 8000 });
      } else {
        toast.success(`${label}: ${data.row_count} rows parsed successfully`);
      }
      refreshAll();
    } catch (e) {
      const detail = e?.response?.data?.detail;
      toast.error(detail || 'Upload failed — the file could not be read. Try saving it as PDF or Excel and re-uploading.', { duration: 8000 });
    } finally {
      setUploading((p) => ({ ...p, [docType]: false }));
    }
  };

  const deleteUpload = async (id) => {
    try {
      await api.delete(`/mis/uploads/${id}`);
      toast.success('Upload removed');
      refreshAll();
    } catch { toast.error('Could not delete upload'); }
  };

  const saveManual = async () => {
    setSavingManual(true);
    try {
      await api.put('/mis/manual-entry', { ...manual, client_id: clientId, period });
      toast.success('Manual entries saved');
      loadReport();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not save');
    } finally {
      setSavingManual(false);
    }
  };

  const uploadsByType = useMemo(() => {
    const m = {};
    for (const u of uploads) { if (!m[u.doc_type] || u.uploaded_at > m[u.doc_type].uploaded_at) m[u.doc_type] = u; }
    return m;
  }, [uploads]);

  const selectedClient = clients.find((c) => c.id === clientId);

  /* ═══════════════════════════════════════════════════════════════════ */
  return (
    <div>
      <HubBanner
        icon={FileBarChart2}
        eyebrow="Compliance · Client Financial Intelligence"
        title="MIS Report"
        subtitle="Build a Financial Dashboard, Receivables/Payables, Revenue, Expense and Profitability MIS for any client from their yearly registers, bank statement, balance sheet and GST reports."
        isDark={isDark}
      />

      {/* Client + period selector */}
      <Card isDark={isDark} className="mb-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[240px] flex-1">
            <label className={`text-xs font-bold uppercase tracking-wide mb-1.5 block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Client</label>
            <div className="flex gap-2">
              <select
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className={`flex-1 rounded-xl border px-3 py-2.5 text-sm font-medium ${isDark ? 'bg-slate-950 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'}`}
              >
                {!clients.length && <option value="">No clients yet</option>}
                {clients.map((c) => <option key={c.id} value={c.id}>{c.company_name}</option>)}
              </select>
              {canManage && (
                <button
                  onClick={() => setShowAddClient(true)}
                  className="rounded-xl px-3 py-2.5 text-sm font-semibold text-white flex items-center gap-1.5 shrink-0"
                  style={{ background: HUB_COLORS.mediumBlue }}
                >
                  <Plus className="h-4 w-4" /> Add
                </button>
              )}
            </div>
          </div>

          <div className="min-w-[200px]">
            <label className={`text-xs font-bold uppercase tracking-wide mb-1.5 block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Period (e.g. FY2025-26)</label>
            <div className="flex gap-2">
              <input
                list="mis-periods"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                placeholder="FY2025-26"
                className={`rounded-xl border px-3 py-2.5 text-sm font-medium w-full ${isDark ? 'bg-slate-950 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'}`}
              />
              <datalist id="mis-periods">
                {periods.map((p) => <option key={p} value={p} />)}
              </datalist>
            </div>
          </div>

          <button
            onClick={refreshAll}
            className={`rounded-xl px-3 py-2.5 text-sm font-semibold flex items-center gap-1.5 border ${isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>

          {selectedClient?.gstin && (
            <span className={`text-xs px-2.5 py-1 rounded-full ${isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
              GSTIN: {selectedClient.gstin}
            </span>
          )}
        </div>
      </Card>

      {/* Uploads */}
      <Card isDark={isDark} className="mb-6">
        <button onClick={() => setShowUploads((v) => !v)} className="w-full flex items-center justify-between mb-1">
          <SectionTitle isDark={isDark}>Source Documents ({period || '—'})</SectionTitle>
          <ChevronDown className={`h-4 w-4 transition-transform ${showUploads ? 'rotate-180' : ''} ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
        </button>
        {showUploads && (
          <>
            <p className={`text-xs mb-4 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              Upload each document once per period. Re-uploading a doc type adds a new version — remove the old one first if you want to replace it.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {DOC_TYPES.map((d) => {
                const existing = uploadsByType[d.key];
                const isUploading = uploading[d.key];
                return (
                  <div key={d.key} className={`rounded-xl border p-3.5 ${isDark ? 'border-slate-800 bg-slate-950/40' : 'border-slate-200 bg-slate-50/60'}`}>
                    <div className="flex items-start gap-2.5 mb-2">
                      <d.icon className="h-4 w-4 mt-0.5 shrink-0" style={{ color: HUB_COLORS.mediumBlue }} />
                      <div className="min-w-0">
                        <p className={`text-sm font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>{d.label}</p>
                        <p className={`text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{d.hint}</p>
                      </div>
                    </div>

                    {existing ? (
                      <div className="flex items-center justify-between gap-2 mt-2">
                        <span className={`text-xs flex items-center gap-1 min-w-0 truncate ${existing.status === 'error' ? 'text-red-500' : existing.status === 'partial' ? 'text-amber-500' : 'text-emerald-500'}`}>
                          {existing.status === 'error' ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : existing.status === 'partial' ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
                          <span className="truncate" title={existing.status === 'partial' ? (existing.error || 'Stored — fill manually') : existing.filename}>
                            {existing.filename} · {existing.status === 'partial' ? 'stored (manual fill needed)' : `${existing.row_count} rows`}
                          </span>
                        </span>
                        {canManage && (
                          <button onClick={() => deleteUpload(existing.id)} className="text-red-400 hover:text-red-500 shrink-0">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    ) : (
                      <p className={`text-xs italic mt-2 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Not uploaded yet</p>
                    )}

                    {canManage && (
                      <>
                        <input
                          ref={(el) => (fileInputs.current[d.key] = el)}
                          type="file"
                          accept=".xlsx,.xls,.csv,.tsv,.pdf,.zip,.docx,.doc,.xlsm"
                          className="hidden"
                          onChange={(e) => { handleUpload(d.key, e.target.files[0]); e.target.value = ''; }}
                        />
                        <button
                          disabled={isUploading}
                          onClick={() => fileInputs.current[d.key]?.click()}
                          className={`mt-3 w-full rounded-lg py-2 text-xs font-semibold flex items-center justify-center gap-1.5 ${isDark ? 'bg-slate-800 text-slate-200 hover:bg-slate-700' : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'}`}
                        >
                          {isUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                          {existing ? 'Upload new version' : 'Upload file'}
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Card>

      {/* Manual entry */}
      {manual && (
        <Card isDark={isDark} className="mb-6">
          <button onClick={() => setShowManual((v) => !v)} className="w-full flex items-center justify-between mb-1">
            <SectionTitle isDark={isDark}>Manual Entry — figures not on your registers</SectionTitle>
            <ChevronDown className={`h-4 w-4 transition-transform ${showManual ? 'rotate-180' : ''} ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
          </button>
          {showManual && (
            <div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-3">
                {[
                  ['opening_cash_bank_balance', 'Opening Cash & Bank'],
                  ['closing_cash_bank_balance', 'Closing Cash & Bank'],
                  ['depreciation_amortization', 'Depreciation & Amortisation'],
                  ['interest_expense', 'Interest Expense'],
                  ['tax_expense', 'Tax Expense (Provision)'],
                  ['interest_on_delayed_payment_rate', 'Interest on Delayed Payment (annual %)'],
                ].map(([key, label]) => (
                  <div key={key}>
                    <label className={`text-[11px] font-semibold mb-1 block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</label>
                    <input
                      type="number"
                      disabled={!canManage}
                      value={manual[key] ?? 0}
                      onChange={(e) => setManual((m) => ({ ...m, [key]: parseFloat(e.target.value) || 0 }))}
                      className={`w-full rounded-lg border px-2.5 py-2 text-sm ${isDark ? 'bg-slate-950 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'}`}
                    />
                  </div>
                ))}
              </div>
              {manual.balance_sheet_suggestions && Object.keys(manual.balance_sheet_suggestions).length > 0 && (
                <p className={`text-xs mt-3 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  Auto-detected from the uploaded balance sheet: {Object.entries(manual.balance_sheet_suggestions).map(([k, v]) => `${k.replace(/_/g, ' ')} ≈ ₹${fmt(v)}`).join(', ')}. Values above were pre-filled where left blank — review before relying on them.
                </p>
              )}
              {canManage && (
                <button
                  onClick={saveManual}
                  disabled={savingManual}
                  className="mt-4 rounded-xl px-4 py-2 text-sm font-semibold text-white flex items-center gap-1.5"
                  style={{ background: HUB_COLORS.emeraldGreen }}
                >
                  {savingManual ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
                </button>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold transition-colors ${
                tab === t.key
                  ? 'text-white'
                  : isDark ? 'bg-slate-900/60 text-slate-400 border border-slate-800 hover:text-slate-200' : 'bg-white text-slate-500 border border-slate-200 hover:text-slate-700'
              }`}
              style={tab === t.key ? { background: HUB_COLORS.mediumBlue } : {}}
            >
              <t.icon className="h-4 w-4" /> {t.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <span className={`text-xs font-semibold hidden sm:inline ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            <Download className="h-3.5 w-3.5 inline -mt-0.5 mr-1" />Export:
          </span>
          <button
            disabled={!reportData[tab]}
            onClick={() => exportMISPDF(tab, reportData[tab], selectedClient?.company_name, period)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-lg shadow-sm transition-colors"
          >
            <FileText className="h-3.5 w-3.5" /> PDF
          </button>
          <button
            disabled={!reportData[tab]}
            onClick={() => exportMISWord(tab, reportData[tab], selectedClient?.company_name, period)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-lg shadow-sm transition-colors"
          >
            <FileText className="h-3.5 w-3.5" /> Word
          </button>
          <button
            disabled={!reportData[tab]}
            onClick={() => exportMISExcel(tab, reportData[tab], selectedClient?.company_name, period)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-lg shadow-sm transition-colors"
          >
            <FileSpreadsheet className="h-3.5 w-3.5" /> Excel
          </button>
        </div>
      </div>

      {loadingReport && !reportData[tab] ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
      ) : (
        <>
          {tab === 'dashboard' && <FinancialDashboardTab data={reportData.dashboard} isDark={isDark} />}
          {tab === 'receivables' && <ReceivablesTab data={reportData.receivables} isDark={isDark} />}
          {tab === 'payables' && <PayablesTab data={reportData.payables} isDark={isDark} />}
          {tab === 'revenue' && <RevenueTab data={reportData.revenue} isDark={isDark} />}
          {tab === 'expense' && <ExpenseTab data={reportData.expense} isDark={isDark} />}
          {tab === 'profitability' && <ProfitabilityTab data={reportData.profitability} isDark={isDark} />}
        </>
      )}

      {showAddClient && (
        <AddClientModal
          isDark={isDark}
          onClose={() => setShowAddClient(false)}
          onCreated={(c) => { setClients((p) => [...p, c]); setClientId(c.id); setShowAddClient(false); }}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════ TABS ═══════════════════════════════════════ */

function FinancialDashboardTab({ data, isDark }) {
  if (!data) return <EmptyState isDark={isDark} text="Select a client and period, then upload documents to see the dashboard." />;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <MetricCard icon={TrendingUp} label="Total Revenue" value={`₹${fmt(data.total_revenue)}`} isDark={isDark} color={HUB_COLORS.emeraldGreen} />
        <MetricCard icon={TrendingDown} label="Total Expenses" value={`₹${fmt(data.total_expenses)}`} isDark={isDark} color="#EF4444" />
        <MetricCard icon={Wallet} label="Gross Profit" value={`₹${fmt(data.gross_profit)}`} isDark={isDark} />
        <MetricCard icon={Wallet} label="Net Profit" value={`₹${fmt(data.net_profit)}`} isDark={isDark} color={data.net_profit >= 0 ? HUB_COLORS.emeraldGreen : '#EF4444'} />
        <MetricCard icon={Target} label="EBITDA" value={`₹${fmt(data.ebitda)}`} isDark={isDark} color="#7C3AED" />
        <MetricCard icon={Landmark} label="Cash & Bank Balance" value={`₹${fmt(data.cash_and_bank_balance)}`} isDark={isDark} color="#0EA5E9" />
        <MetricCard icon={ReceiptText} label="Accounts Receivable" value={`₹${fmt(data.accounts_receivable)}`} isDark={isDark} color="#F59E0B" />
        <MetricCard icon={ReceiptText} label="Accounts Payable" value={`₹${fmt(data.accounts_payable)}`} isDark={isDark} color="#EC4899" />
        <MetricCard icon={ArrowLeftRight} label="Working Capital" value={`₹${fmt(data.working_capital)}`} isDark={isDark} />
        <MetricCard icon={Banknote} label="Cash Flow Position" value={`₹${fmt(data.cash_flow_position)}`} isDark={isDark} sub={`In ₹${fmt(data.cash_in)} · Out ₹${fmt(data.cash_out)}`} />
        <MetricCard
          icon={data.revenue_growth_pct >= 0 ? TrendingUp : TrendingDown}
          label="Revenue Growth %"
          value={data.revenue_growth_pct == null ? 'N/A' : `${data.revenue_growth_pct}%`}
          isDark={isDark}
          color={data.revenue_growth_pct >= 0 ? HUB_COLORS.emeraldGreen : '#EF4444'}
          sub={data.revenue_growth_pct == null ? 'No prior-year data uploaded' : 'vs previous period'}
        />
      </div>

      <Card isDark={isDark}>
        <SectionTitle isDark={isDark}>Budget vs Actual</SectionTitle>
        {data.budget_vs_actual?.length ? (
          <DataTable
            isDark={isDark}
            rows={data.budget_vs_actual}
            columns={[
              { key: 'category', label: 'Category', render: (r) => r.category.replace(/_/g, ' ') },
              { key: 'budget', label: 'Budget', render: (r) => `₹${fmt(r.budget)}` },
              { key: 'actual', label: 'Actual', render: (r) => `₹${fmt(r.actual)}` },
              { key: 'variance', label: 'Variance', render: (r) => <span className={r.variance > 0 ? 'text-red-500' : 'text-emerald-500'}>₹{fmt(r.variance)}</span> },
            ]}
          />
        ) : (
          <EmptyState isDark={isDark} text="No budget set — add category budgets under Manual Entry to compare against actuals." />
        )}
      </Card>
    </div>
  );
}

function ReceivablesTab({ data, isDark }) {
  if (!data) return <EmptyState isDark={isDark} text="Upload the Sales Register to see receivables." />;
  const s = data.outstanding_summary || {};
  const ageing = toChartData(data.ageing_analysis).map((d) => ({ name: d.name.replace('_', ' '), value: d.value }));
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard icon={ReceiptText} label="Total Outstanding" value={`₹${fmt(data.total_outstanding)}`} isDark={isDark} color="#F59E0B" />
        <MetricCard icon={TrendingUp} label="Collection Efficiency" value={`${data.collection_reports?.collection_efficiency_pct ?? 0}%`} isDark={isDark} color={HUB_COLORS.emeraldGreen} />
        <MetricCard icon={Clock} label="Expected Collections" value={`₹${fmt(data.collection_reports?.expected_collections)}`} isDark={isDark} />
        <MetricCard icon={AlertTriangle} label="Overdue Total" value={`₹${fmt(data.collection_reports?.overdue_total)}`} isDark={isDark} color="#EF4444" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card isDark={isDark}><SectionTitle isDark={isDark}>Ageing Analysis</SectionTitle><SimpleBarChart data={ageing} isDark={isDark} color="#F59E0B" /></Card>
        <Card isDark={isDark}><SectionTitle isDark={isDark}>Client-wise Outstanding</SectionTitle><SimplePie data={toChartData(s.client_wise)} isDark={isDark} /></Card>
        <Card isDark={isDark}><SectionTitle isDark={isDark}>Branch-wise Outstanding</SectionTitle><SimpleBarChart data={toChartData(s.branch_wise)} isDark={isDark} color={HUB_COLORS.mediumBlue} /></Card>
        <Card isDark={isDark}><SectionTitle isDark={isDark}>Partner-wise Outstanding</SectionTitle><SimpleBarChart data={toChartData(s.partner_wise)} isDark={isDark} color="#7C3AED" /></Card>
      </div>

      <Card isDark={isDark}>
        <SectionTitle isDark={isDark}>Invoice-wise Outstanding</SectionTitle>
        <DataTable
          isDark={isDark}
          rows={s.invoice_wise}
          emptyText="No open invoices."
          columns={[
            { key: 'invoice_no', label: 'Invoice #' }, { key: 'party_name', label: 'Party' },
            { key: 'due_date', label: 'Due Date' }, { key: 'status', label: 'Status' },
            { key: 'outstanding', label: 'Outstanding', render: (r) => `₹${fmt(r.outstanding)}` },
          ]}
        />
      </Card>

      <Card isDark={isDark}>
        <SectionTitle isDark={isDark}>Monthly Collections</SectionTitle>
        <SimpleBarChart data={toChartData(data.collection_reports?.monthly_collections)} isDark={isDark} color={HUB_COLORS.emeraldGreen} />
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card isDark={isDark}>
          <SectionTitle isDark={isDark}>Overdue Invoices</SectionTitle>
          <DataTable
            isDark={isDark}
            rows={data.collection_reports?.overdue_invoices}
            emptyText="Nothing overdue."
            columns={[
              { key: 'invoice_no', label: 'Invoice #' }, { key: 'party_name', label: 'Party' },
              { key: 'due_date', label: 'Due Date' }, { key: 'outstanding', label: 'Outstanding', render: (r) => `₹${fmt(r.outstanding)}` },
            ]}
          />
        </Card>
        <Card isDark={isDark}>
          <SectionTitle isDark={isDark}>Bad Debts & Delayed-Payment Interest</SectionTitle>
          <p className={`text-sm mb-2 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>Bad debts total: <b>₹{fmt(data.collection_reports?.bad_debts_total)}</b></p>
          <p className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>Interest on delayed payments: <b>₹{fmt(data.collection_reports?.interest_on_delayed_payments)}</b></p>
          <p className={`text-xs mt-2 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Set the annual interest rate and log bad debts under Manual Entry.</p>
        </Card>
      </div>
    </div>
  );
}

function PayablesTab({ data, isDark }) {
  if (!data) return <EmptyState isDark={isDark} text="Upload the Purchase Register to see payables." />;
  const ageing = toChartData(data.ageing_analysis).map((d) => ({ name: d.name.replace('_', ' '), value: d.value }));
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <MetricCard icon={ReceiptText} label="Total Payable" value={`₹${fmt(data.total_payable)}`} isDark={isDark} color="#EC4899" />
        <MetricCard icon={Banknote} label="Advances to Vendors" value={`₹${fmt((data.advances_to_vendors || []).reduce((s, a) => s + (a.amount || 0), 0))}`} isDark={isDark} />
        <MetricCard icon={Landmark} label="Security Deposits" value={`₹${fmt((data.security_deposits || []).reduce((s, a) => s + (a.amount || 0), 0))}`} isDark={isDark} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card isDark={isDark}><SectionTitle isDark={isDark}>Ageing Analysis</SectionTitle><SimpleBarChart data={ageing} isDark={isDark} color="#EC4899" /></Card>
        <Card isDark={isDark}><SectionTitle isDark={isDark}>Vendor-wise Payables</SectionTitle><SimplePie data={toChartData(data.vendor_wise_payables)} isDark={isDark} /></Card>
        <Card isDark={isDark}><SectionTitle isDark={isDark}>Expense Category-wise Payables</SectionTitle><SimpleBarChart data={toChartData(data.expense_category_wise_payables)} isDark={isDark} color={HUB_COLORS.mediumBlue} /></Card>
        <Card isDark={isDark}><SectionTitle isDark={isDark}>Monthly Payment Summary</SectionTitle><SimpleBarChart data={toChartData(data.monthly_payment_summary)} isDark={isDark} color={HUB_COLORS.emeraldGreen} /></Card>
      </div>

      <Card isDark={isDark}>
        <SectionTitle isDark={isDark}>Due Payments (upcoming)</SectionTitle>
        <DataTable
          isDark={isDark}
          rows={data.due_payments}
          emptyText="No upcoming payments."
          columns={[
            { key: 'invoice_no', label: 'Bill #' }, { key: 'party_name', label: 'Vendor' },
            { key: 'due_date', label: 'Due Date' }, { key: 'outstanding', label: 'Amount', render: (r) => `₹${fmt(r.outstanding)}` },
          ]}
        />
      </Card>
    </div>
  );
}

function RevenueTab({ data, isDark }) {
  if (!data) return <EmptyState isDark={isDark} text="Upload the Sales Register to see revenue analysis." />;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <MetricCard icon={TrendingUp} label="Total Revenue" value={`₹${fmt(data.total_revenue)}`} isDark={isDark} color={HUB_COLORS.emeraldGreen} />
        <MetricCard icon={Users} label="Repeat Client Revenue" value={`₹${fmt(data.repeat_client_revenue)}`} isDark={isDark} color={HUB_COLORS.mediumBlue} />
        <MetricCard icon={Plus} label="New Client Revenue" value={`₹${fmt(data.new_client_revenue)}`} isDark={isDark} color="#7C3AED" />
      </div>

      <Card isDark={isDark}><SectionTitle isDark={isDark}>Monthly Revenue Trend</SectionTitle><SimpleBarChart data={toChartData(data.monthly_revenue_trend)} isDark={isDark} color={HUB_COLORS.emeraldGreen} /></Card>
      <Card isDark={isDark}><SectionTitle isDark={isDark}>Daily Revenue</SectionTitle><SimpleBarChart data={toChartData(data.daily_revenue)} isDark={isDark} color={HUB_COLORS.mediumBlue} height={220} /></Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card isDark={isDark}><SectionTitle isDark={isDark}>Service-wise Revenue</SectionTitle><SimplePie data={toChartData(data.service_wise_revenue)} isDark={isDark} /></Card>
        <Card isDark={isDark}><SectionTitle isDark={isDark}>Client-wise Revenue</SectionTitle><SimplePie data={toChartData(data.client_wise_revenue)} isDark={isDark} /></Card>
        <Card isDark={isDark}><SectionTitle isDark={isDark}>Branch-wise Revenue</SectionTitle><SimpleBarChart data={toChartData(data.branch_wise_revenue)} isDark={isDark} /></Card>
        <Card isDark={isDark}><SectionTitle isDark={isDark}>Partner-wise Revenue</SectionTitle><SimpleBarChart data={toChartData(data.partner_wise_revenue)} isDark={isDark} color="#7C3AED" /></Card>
        <Card isDark={isDark} className="lg:col-span-2"><SectionTitle isDark={isDark}>Employee-wise Billing</SectionTitle><SimpleBarChart data={toChartData(data.employee_wise_billing)} isDark={isDark} color="#F59E0B" /></Card>
      </div>
    </div>
  );
}

function ExpenseTab({ data, isDark }) {
  if (!data) return <EmptyState isDark={isDark} text="Upload the Bank Statement (and Purchase Register) to see expenses." />;
  const cats = [
    ['rent', 'Rent'], ['employee_expenses', 'Employee Expenses'], ['travel_expenses', 'Travel Expenses'],
    ['office_expenses', 'Office Expenses'], ['software_subscription_cost', 'Software Subscription'],
    ['utility_expenses', 'Utility Expenses'], ['marketing_expenses', 'Marketing Expenses'],
    ['administrative_expenses', 'Administrative Expenses'],
  ];
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <MetricCard icon={Wallet} label="Total Expenses" value={`₹${fmt(data.total_expenses)}`} isDark={isDark} color="#EF4444" />
        <MetricCard icon={ReceiptText} label="Purchase / COGS" value={`₹${fmt(data.purchase_cogs)}`} isDark={isDark} color="#F59E0B" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {cats.map(([key, label]) => (
          <MetricCard key={key} icon={Wallet} label={label} value={`₹${fmt(data[key])}`} isDark={isDark} color={PALETTE[cats.findIndex(c => c[0] === key) % PALETTE.length]} />
        ))}
      </div>

      <Card isDark={isDark}><SectionTitle isDark={isDark}>Monthly Expenses</SectionTitle><SimpleBarChart data={toChartData(data.monthly_expenses)} isDark={isDark} color="#EF4444" /></Card>
      <Card isDark={isDark}><SectionTitle isDark={isDark}>Department / Category-wise Expenses</SectionTitle><SimplePie data={toChartData(data.department_wise_expenses)} isDark={isDark} /></Card>
    </div>
  );
}

function ProfitabilityTab({ data, isDark }) {
  if (!data) return <EmptyState isDark={isDark} text="Upload Sales, Purchase and Bank Statement to compute profitability." />;
  const p = data.client_profitability || {};
  const chartData = [
    { name: 'Revenue', value: p.revenue || 0 },
    { name: 'Direct Cost', value: p.direct_cost || 0 },
    { name: 'Indirect Cost', value: p.indirect_cost || 0 },
    { name: 'Profit', value: p.profit || 0 },
  ];
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard icon={TrendingUp} label="Revenue" value={`₹${fmt(p.revenue)}`} isDark={isDark} color={HUB_COLORS.emeraldGreen} />
        <MetricCard icon={TrendingDown} label="Direct Cost" value={`₹${fmt(p.direct_cost)}`} isDark={isDark} color="#F59E0B" />
        <MetricCard icon={TrendingDown} label="Indirect Cost" value={`₹${fmt(p.indirect_cost)}`} isDark={isDark} color="#EF4444" />
        <MetricCard icon={Target} label="Profit" value={`₹${fmt(p.profit)}`} isDark={isDark} color={p.profit >= 0 ? HUB_COLORS.emeraldGreen : '#EF4444'} sub={`${p.profit_pct ?? 0}% margin`} />
      </div>
      <Card isDark={isDark}>
        <SectionTitle isDark={isDark}>Client Profitability Breakdown</SectionTitle>
        <SimpleBarChart data={chartData} isDark={isDark} color={HUB_COLORS.mediumBlue} />
      </Card>
    </div>
  );
}

/* ═══════════════════════════ ADD CLIENT MODAL ═══════════════════════════ */

function AddClientModal({ isDark, onClose, onCreated }) {
  const [form, setForm] = useState({ company_name: '', client_type: 'other', email: '', phone: '', gstin: '' });
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!form.company_name.trim()) { toast.error('Company name is required'); return; }
    setSaving(true);
    try {
      const { data } = await api.post('/mis/clients', form);
      toast.success('Client added');
      onCreated(data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not add client');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-emerald-900/50 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-md max-h-[92vh] overflow-y-auto overflow-x-hidden rounded-2xl p-6 ${isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white'}`}
      >
        <PopupHeader className="-mx-6 -mt-6 mb-4" icon={Building2} eyebrow="MIS report" title="Add New Client" titleAs="h3" onClose={onClose} />
        <div className="space-y-3">
          <div>
            <label className={`text-xs font-semibold mb-1 block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Company Name *</label>
            <input
              value={form.company_name}
              onChange={(e) => setForm((f) => ({ ...f, company_name: e.target.value }))}
              className={`w-full rounded-lg border px-3 py-2 text-sm ${isDark ? 'bg-slate-950 border-slate-700 text-white' : 'bg-white border-slate-300'}`}
            />
          </div>
          <div>
            <label className={`text-xs font-semibold mb-1 block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>GSTIN</label>
            <input
              value={form.gstin}
              onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value }))}
              className={`w-full rounded-lg border px-3 py-2 text-sm ${isDark ? 'bg-slate-950 border-slate-700 text-white' : 'bg-white border-slate-300'}`}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={`text-xs font-semibold mb-1 block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Email</label>
              <input value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className={`w-full rounded-lg border px-3 py-2 text-sm ${isDark ? 'bg-slate-950 border-slate-700 text-white' : 'bg-white border-slate-300'}`} />
            </div>
            <div>
              <label className={`text-xs font-semibold mb-1 block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Phone</label>
              <input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} className={`w-full rounded-lg border px-3 py-2 text-sm ${isDark ? 'bg-slate-950 border-slate-700 text-white' : 'bg-white border-slate-300'}`} />
            </div>
          </div>
        </div>
        <button
          onClick={submit}
          disabled={saving}
          className="w-full mt-5 rounded-xl py-2.5 text-sm font-bold text-white flex items-center justify-center gap-2"
          style={{ background: HUB_COLORS.mediumBlue }}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add Client
        </button>
      </div>
    </div>
  );
}
