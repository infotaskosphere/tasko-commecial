import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Receipt, Plus, X, Loader2, Trash2, Building2, Users as UsersIcon, Download,
  FileText, Copy, Pencil, Search, RefreshCw, Save, CalendarDays, Landmark,
  ToggleLeft, ToggleRight, CheckCircle2, ChevronLeft, ChevronRight, Info,
  UserPlus, ClipboardList, Upload, FileSpreadsheet, AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { PopupHeader } from '@/components/ui/popup-header';
import api from '@/lib/api';
import useDark from '@/hooks/useDark';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { HubBanner, StatCard, HUB_COLORS } from '@/components/SectionHub.jsx';
import SearchableSelect from '@/components/ui/SearchableSelect.jsx';

/* ═══════════════════════════════════════════════════════════════════════
 * Helpers
 * ═══════════════════════════════════════════════════════════════════════ */

const MONTHS = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const now = new Date();

const inr = (n) => `Rs. ${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0)}`;

const sumItems = (items) => (items || []).reduce((s, it) => s + (parseFloat(it.amount) || 0), 0);

/** Expands a from-month/year → to-month/year range into an ordered list of
 * { month, year } periods (inclusive). Returns [] if "to" is before "from". */
function buildPeriodRange(fromMonth, fromYear, toMonth, toYear) {
  const from = Number(fromYear) * 12 + (Number(fromMonth) - 1);
  const to = Number(toYear) * 12 + (Number(toMonth) - 1);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  const periods = [];
  for (let idx = from; idx <= to; idx++) {
    periods.push({ month: (idx % 12) + 1, year: Math.floor(idx / 12) });
  }
  return periods;
}

const MAX_BULK_PERIODS = 24;

async function parseBlobError(err) {
  try {
    const blob = err?.response?.data;
    if (blob instanceof Blob) {
      const text = await blob.text();
      const json = JSON.parse(text);
      return json.detail || 'Something went wrong';
    }
  } catch { /* fall through */ }
  return err?.response?.data?.detail || 'Something went wrong';
}

function triggerBlobDownload(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

const emptyEmployeeForm = () => ({
  name: '', employee_code: '', designation: '', department: '',
  date_of_joining: '', pan: '', uan: '', pf_number: '', esic_number: '',
  bank_name: '', bank_account: '', ifsc: '', email: '', phone: '', status: 'active',
  default_earnings: [{ label: 'Basic', amount: 0 }],
  default_deductions: [],
});

const emptyCompanyForm = () => ({ name: '', address: '', city: '', state: '', gstin: '', pan: '', contact_email: '', contact_phone: '' });

/* ═══════════════════════════════════════════════════════════════════════
 * Small shared UI atoms — mirrors the plain-div / Tailwind style already
 * used by MISReport.jsx (this module's newest sibling page) rather than
 * pulling in shadcn Dialog/Tabs, to stay visually consistent.
 * ═══════════════════════════════════════════════════════════════════════ */

function Card({ children, isDark, className = '' }) {
  return (
    <div className={`rounded-2xl border p-5 ${isDark ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200'} ${className}`}>
      {children}
    </div>
  );
}

function FieldLabel({ children, isDark }) {
  return <label className={`text-xs font-semibold mb-1 block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{children}</label>;
}

function TextInput({ isDark, className = '', ...props }) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border px-3 py-2 text-sm ${isDark ? 'bg-slate-950 border-slate-700 text-white placeholder:text-slate-600' : 'bg-white border-slate-300 text-slate-900 placeholder:text-slate-400'} ${className}`}
    />
  );
}

function SelectInput({ isDark, className = '', children, ...props }) {
  return (
    <select
      {...props}
      className={`w-full rounded-lg border px-3 py-2 text-sm ${isDark ? 'bg-slate-950 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'} ${className}`}
    >
      {children}
    </select>
  );
}

function EmptyState({ isDark, text, icon: Icon = Info }) {
  return (
    <div className={`flex flex-col items-center justify-center py-10 text-sm text-center ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
      <Icon className="h-6 w-6 mb-2 opacity-60" />
      {text}
    </div>
  );
}

function ModalShell({ isDark, onClose, title, icon: Icon, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-emerald-900/50 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'} max-h-[90vh] overflow-y-auto overflow-x-hidden rounded-2xl p-6 ${isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white'}`}
      >
        <PopupHeader className="-mx-6 -mt-6 mb-4 sticky -top-6 z-10" icon={Icon} eyebrow="Salary slips" title={title} titleAs="h3" onClose={onClose} />
        {children}
      </div>
    </div>
  );
}

/** Dynamic earnings/deductions row editor, shared by the Employee master
 * form, the Generate form, and the edit-slip modal. */
function LineItemsEditor({ title, items, setItems, presets, isDark, accent }) {
  const update = (idx, field, value) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, [field]: value } : it)));
  };
  const remove = (idx) => setItems((prev) => prev.filter((_, i) => i !== idx));
  const addRow = (label = '') => setItems((prev) => [...prev, { label, amount: 0 }]);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className={`text-xs font-bold uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{title}</p>
        <span className={`text-xs font-bold ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{inr(sumItems(items))}</span>
      </div>
      <div className="space-y-2 mb-2">
        {items.map((it, idx) => (
          <div key={idx} className="flex gap-2 items-center">
            <input
              value={it.label}
              onChange={(e) => update(idx, 'label', e.target.value)}
              placeholder="Component name"
              className={`flex-1 rounded-lg border px-2.5 py-1.5 text-sm ${isDark ? 'bg-slate-950 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'}`}
            />
            <input
              type="number"
              value={it.amount}
              onChange={(e) => update(idx, 'amount', e.target.value)}
              placeholder="0"
              className={`w-32 rounded-lg border px-2.5 py-1.5 text-sm text-right ${isDark ? 'bg-slate-950 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'}`}
            />
            <button onClick={() => remove(idx)} className={`p-1.5 rounded-lg ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}>
              <Trash2 className="h-3.5 w-3.5 text-red-500" />
            </button>
          </div>
        ))}
        {!items.length && <p className={`text-xs italic ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>No components added yet.</p>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {(presets || []).map((p) => (
          <button
            key={p}
            onClick={() => addRow(p)}
            className={`text-xs px-2.5 py-1 rounded-full border ${isDark ? 'border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500' : 'border-slate-300 text-slate-500 hover:text-slate-800 hover:border-slate-400'}`}
          >
            + {p}
          </button>
        ))}
        <button
          onClick={() => addRow('')}
          className="text-xs px-2.5 py-1 rounded-full font-semibold"
          style={{ color: accent }}
        >
          + Custom row
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Add Manual Company modal
 * ═══════════════════════════════════════════════════════════════════════ */

function AddCompanyModal({ isDark, onClose, onCreated }) {
  const [form, setForm] = useState(emptyCompanyForm());
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!form.name.trim()) { toast.error('Company name is required'); return; }
    setSaving(true);
    try {
      const { data } = await api.post('/compliance/salary-slips/manual-companies', form);
      toast.success('Company added');
      onCreated(data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not add company');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell isDark={isDark} onClose={onClose} title="Add Company" icon={Building2}>
      <div className="space-y-3">
        <div>
          <FieldLabel isDark={isDark}>Company Name *</FieldLabel>
          <TextInput isDark={isDark} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </div>
        <div>
          <FieldLabel isDark={isDark}>Address</FieldLabel>
          <TextInput isDark={isDark} value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel isDark={isDark}>City</FieldLabel>
            <TextInput isDark={isDark} value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} />
          </div>
          <div>
            <FieldLabel isDark={isDark}>State</FieldLabel>
            <TextInput isDark={isDark} value={form.state} onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel isDark={isDark}>GSTIN</FieldLabel>
            <TextInput isDark={isDark} value={form.gstin} onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value }))} />
          </div>
          <div>
            <FieldLabel isDark={isDark}>PAN</FieldLabel>
            <TextInput isDark={isDark} value={form.pan} onChange={(e) => setForm((f) => ({ ...f, pan: e.target.value }))} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel isDark={isDark}>Contact Email</FieldLabel>
            <TextInput isDark={isDark} value={form.contact_email} onChange={(e) => setForm((f) => ({ ...f, contact_email: e.target.value }))} />
          </div>
          <div>
            <FieldLabel isDark={isDark}>Contact Phone</FieldLabel>
            <TextInput isDark={isDark} value={form.contact_phone} onChange={(e) => setForm((f) => ({ ...f, contact_phone: e.target.value }))} />
          </div>
        </div>
      </div>
      <button
        onClick={submit}
        disabled={saving}
        className="w-full mt-5 rounded-xl py-2.5 text-sm font-bold text-white flex items-center justify-center gap-2"
        style={{ background: HUB_COLORS.mediumBlue }}
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add Company
      </button>
      <p className={`text-xs mt-3 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
        Use this for companies that aren't in your Clients database yet. You can add a real client from the Clients page any time — it'll show up here automatically.
      </p>
    </ModalShell>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Add / Edit Employee modal
 * ═══════════════════════════════════════════════════════════════════════ */

function EmployeeModal({ isDark, companyKey, presets, editing, onClose, onSaved }) {
  const [form, setForm] = useState(() => editing ? {
    ...emptyEmployeeForm(),
    ...editing,
    default_earnings: editing.default_earnings?.length ? editing.default_earnings : [{ label: 'Basic', amount: 0 }],
    default_deductions: editing.default_deductions || [],
  } : emptyEmployeeForm());
  const [saving, setSaving] = useState(false);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const submit = async () => {
    if (!form.name.trim()) { toast.error('Employee name is required'); return; }
    setSaving(true);
    try {
      const payload = { ...form, company_key: companyKey };
      const { data } = editing
        ? await api.patch(`/compliance/salary-slips/employees/${editing.id}`, payload)
        : await api.post('/compliance/salary-slips/employees', payload);
      toast.success(editing ? 'Employee updated' : 'Employee added');
      onSaved(data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not save employee');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell isDark={isDark} onClose={onClose} title={editing ? 'Edit Employee' : 'Add Employee'} icon={UserPlus} wide>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <FieldLabel isDark={isDark}>Full Name *</FieldLabel>
          <TextInput isDark={isDark} value={form.name} onChange={set('name')} />
        </div>
        <div>
          <FieldLabel isDark={isDark}>Employee Code</FieldLabel>
          <TextInput isDark={isDark} value={form.employee_code} onChange={set('employee_code')} />
        </div>
        <div>
          <FieldLabel isDark={isDark}>Designation</FieldLabel>
          <TextInput isDark={isDark} value={form.designation} onChange={set('designation')} />
        </div>
        <div>
          <FieldLabel isDark={isDark}>Department</FieldLabel>
          <TextInput isDark={isDark} value={form.department} onChange={set('department')} />
        </div>
        <div>
          <FieldLabel isDark={isDark}>Date of Joining</FieldLabel>
          <TextInput isDark={isDark} type="date" value={form.date_of_joining || ''} onChange={set('date_of_joining')} />
        </div>
        <div>
          <FieldLabel isDark={isDark}>Status</FieldLabel>
          <SelectInput isDark={isDark} value={form.status} onChange={set('status')}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </SelectInput>
        </div>
        <div>
          <FieldLabel isDark={isDark}>PAN</FieldLabel>
          <TextInput isDark={isDark} value={form.pan} onChange={set('pan')} />
        </div>
        <div>
          <FieldLabel isDark={isDark}>UAN</FieldLabel>
          <TextInput isDark={isDark} value={form.uan} onChange={set('uan')} />
        </div>
        <div>
          <FieldLabel isDark={isDark}>PF Number</FieldLabel>
          <TextInput isDark={isDark} value={form.pf_number} onChange={set('pf_number')} />
        </div>
        <div>
          <FieldLabel isDark={isDark}>ESIC Number</FieldLabel>
          <TextInput isDark={isDark} value={form.esic_number} onChange={set('esic_number')} />
        </div>
        <div>
          <FieldLabel isDark={isDark}>Bank Name</FieldLabel>
          <TextInput isDark={isDark} value={form.bank_name} onChange={set('bank_name')} />
        </div>
        <div>
          <FieldLabel isDark={isDark}>Bank A/c No.</FieldLabel>
          <TextInput isDark={isDark} value={form.bank_account} onChange={set('bank_account')} />
        </div>
        <div>
          <FieldLabel isDark={isDark}>IFSC</FieldLabel>
          <TextInput isDark={isDark} value={form.ifsc} onChange={set('ifsc')} />
        </div>
        <div>
          <FieldLabel isDark={isDark}>Email</FieldLabel>
          <TextInput isDark={isDark} type="email" value={form.email} onChange={set('email')} />
        </div>
        <div>
          <FieldLabel isDark={isDark}>Phone</FieldLabel>
          <TextInput isDark={isDark} value={form.phone} onChange={set('phone')} />
        </div>
      </div>

      <div className={`rounded-xl border p-3 mb-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <LineItemsEditor
          title="Default Earnings (used to pre-fill payslips)"
          items={form.default_earnings}
          setItems={(fn) => setForm((f) => ({ ...f, default_earnings: typeof fn === 'function' ? fn(f.default_earnings) : fn }))}
          presets={presets.earning_presets}
          isDark={isDark}
          accent={HUB_COLORS.mediumBlue}
        />
      </div>
      <div className={`rounded-xl border p-3 mb-4 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <LineItemsEditor
          title="Default Deductions"
          items={form.default_deductions}
          setItems={(fn) => setForm((f) => ({ ...f, default_deductions: typeof fn === 'function' ? fn(f.default_deductions) : fn }))}
          presets={presets.deduction_presets}
          isDark={isDark}
          accent={HUB_COLORS.mediumBlue}
        />
      </div>

      <button
        onClick={submit}
        disabled={saving}
        className="w-full rounded-xl py-2.5 text-sm font-bold text-white flex items-center justify-center gap-2"
        style={{ background: HUB_COLORS.emeraldGreen }}
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} {editing ? 'Save Changes' : 'Add Employee'}
      </button>
    </ModalShell>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Import Employees from Excel modal (Employees tab)
 * ═══════════════════════════════════════════════════════════════════════ */

function ImportEmployeesModal({ isDark, companyKey, companyName, onClose, onImported }) {
  const fileInputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [preview, setPreview] = useState(null); // { rows, total_rows, new_count, update_count, error_count }
  const [skipUpdates, setSkipUpdates] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null); // { created_count, updated_count, skipped_count, skipped }

  const downloadTemplate = async () => {
    try {
      const res = await api.get('/compliance/salary-slips/employees/import-template', { responseType: 'blob' });
      triggerBlobDownload(res.data, 'Employee_Import_Template.xlsx');
    } catch (e) {
      toast.error(await parseBlobError(e));
    }
  };

  const pickFile = () => fileInputRef.current?.click();

  const handleFile = async (f) => {
    if (!f) return;
    setFile(f);
    setPreview(null);
    setResult(null);
    setLoadingPreview(true);
    try {
      const fd = new FormData();
      fd.append('company_key', companyKey);
      fd.append('file', f);
      const { data } = await api.post('/compliance/salary-slips/employees/import-preview', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setPreview(data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not read that file');
      setFile(null);
    } finally {
      setLoadingPreview(false);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  };

  const confirmImport = async () => {
    if (!file) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append('company_key', companyKey);
      fd.append('file', file);
      fd.append('skip_updates', skipUpdates ? 'true' : 'false');
      const { data } = await api.post('/compliance/salary-slips/employees/import', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult(data);
      toast.success(`${data.created_count} added, ${data.updated_count} updated${data.skipped_count ? `, ${data.skipped_count} skipped` : ''}`);
      onImported();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const reset = () => { setFile(null); setPreview(null); setResult(null); };

  return (
    <ModalShell isDark={isDark} onClose={onClose} title={`Import Employees${companyName ? ` — ${companyName}` : ''}`} icon={FileSpreadsheet} wide>
      {result ? (
        <div className="space-y-3">
          <div className={`rounded-xl p-4 ${isDark ? 'bg-emerald-950/40 border border-emerald-900' : 'bg-emerald-50 border border-emerald-200'}`}>
            <p className={`text-sm font-bold flex items-center gap-1.5 ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
              <CheckCircle2 className="h-4 w-4" /> Import complete
            </p>
            <p className={`text-xs mt-1 ${isDark ? 'text-emerald-400/80' : 'text-emerald-700/80'}`}>
              {result.created_count} employee{result.created_count === 1 ? '' : 's'} added, {result.updated_count} updated
              {result.skipped_count ? `, ${result.skipped_count} skipped` : ''}.
            </p>
          </div>
          {result.skipped_count > 0 && (
            <div className={`rounded-xl border p-3 text-xs max-h-40 overflow-y-auto ${isDark ? 'border-slate-800 text-slate-400' : 'border-slate-200 text-slate-500'}`}>
              {result.skipped.map((s, i) => (
                <p key={i}>Row {s.row}{s.name ? ` (${s.name})` : ''}: {s.reason}</p>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={reset} className={`flex-1 rounded-xl py-2.5 text-sm font-semibold border ${isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
              Import another file
            </button>
            <button onClick={onClose} className="flex-1 rounded-xl py-2.5 text-sm font-bold text-white" style={{ background: HUB_COLORS.mediumBlue }}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className={`rounded-xl border p-3 flex items-center justify-between gap-3 ${isDark ? 'border-slate-800 bg-slate-950' : 'border-slate-200 bg-slate-50'}`}>
            <div>
              <p className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>1. Get the template</p>
              <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Fill it with all the company's employees, then upload it below.</p>
            </div>
            <button onClick={downloadTemplate} className={`shrink-0 rounded-lg px-3 py-2 text-xs font-semibold flex items-center gap-1.5 border ${isDark ? 'border-slate-700 text-slate-200 hover:bg-slate-800' : 'border-slate-300 text-slate-700 hover:bg-white'}`}>
              <Download className="h-3.5 w-3.5" /> Download template
            </button>
          </div>

          <div>
            <p className={`text-sm font-semibold mb-2 ${isDark ? 'text-white' : 'text-slate-900'}`}>2. Upload the filled file</p>
            <div
              onClick={pickFile}
              onDrop={onDrop}
              onDragOver={(e) => e.preventDefault()}
              className={`rounded-xl border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${isDark ? 'border-slate-700 hover:border-slate-600 bg-slate-950' : 'border-slate-300 hover:border-slate-400 bg-slate-50'}`}
            >
              <input
                ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
              <Upload className={`h-6 w-6 mx-auto mb-2 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
              {file ? (
                <p className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{file.name}</p>
              ) : (
                <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Click to browse or drag a .xlsx / .csv file here</p>
              )}
            </div>
          </div>

          {loadingPreview && (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>
          )}

          {preview && (
            <div>
              <div className="flex items-center gap-3 mb-2 text-xs">
                <span className={`font-bold ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>{preview.new_count} new</span>
                <span className={`font-bold ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>{preview.update_count} to update</span>
                {preview.error_count > 0 && (
                  <span className={`font-bold flex items-center gap-1 ${isDark ? 'text-red-400' : 'text-red-600'}`}>
                    <AlertTriangle className="h-3.5 w-3.5" /> {preview.error_count} skipped
                  </span>
                )}
              </div>
              <div className={`rounded-xl border max-h-56 overflow-y-auto ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                <table className="w-full text-xs">
                  <thead className={`sticky top-0 ${isDark ? 'bg-slate-900' : 'bg-white'}`}>
                    <tr className={`text-left border-b ${isDark ? 'border-slate-800 text-slate-400' : 'border-slate-200 text-slate-500'}`}>
                      <th className="py-1.5 px-2 font-semibold">Row</th>
                      <th className="py-1.5 px-2 font-semibold">Name</th>
                      <th className="py-1.5 px-2 font-semibold">Code</th>
                      <th className="py-1.5 px-2 font-semibold text-right">Gross</th>
                      <th className="py-1.5 px-2 font-semibold">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.row} className={`border-b last:border-0 ${isDark ? 'border-slate-800/60 text-slate-300' : 'border-slate-100 text-slate-600'}`}>
                        <td className="py-1.5 px-2">{r.row}</td>
                        <td className="py-1.5 px-2">{r.name || '—'}</td>
                        <td className="py-1.5 px-2">{r.employee_code || '—'}</td>
                        <td className="py-1.5 px-2 text-right">{r.gross ? inr(r.gross) : '—'}</td>
                        <td className="py-1.5 px-2">
                          {r.status === 'error' ? (
                            <span className={isDark ? 'text-red-400' : 'text-red-600'}>{r.reason}</span>
                          ) : r.status === 'update' ? (
                            <span className={isDark ? 'text-amber-400' : 'text-amber-600'}>Update existing</span>
                          ) : (
                            <span className={isDark ? 'text-emerald-400' : 'text-emerald-600'}>New employee</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {preview.update_count > 0 && (
                <label className={`flex items-center gap-2 mt-3 text-xs cursor-pointer ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  <input type="checkbox" checked={skipUpdates} onChange={(e) => setSkipUpdates(e.target.checked)} />
                  Skip employees that already exist — only add new ones
                </label>
              )}

              <button
                onClick={confirmImport}
                disabled={importing || !preview.rows.length}
                className="w-full mt-4 rounded-xl py-2.5 text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
                style={{ background: HUB_COLORS.mediumBlue }}
              >
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Import {preview.new_count + (skipUpdates ? 0 : preview.update_count)} Employee{(preview.new_count + (skipUpdates ? 0 : preview.update_count)) === 1 ? '' : 's'}
              </button>
            </div>
          )}
        </div>
      )}
    </ModalShell>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Edit Slip modal (History tab)
 * ═══════════════════════════════════════════════════════════════════════ */

function EditSlipModal({ isDark, slip, presets, onClose, onSaved }) {
  const [earnings, setEarnings] = useState(slip.earnings || []);
  const [deductions, setDeductions] = useState(slip.deductions || []);
  const [paidDays, setPaidDays] = useState(slip.paid_days ?? 30);
  const [lopDays, setLopDays] = useState(slip.lop_days ?? 0);
  const [totalDays, setTotalDays] = useState(slip.total_days ?? 30);
  const [payDate, setPayDate] = useState(slip.pay_date || '');
  const [status, setStatus] = useState(slip.status || 'final');
  const [notes, setNotes] = useState(slip.notes || '');
  const [saving, setSaving] = useState(false);

  const net = sumItems(earnings) - sumItems(deductions);

  const submit = async () => {
    setSaving(true);
    try {
      const { data } = await api.patch(`/compliance/salary-slips/${slip.id}`, {
        earnings, deductions, paid_days: parseFloat(paidDays) || 0, lop_days: parseFloat(lopDays) || 0,
        total_days: parseFloat(totalDays) || 0, pay_date: payDate || null, status, notes,
      });
      toast.success('Payslip updated');
      onSaved(data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not update payslip');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell isDark={isDark} onClose={onClose} title={`Edit — ${slip.employee_name} · ${slip.period_label}`} icon={Pencil} wide>
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div>
          <FieldLabel isDark={isDark}>Total Days</FieldLabel>
          <TextInput isDark={isDark} type="number" value={totalDays} onChange={(e) => setTotalDays(e.target.value)} />
        </div>
        <div>
          <FieldLabel isDark={isDark}>Paid Days</FieldLabel>
          <TextInput isDark={isDark} type="number" value={paidDays} onChange={(e) => setPaidDays(e.target.value)} />
        </div>
        <div>
          <FieldLabel isDark={isDark}>LOP Days</FieldLabel>
          <TextInput isDark={isDark} type="number" value={lopDays} onChange={(e) => setLopDays(e.target.value)} />
        </div>
        <div>
          <FieldLabel isDark={isDark}>Pay Date</FieldLabel>
          <TextInput isDark={isDark} type="date" value={payDate || ''} onChange={(e) => setPayDate(e.target.value)} />
        </div>
        <div className="col-span-2">
          <FieldLabel isDark={isDark}>Status</FieldLabel>
          <SelectInput isDark={isDark} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="draft">Draft</option>
            <option value="final">Final</option>
          </SelectInput>
        </div>
      </div>

      <div className={`rounded-xl border p-3 mb-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <LineItemsEditor title="Earnings" items={earnings} setItems={setEarnings} presets={presets.earning_presets} isDark={isDark} accent={HUB_COLORS.mediumBlue} />
      </div>
      <div className={`rounded-xl border p-3 mb-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <LineItemsEditor title="Deductions" items={deductions} setItems={setDeductions} presets={presets.deduction_presets} isDark={isDark} accent={HUB_COLORS.mediumBlue} />
      </div>

      <div>
        <FieldLabel isDark={isDark}>Notes</FieldLabel>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className={`w-full rounded-lg border px-3 py-2 text-sm mb-4 ${isDark ? 'bg-slate-950 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'}`}
        />
      </div>

      <div className={`rounded-xl p-3 mb-4 flex items-center justify-between ${isDark ? 'bg-emerald-950/40 border border-emerald-900' : 'bg-emerald-50 border border-emerald-200'}`}>
        <span className={`text-xs font-bold uppercase ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>Net Pay</span>
        <span className={`text-lg font-extrabold ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>{inr(net)}</span>
      </div>

      <button
        onClick={submit}
        disabled={saving}
        className="w-full rounded-xl py-2.5 text-sm font-bold text-white flex items-center justify-center gap-2"
        style={{ background: HUB_COLORS.emeraldGreen }}
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Changes
      </button>
    </ModalShell>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Main page
 * ═══════════════════════════════════════════════════════════════════════ */

const TABS = [
  { key: 'generate', label: 'Generate Payslip', icon: Receipt },
  { key: 'employees', label: 'Employees', icon: UsersIcon },
  { key: 'history', label: 'History', icon: ClipboardList },
];

export default function SalarySlips() {
  const isDark = useDark();
  const { user, hasPermission } = useAuth();
  const canManage = user?.role === 'admin' || hasPermission('can_manage_salary_slips');

  const [tab, setTab] = useState('generate');
  const [summary, setSummary] = useState(null);
  const [presets, setPresets] = useState({ earning_presets: [], deduction_presets: [] });

  /* ── companies (clients + manual) ─────────────────────────────────── */
  const [clients, setClients] = useState([]);
  const [manualCompanies, setManualCompanies] = useState([]);
  const [companyKey, setCompanyKey] = useState('');
  const [showAddCompany, setShowAddCompany] = useState(false);

  const companies = useMemo(() => {
    const fromClients = clients.map((c) => ({
      key: `client:${c.id}`, name: c.company_name, source: 'client',
    }));
    const fromManual = manualCompanies.map((c) => ({
      key: `manual:${c.id}`, name: c.name, source: 'manual',
    }));
    return [...fromClients, ...fromManual].sort((a, b) => a.name.localeCompare(b.name));
  }, [clients, manualCompanies]);

  const fetchClients = useCallback(async () => {
    try {
      const PAGE_SIZE = 500;
      let page = 1;
      let all = [];
      // /clients paginates (default page_size=100) — loop until a short page tells us we're done
      // so firms with 100+ clients aren't silently truncated in this dropdown.
      while (true) {
        const r = await api.get('/clients', { params: { page, page_size: PAGE_SIZE } });
        const list = Array.isArray(r.data) ? r.data : (r.data?.items || r.data?.data || []);
        all = all.concat(list);
        if (list.length < PAGE_SIZE) break;
        page += 1;
      }
      setClients(all);
    } catch { /* silent — Add Company still works */ }
  }, []);

  const fetchManualCompanies = useCallback(async () => {
    try {
      const { data } = await api.get('/compliance/salary-slips/manual-companies');
      setManualCompanies(data || []);
    } catch { /* ignore */ }
  }, []);

  const fetchSummary = useCallback(async () => {
    try {
      const { data } = await api.get('/compliance/salary-slips/dashboard-summary');
      setSummary(data);
    } catch { /* ignore */ }
  }, []);

  const fetchPresets = useCallback(async () => {
    try {
      const { data } = await api.get('/compliance/salary-slips/meta/presets');
      setPresets(data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchClients(); fetchManualCompanies(); fetchSummary(); fetchPresets(); }, [fetchClients, fetchManualCompanies, fetchSummary, fetchPresets]);
  useEffect(() => { if (!companyKey && companies.length) setCompanyKey(companies[0].key); }, [companies]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── employees for the selected company ───────────────────────────── */
  const [employees, setEmployees] = useState([]);
  const [loadingEmployees, setLoadingEmployees] = useState(false);
  const [showEmployeeModal, setShowEmployeeModal] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState(null);
  const [showImportModal, setShowImportModal] = useState(false);

  const fetchEmployees = useCallback(async (key) => {
    if (!key) { setEmployees([]); return; }
    setLoadingEmployees(true);
    try {
      const { data } = await api.get('/compliance/salary-slips/employees', { params: { company_key: key } });
      setEmployees(data || []);
    } catch {
      toast.error('Could not load employees for this company');
    } finally {
      setLoadingEmployees(false);
    }
  }, []);

  useEffect(() => { fetchEmployees(companyKey); }, [companyKey, fetchEmployees]);

  const deleteEmployee = async (emp) => {
    if (!window.confirm(`Remove ${emp.name} from the employee list? Previously generated payslips are kept.`)) return;
    try {
      await api.delete(`/compliance/salary-slips/employees/${emp.id}`);
      toast.success('Employee removed');
      fetchEmployees(companyKey);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not remove employee');
    }
  };

  /* ── Generate tab state ───────────────────────────────────────────── */
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkEmployeeScope, setBulkEmployeeScope] = useState('all'); // 'all' | 'specific'
  const [bulkEmployeeIds, setBulkEmployeeIds] = useState([]);
  const [multiMonth, setMultiMonth] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [genMonth, setGenMonth] = useState(now.getMonth() + 1);
  const [genYear, setGenYear] = useState(now.getFullYear());
  const [genMonthTo, setGenMonthTo] = useState(now.getMonth() + 1);
  const [genYearTo, setGenYearTo] = useState(now.getFullYear());
  const [payDate, setPayDate] = useState('');
  const [totalDays, setTotalDays] = useState(30);
  const [paidDays, setPaidDays] = useState(30);
  const [lopDays, setLopDays] = useState(0);
  const [earnings, setEarnings] = useState([{ label: 'Basic', amount: 0 }]);
  const [deductions, setDeductions] = useState([]);
  const [template, setTemplate] = useState('modern');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState('final');
  const [generating, setGenerating] = useState(false);
  const [lastGenerated, setLastGenerated] = useState(null);

  useEffect(() => {
    if (bulkMode) return;
    const emp = employees.find((e) => e.id === employeeId);
    if (emp) {
      setEarnings(emp.default_earnings?.length ? emp.default_earnings : [{ label: 'Basic', amount: 0 }]);
      setDeductions(emp.default_deductions || []);
    }
  }, [employeeId, bulkMode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setEmployeeId(''); setLastGenerated(null); setBulkEmployeeIds([]); }, [companyKey]);

  const toggleBulkEmployee = (id) => {
    setBulkEmployeeIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const grossPreview = sumItems(earnings);
  const dedPreview = sumItems(deductions);
  const netPreview = grossPreview - dedPreview;

  const handleGenerate = async () => {
    if (!employeeId) { toast.error('Select an employee first'); return; }
    if (!earnings.filter((e) => e.label?.trim()).length) { toast.error('Add at least one earnings component'); return; }
    setGenerating(true);
    try {
      const { data } = await api.post('/compliance/salary-slips/generate', {
        employee_id: employeeId, month: Number(genMonth), year: Number(genYear),
        pay_date: payDate || null, total_days: Number(totalDays), paid_days: Number(paidDays),
        lop_days: Number(lopDays), earnings, deductions, template, notes, status,
      });
      toast.success(`Payslip generated — ${data.slip_no}`);
      setLastGenerated(data);
      fetchSummary();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not generate payslip');
    } finally {
      setGenerating(false);
    }
  };

  const [bulkGenerating, setBulkGenerating] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);

  const handleBulkGenerate = async () => {
    if (!companyKey) { toast.error('Select a company first'); return; }
    if (bulkEmployeeScope === 'specific' && !bulkEmployeeIds.length) {
      toast.error('Select at least one employee, or switch back to "All active employees"');
      return;
    }

    const payload = {
      company_key: companyKey,
      pay_date: payDate || null, total_days: Number(totalDays), paid_days: Number(paidDays),
      lop_days: Number(lopDays), template, status,
    };

    if (multiMonth) {
      const periods = buildPeriodRange(genMonth, genYear, genMonthTo, genYearTo);
      if (!periods.length) { toast.error('"To" period must be the same as or after "From"'); return; }
      if (periods.length > MAX_BULK_PERIODS) { toast.error(`Choose a range of ${MAX_BULK_PERIODS} months or fewer at a time`); return; }
      payload.periods = periods;
    } else {
      payload.month = Number(genMonth);
      payload.year = Number(genYear);
    }

    if (bulkEmployeeScope === 'specific') payload.employee_ids = bulkEmployeeIds;

    setBulkGenerating(true);
    setBulkResult(null);
    try {
      const { data } = await api.post('/compliance/salary-slips/bulk-generate', payload);
      setBulkResult(data);
      const periodNote = data.periods_count > 1 ? ` across ${data.periods_count} months` : '';
      toast.success(`${data.generated_count} payslip(s) generated${periodNote}${data.skipped_count ? `, ${data.skipped_count} skipped` : ''}`);
      fetchSummary();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Bulk generation failed');
    } finally {
      setBulkGenerating(false);
    }
  };

  const downloadSlipPdf = async (slipId, employeeName, periodLabel) => {
    try {
      const res = await api.get(`/compliance/salary-slips/${slipId}/pdf`, { responseType: 'blob' });
      triggerBlobDownload(res.data, `${(employeeName || 'payslip').replace(/\s+/g, '_')}_${(periodLabel || '').replace(/\s+/g, '_')}.pdf`);
    } catch (e) {
      toast.error(await parseBlobError(e));
    }
  };

  /* ── History tab state ────────────────────────────────────────────── */
  const [historyItems, setHistoryItems] = useState([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyFilters, setHistoryFilters] = useState({ company_key: '', month: '', year: '', status: '', search: '' });
  const [selectedIds, setSelectedIds] = useState([]);
  const [editingSlip, setEditingSlip] = useState(null);
  const pageSize = 20;

  const fetchHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const params = { page: historyPage, page_size: pageSize };
      if (historyFilters.company_key) params.company_key = historyFilters.company_key;
      if (historyFilters.month) params.month = historyFilters.month;
      if (historyFilters.year) params.year = historyFilters.year;
      if (historyFilters.status) params.status = historyFilters.status;
      if (historyFilters.search) params.search = historyFilters.search;
      const { data } = await api.get('/compliance/salary-slips', { params });
      setHistoryItems(data.items || []);
      setHistoryTotal(data.total || 0);
    } catch {
      toast.error('Could not load payslip history');
    } finally {
      setLoadingHistory(false);
    }
  }, [historyPage, historyFilters]);

  useEffect(() => { if (tab === 'history') fetchHistory(); }, [tab, fetchHistory]);

  const toggleSelect = (id) => setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);

  const deleteSlip = async (id) => {
    if (!window.confirm('Delete this payslip permanently?')) return;
    try {
      await api.delete(`/compliance/salary-slips/${id}`);
      toast.success('Payslip deleted');
      fetchHistory(); fetchSummary();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not delete payslip');
    }
  };

  const duplicateToNextMonth = async (slip) => {
    const nextMonth = slip.slip_month === 12 ? 1 : slip.slip_month + 1;
    const nextYear = slip.slip_month === 12 ? slip.slip_year + 1 : slip.slip_year;
    try {
      await api.post(`/compliance/salary-slips/${slip.id}/duplicate`, { month: nextMonth, year: nextYear });
      toast.success(`Duplicated to ${MONTHS[nextMonth]} ${nextYear} as a draft`);
      fetchHistory(); fetchSummary();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not duplicate payslip');
    }
  };

  const downloadBulkPdf = async () => {
    if (!selectedIds.length) return;
    try {
      const res = await api.post('/compliance/salary-slips/bulk-pdf', { slip_ids: selectedIds }, { responseType: 'blob' });
      triggerBlobDownload(res.data, `Payslips_${selectedIds.length}.pdf`);
    } catch (e) {
      toast.error(await parseBlobError(e));
    }
  };

  /* ═══════════════════════════════════════════════════════════════════ */
  return (
    <div>
      <HubBanner
        icon={Receipt}
        eyebrow="Compliance · Payroll for Client Companies"
        title="Salary Slip Generator"
        subtitle="Generate payslips for your client companies' employees — pull employees straight from your Clients database, or add a company that isn't in there yet."
        isDark={isDark}
        stats={[
          { label: 'Employees', value: summary?.total_employees ?? '—' },
          { label: 'Slips this month', value: summary?.slips_this_month ?? '—' },
          { label: 'Companies covered', value: (summary?.companies_covered ?? 0) },
          { label: 'Total slips', value: summary?.total_slips ?? '—' },
        ]}
      />

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 mb-5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold transition-colors ${
              tab === t.key ? 'text-white' : isDark ? 'bg-slate-900/60 text-slate-400 border border-slate-800 hover:text-slate-200' : 'bg-white text-slate-500 border border-slate-200 hover:text-slate-700'
            }`}
            style={tab === t.key ? { background: HUB_COLORS.mediumBlue } : {}}
          >
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>

      {/* Company picker — shared across all three tabs */}
      <Card isDark={isDark} className="mb-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[260px] flex-1">
            <FieldLabel isDark={isDark}>Company</FieldLabel>
            <div className="flex gap-2">
              <SearchableSelect
                isDark={isDark}
                value={companyKey}
                onChange={(key) => setCompanyKey(key)}
                placeholder={companies.length ? 'Select a company…' : 'No companies yet'}
                emptyText="No companies match"
                options={companies.map((c) => ({
                  value: c.key,
                  label: c.name + (c.source === 'manual' ? ' (manual)' : ''),
                }))}
              />
              {canManage && (
                <button
                  onClick={() => setShowAddCompany(true)}
                  className="rounded-xl px-3 py-2.5 text-sm font-semibold text-white flex items-center gap-1.5 shrink-0"
                  style={{ background: HUB_COLORS.mediumBlue }}
                >
                  <Plus className="h-4 w-4" /> Add Company
                </button>
              )}
            </div>
          </div>
          <p className={`text-xs max-w-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Companies come from your Clients database automatically. Use "Add Company" only for one that isn't a client yet.
          </p>
        </div>
      </Card>

      {/* ── GENERATE TAB ─────────────────────────────────────────────── */}
      {tab === 'generate' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2 space-y-5">
            <Card isDark={isDark}>
              <div className="flex items-center justify-between mb-4">
                <p className={`text-sm font-extrabold ${isDark ? 'text-white' : 'text-slate-900'}`}>Who is this payslip for?</p>
                <button
                  onClick={() => setBulkMode((b) => !b)}
                  className={`flex items-center gap-1.5 text-xs font-semibold ${isDark ? 'text-slate-300' : 'text-slate-600'}`}
                >
                  {bulkMode ? <ToggleRight className="h-5 w-5" style={{ color: HUB_COLORS.mediumBlue }} /> : <ToggleLeft className="h-5 w-5" />}
                  Bulk generate (multiple employees)
                </button>
              </div>

              {!bulkMode ? (
                <div className="flex gap-2">
                  <SelectInput isDark={isDark} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                    <option value="">{loadingEmployees ? 'Loading…' : 'Select an employee'}</option>
                    {employees.map((e) => (
                      <option key={e.id} value={e.id}>{e.name}{e.employee_code ? ` (${e.employee_code})` : ''}</option>
                    ))}
                  </SelectInput>
                  {canManage && (
                    <button
                      onClick={() => { setEditingEmployee(null); setShowEmployeeModal(true); }}
                      className={`rounded-xl px-3 py-2.5 text-sm font-semibold flex items-center gap-1.5 shrink-0 border ${isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}
                    >
                      <UserPlus className="h-4 w-4" /> New
                    </button>
                  )}
                </div>
              ) : (
                <div>
                  <div className="flex gap-2 mb-3">
                    <button
                      onClick={() => setBulkEmployeeScope('all')}
                      className={`flex-1 rounded-xl border px-3 py-2 text-xs font-semibold ${
                        bulkEmployeeScope === 'all'
                          ? isDark ? 'border-blue-500 bg-blue-950/30 text-white' : 'border-blue-400 bg-blue-50 text-slate-900'
                          : isDark ? 'border-slate-800 text-slate-400' : 'border-slate-200 text-slate-500'
                      }`}
                    >
                      All active employees
                    </button>
                    <button
                      onClick={() => setBulkEmployeeScope('specific')}
                      className={`flex-1 rounded-xl border px-3 py-2 text-xs font-semibold ${
                        bulkEmployeeScope === 'specific'
                          ? isDark ? 'border-blue-500 bg-blue-950/30 text-white' : 'border-blue-400 bg-blue-50 text-slate-900'
                          : isDark ? 'border-slate-800 text-slate-400' : 'border-slate-200 text-slate-500'
                      }`}
                    >
                      Choose specific employees
                    </button>
                  </div>

                  {bulkEmployeeScope === 'all' ? (
                    <p className={`text-xs rounded-xl p-3 ${isDark ? 'bg-slate-950 text-slate-400' : 'bg-slate-50 text-slate-500'}`}>
                      Generates one payslip for every <b>active</b> employee under this company, using each employee's saved default earnings/deductions for the period below.
                    </p>
                  ) : (
                    <div className={`rounded-xl border ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                      <div className={`flex items-center justify-between px-3 py-2 text-xs border-b ${isDark ? 'border-slate-800 text-slate-400' : 'border-slate-200 text-slate-500'}`}>
                        <span>{bulkEmployeeIds.length} of {employees.length} selected</span>
                        <div className="flex gap-3">
                          <button onClick={() => setBulkEmployeeIds(employees.map((e) => e.id))} className="font-semibold" style={{ color: HUB_COLORS.mediumBlue }}>Select all</button>
                          <button onClick={() => setBulkEmployeeIds([])} className="font-semibold">Clear</button>
                        </div>
                      </div>
                      <div className="max-h-56 overflow-y-auto p-2 space-y-1">
                        {loadingEmployees ? (
                          <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-slate-400" /></div>
                        ) : !employees.length ? (
                          <p className={`text-xs text-center py-4 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>No employees for this company yet.</p>
                        ) : employees.map((e) => (
                          <label key={e.id} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm cursor-pointer ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-50'}`}>
                            <input type="checkbox" checked={bulkEmployeeIds.includes(e.id)} onChange={() => toggleBulkEmployee(e.id)} />
                            <span className={isDark ? 'text-slate-200' : 'text-slate-700'}>{e.name}{e.employee_code ? ` (${e.employee_code})` : ''}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Card>

            <Card isDark={isDark}>
              <div className="flex items-center justify-between mb-4">
                <p className={`text-sm font-extrabold ${isDark ? 'text-white' : 'text-slate-900'}`}>Pay period</p>
                {bulkMode && (
                  <button
                    onClick={() => setMultiMonth((m) => !m)}
                    className={`flex items-center gap-1.5 text-xs font-semibold ${isDark ? 'text-slate-300' : 'text-slate-600'}`}
                  >
                    {multiMonth ? <ToggleRight className="h-5 w-5" style={{ color: HUB_COLORS.mediumBlue }} /> : <ToggleLeft className="h-5 w-5" />}
                    Multiple months
                  </button>
                )}
              </div>

              {bulkMode && multiMonth ? (
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                    <p className={`text-xs font-bold uppercase tracking-wide mb-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>From</p>
                    <div className="grid grid-cols-2 gap-2">
                      <SelectInput isDark={isDark} value={genMonth} onChange={(e) => setGenMonth(e.target.value)}>
                        {MONTHS.slice(1).map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                      </SelectInput>
                      <TextInput isDark={isDark} type="number" value={genYear} onChange={(e) => setGenYear(e.target.value)} />
                    </div>
                  </div>
                  <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                    <p className={`text-xs font-bold uppercase tracking-wide mb-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>To</p>
                    <div className="grid grid-cols-2 gap-2">
                      <SelectInput isDark={isDark} value={genMonthTo} onChange={(e) => setGenMonthTo(e.target.value)}>
                        {MONTHS.slice(1).map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                      </SelectInput>
                      <TextInput isDark={isDark} type="number" value={genYearTo} onChange={(e) => setGenYearTo(e.target.value)} />
                    </div>
                  </div>
                  <p className={`col-span-2 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {(() => {
                      const n = buildPeriodRange(genMonth, genYear, genMonthTo, genYearTo).length;
                      if (!n) return 'Pick a "To" period on or after "From".';
                      if (n > MAX_BULK_PERIODS) return `That's ${n} months — please narrow it to ${MAX_BULK_PERIODS} or fewer.`;
                      return `Will generate for ${n} month${n > 1 ? 's' : ''} per employee.`;
                    })()}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <FieldLabel isDark={isDark}>Month</FieldLabel>
                    <SelectInput isDark={isDark} value={genMonth} onChange={(e) => setGenMonth(e.target.value)}>
                      {MONTHS.slice(1).map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                    </SelectInput>
                  </div>
                  <div>
                    <FieldLabel isDark={isDark}>Year</FieldLabel>
                    <TextInput isDark={isDark} type="number" value={genYear} onChange={(e) => setGenYear(e.target.value)} />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div>
                  <FieldLabel isDark={isDark}>Pay Date</FieldLabel>
                  <TextInput isDark={isDark} type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                </div>
                <div>
                  <FieldLabel isDark={isDark}>Total Days</FieldLabel>
                  <TextInput isDark={isDark} type="number" value={totalDays} onChange={(e) => setTotalDays(e.target.value)} />
                </div>
                <div>
                  <FieldLabel isDark={isDark}>Paid Days</FieldLabel>
                  <TextInput isDark={isDark} type="number" value={paidDays} onChange={(e) => setPaidDays(e.target.value)} />
                </div>
                <div>
                  <FieldLabel isDark={isDark}>LOP Days</FieldLabel>
                  <TextInput isDark={isDark} type="number" value={lopDays} onChange={(e) => setLopDays(e.target.value)} />
                </div>
              </div>
              {bulkMode && multiMonth && (
                <p className={`text-xs mt-2 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  Pay Date / Total / Paid / LOP days apply the same to every month in the range — edit individual slips afterward if any month needs different figures.
                </p>
              )}
            </Card>

            {!bulkMode && (
              <Card isDark={isDark}>
                <div className={`rounded-xl border p-3 mb-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                  <LineItemsEditor title="Earnings" items={earnings} setItems={setEarnings} presets={presets.earning_presets} isDark={isDark} accent={HUB_COLORS.mediumBlue} />
                </div>
                <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                  <LineItemsEditor title="Deductions" items={deductions} setItems={setDeductions} presets={presets.deduction_presets} isDark={isDark} accent={HUB_COLORS.mediumBlue} />
                </div>
              </Card>
            )}

            <Card isDark={isDark}>
              <p className={`text-sm font-extrabold mb-3 ${isDark ? 'text-white' : 'text-slate-900'}`}>Template & notes</p>
              <div className="grid grid-cols-2 gap-3 mb-3">
                {[
                  { key: 'modern', label: 'Modern', hint: 'Net-pay highlight card, no signature needed' },
                  { key: 'classic', label: 'Classic', hint: 'Boxed table layout with signature lines' },
                ].map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setTemplate(t.key)}
                    className={`text-left rounded-xl border p-3 transition-colors ${
                      template === t.key
                        ? isDark ? 'border-blue-500 bg-blue-950/30' : 'border-blue-400 bg-blue-50'
                        : isDark ? 'border-slate-800' : 'border-slate-200'
                    }`}
                  >
                    <p className={`text-sm font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>{t.label}</p>
                    <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{t.hint}</p>
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <FieldLabel isDark={isDark}>Status</FieldLabel>
                  <SelectInput isDark={isDark} value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="final">Final</option>
                    <option value="draft">Draft</option>
                  </SelectInput>
                </div>
              </div>
              {!bulkMode && (
                <div className="mt-3">
                  <FieldLabel isDark={isDark}>Notes (optional, shown on the payslip)</FieldLabel>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={2}
                    className={`w-full rounded-lg border px-3 py-2 text-sm ${isDark ? 'bg-slate-950 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'}`}
                  />
                </div>
              )}
            </Card>
          </div>

          {/* Right rail: preview + generate button */}
          <div className="space-y-5">
            {!bulkMode && (
              <Card isDark={isDark}>
                <p className={`text-xs font-bold uppercase tracking-wide mb-3 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Live Preview</p>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between"><span className={isDark ? 'text-slate-400' : 'text-slate-500'}>Gross Earnings</span><span className={`font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{inr(grossPreview)}</span></div>
                  <div className="flex justify-between"><span className={isDark ? 'text-slate-400' : 'text-slate-500'}>Total Deductions</span><span className={`font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{inr(dedPreview)}</span></div>
                </div>
                <div className={`mt-3 rounded-xl p-3 flex items-center justify-between ${isDark ? 'bg-emerald-950/40 border border-emerald-900' : 'bg-emerald-50 border border-emerald-200'}`}>
                  <span className={`text-xs font-bold uppercase ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>Net Pay</span>
                  <span className={`text-lg font-extrabold ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>{inr(netPreview)}</span>
                </div>
              </Card>
            )}

            <Card isDark={isDark}>
              {!bulkMode ? (
                <button
                  onClick={handleGenerate}
                  disabled={generating || !canManage}
                  className="w-full rounded-xl py-3 text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
                  style={{ background: HUB_COLORS.mediumBlue }}
                >
                  {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Receipt className="h-4 w-4" />} Generate Payslip
                </button>
              ) : (
                <button
                  onClick={handleBulkGenerate}
                  disabled={bulkGenerating || !canManage}
                  className="w-full rounded-xl py-3 text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
                  style={{ background: HUB_COLORS.mediumBlue }}
                >
                  {bulkGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <UsersIcon className="h-4 w-4" />}
                  Generate{bulkEmployeeScope === 'specific' ? ` for ${bulkEmployeeIds.length || 0} Employee${bulkEmployeeIds.length === 1 ? '' : 's'}` : ' for Whole Company'}
                  {multiMonth ? ' × Months' : ''}
                </button>
              )}
              {!canManage && (
                <p className={`text-xs mt-2 text-center ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>You have view-only access to Salary Slips.</p>
              )}

              {lastGenerated && !bulkMode && (
                <div className={`mt-4 rounded-xl border p-3 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                  <p className={`text-xs font-bold flex items-center gap-1.5 mb-2 ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                    <CheckCircle2 className="h-3.5 w-3.5" /> {lastGenerated.slip_no} generated
                  </p>
                  <button
                    onClick={() => downloadSlipPdf(lastGenerated.id, lastGenerated.employee_name, lastGenerated.period_label)}
                    className={`w-full rounded-lg py-2 text-xs font-semibold flex items-center justify-center gap-1.5 border ${isDark ? 'border-slate-700 text-slate-200 hover:bg-slate-800' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}
                  >
                    <Download className="h-3.5 w-3.5" /> Download PDF
                  </button>
                </div>
              )}

              {bulkResult && (
                <div className={`mt-4 rounded-xl border p-3 text-xs ${isDark ? 'border-slate-800 text-slate-300' : 'border-slate-200 text-slate-600'}`}>
                  <p className="font-bold mb-1">
                    {bulkResult.generated_count} generated{bulkResult.periods_count > 1 ? ` across ${bulkResult.periods_count} months` : ''}, {bulkResult.skipped_count} skipped
                  </p>
                  {bulkResult.skipped.map((s) => (
                    <p key={s.employee_id} className={isDark ? 'text-slate-500' : 'text-slate-400'}>• {s.name}: {s.reason}</p>
                  ))}
                  {bulkResult.generated.length > 0 && (
                    <button
                      onClick={() => downloadSlipPdf ? null : null}
                      className={`mt-2 w-full rounded-lg py-2 font-semibold flex items-center justify-center gap-1.5 border ${isDark ? 'border-slate-700 text-slate-200 hover:bg-slate-800' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}
                      onClickCapture={async () => {
                        try {
                          const res = await api.post('/compliance/salary-slips/bulk-pdf', { slip_ids: bulkResult.generated.map((g) => g.id) }, { responseType: 'blob' });
                          const label = bulkResult.periods_count > 1 ? `${MONTHS[genMonth]}_${genYear}_to_${MONTHS[genMonthTo]}_${genYearTo}` : `${MONTHS[genMonth]}_${genYear}`;
                          triggerBlobDownload(res.data, `Payslips_${label}.pdf`);
                        } catch (e) { toast.error(await parseBlobError(e)); }
                      }}
                    >
                      <Download className="h-3.5 w-3.5" /> Download All as One PDF
                    </button>
                  )}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}

      {/* ── EMPLOYEES TAB ────────────────────────────────────────────── */}
      {tab === 'employees' && (
        <Card isDark={isDark}>
          <div className="flex items-center justify-between mb-4">
            <p className={`text-sm font-extrabold ${isDark ? 'text-white' : 'text-slate-900'}`}>
              Employees {companies.find((c) => c.key === companyKey)?.name ? `— ${companies.find((c) => c.key === companyKey)?.name}` : ''}
            </p>
            {canManage && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowImportModal(true)}
                  disabled={!companyKey}
                  className={`rounded-xl px-3 py-2 text-sm font-semibold flex items-center gap-1.5 border disabled:opacity-50 ${isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}
                >
                  <Upload className="h-4 w-4" /> Import from Excel
                </button>
                <button
                  onClick={() => { setEditingEmployee(null); setShowEmployeeModal(true); }}
                  className="rounded-xl px-3 py-2 text-sm font-semibold text-white flex items-center gap-1.5"
                  style={{ background: HUB_COLORS.mediumBlue }}
                >
                  <UserPlus className="h-4 w-4" /> Add Employee
                </button>
              </div>
            )}
          </div>

          {loadingEmployees ? (
            <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>
          ) : !employees.length ? (
            <EmptyState isDark={isDark} icon={UsersIcon} text="No employees added for this company yet." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={`text-left border-b ${isDark ? 'border-slate-800 text-slate-400' : 'border-slate-200 text-slate-500'}`}>
                    <th className="py-2 pr-4 font-semibold">Name</th>
                    <th className="py-2 pr-4 font-semibold">Code</th>
                    <th className="py-2 pr-4 font-semibold">Designation</th>
                    <th className="py-2 pr-4 font-semibold">Bank A/c</th>
                    <th className="py-2 pr-4 font-semibold">Status</th>
                    <th className="py-2 pr-4 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((e) => (
                    <tr key={e.id} className={`border-b last:border-0 ${isDark ? 'border-slate-800/60 text-slate-200' : 'border-slate-100 text-slate-700'}`}>
                      <td className="py-2 pr-4 font-medium">{e.name}</td>
                      <td className="py-2 pr-4">{e.employee_code || '—'}</td>
                      <td className="py-2 pr-4">{e.designation || '—'}</td>
                      <td className="py-2 pr-4">{e.bank_account || '—'}</td>
                      <td className="py-2 pr-4">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${e.status === 'active' ? (isDark ? 'bg-emerald-950 text-emerald-400' : 'bg-emerald-50 text-emerald-600') : (isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-500')}`}>
                          {e.status}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-right whitespace-nowrap">
                        {canManage && (
                          <>
                            <button onClick={() => { setEditingEmployee(e); setShowEmployeeModal(true); }} className={`p-1.5 rounded-lg mr-1 ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}>
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => deleteEmployee(e)} className={`p-1.5 rounded-lg ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}>
                              <Trash2 className="h-3.5 w-3.5 text-red-500" />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ── HISTORY TAB ──────────────────────────────────────────────── */}
      {tab === 'history' && (
        <Card isDark={isDark}>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div className="w-40">
              <FieldLabel isDark={isDark}>Month</FieldLabel>
              <SelectInput isDark={isDark} value={historyFilters.month} onChange={(e) => { setHistoryFilters((f) => ({ ...f, month: e.target.value })); setHistoryPage(1); }}>
                <option value="">All</option>
                {MONTHS.slice(1).map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </SelectInput>
            </div>
            <div className="w-28">
              <FieldLabel isDark={isDark}>Year</FieldLabel>
              <TextInput isDark={isDark} type="number" value={historyFilters.year} onChange={(e) => { setHistoryFilters((f) => ({ ...f, year: e.target.value })); setHistoryPage(1); }} placeholder="Any" />
            </div>
            <div className="w-36">
              <FieldLabel isDark={isDark}>Status</FieldLabel>
              <SelectInput isDark={isDark} value={historyFilters.status} onChange={(e) => { setHistoryFilters((f) => ({ ...f, status: e.target.value })); setHistoryPage(1); }}>
                <option value="">All</option>
                <option value="final">Final</option>
                <option value="draft">Draft</option>
              </SelectInput>
            </div>
            <div className="flex-1 min-w-[200px]">
              <FieldLabel isDark={isDark}>Search employee / company / slip no.</FieldLabel>
              <div className="relative">
                <Search className={`absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
                <TextInput isDark={isDark} className="pl-8" value={historyFilters.search} onChange={(e) => { setHistoryFilters((f) => ({ ...f, search: e.target.value })); setHistoryPage(1); }} />
              </div>
            </div>
            <button onClick={fetchHistory} className={`rounded-xl px-3 py-2.5 text-sm font-semibold flex items-center gap-1.5 border ${isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>

          {selectedIds.length > 0 && (
            <div className={`flex items-center justify-between rounded-xl p-3 mb-3 ${isDark ? 'bg-blue-950/40 border border-blue-900' : 'bg-blue-50 border border-blue-200'}`}>
              <span className={`text-xs font-semibold ${isDark ? 'text-blue-300' : 'text-blue-700'}`}>{selectedIds.length} selected</span>
              <button onClick={downloadBulkPdf} className="text-xs font-bold flex items-center gap-1.5" style={{ color: HUB_COLORS.mediumBlue }}>
                <Download className="h-3.5 w-3.5" /> Download combined PDF
              </button>
            </div>
          )}

          {loadingHistory ? (
            <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>
          ) : !historyItems.length ? (
            <EmptyState isDark={isDark} icon={FileText} text="No payslips match these filters yet." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={`text-left border-b ${isDark ? 'border-slate-800 text-slate-400' : 'border-slate-200 text-slate-500'}`}>
                    <th className="py-2 pr-2"></th>
                    <th className="py-2 pr-4 font-semibold">Slip No.</th>
                    <th className="py-2 pr-4 font-semibold">Employee</th>
                    <th className="py-2 pr-4 font-semibold">Company</th>
                    <th className="py-2 pr-4 font-semibold">Period</th>
                    <th className="py-2 pr-4 font-semibold text-right">Net Pay</th>
                    <th className="py-2 pr-4 font-semibold">Status</th>
                    <th className="py-2 pr-4 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {historyItems.map((s) => (
                    <tr key={s.id} className={`border-b last:border-0 ${isDark ? 'border-slate-800/60 text-slate-200' : 'border-slate-100 text-slate-700'}`}>
                      <td className="py-2 pr-2">
                        <input type="checkbox" checked={selectedIds.includes(s.id)} onChange={() => toggleSelect(s.id)} />
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">{s.slip_no}</td>
                      <td className="py-2 pr-4 font-medium">{s.employee_name}</td>
                      <td className="py-2 pr-4">{s.company_name}</td>
                      <td className="py-2 pr-4">{s.period_label}</td>
                      <td className="py-2 pr-4 text-right font-semibold">{inr(s.net_pay)}</td>
                      <td className="py-2 pr-4">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${s.status === 'final' ? (isDark ? 'bg-emerald-950 text-emerald-400' : 'bg-emerald-50 text-emerald-600') : (isDark ? 'bg-amber-950 text-amber-400' : 'bg-amber-50 text-amber-600')}`}>
                          {s.status}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-right whitespace-nowrap">
                        <button onClick={() => downloadSlipPdf(s.id, s.employee_name, s.period_label)} className={`p-1.5 rounded-lg mr-1 ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`} title="Download PDF">
                          <Download className="h-3.5 w-3.5" />
                        </button>
                        {canManage && (
                          <>
                            <button onClick={() => setEditingSlip(s)} className={`p-1.5 rounded-lg mr-1 ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`} title="Edit">
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => duplicateToNextMonth(s)} className={`p-1.5 rounded-lg mr-1 ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`} title="Duplicate to next month">
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => deleteSlip(s.id)} className={`p-1.5 rounded-lg ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`} title="Delete">
                              <Trash2 className="h-3.5 w-3.5 text-red-500" />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="flex items-center justify-between mt-4">
                <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {historyTotal} total · page {historyPage} of {Math.max(1, Math.ceil(historyTotal / pageSize))}
                </p>
                <div className="flex gap-2">
                  <button disabled={historyPage <= 1} onClick={() => setHistoryPage((p) => p - 1)} className={`p-1.5 rounded-lg border disabled:opacity-40 ${isDark ? 'border-slate-700' : 'border-slate-300'}`}>
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button disabled={historyPage >= Math.ceil(historyTotal / pageSize)} onClick={() => setHistoryPage((p) => p + 1)} className={`p-1.5 rounded-lg border disabled:opacity-40 ${isDark ? 'border-slate-700' : 'border-slate-300'}`}>
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </Card>
      )}

      {showAddCompany && (
        <AddCompanyModal
          isDark={isDark}
          onClose={() => setShowAddCompany(false)}
          onCreated={(c) => { setManualCompanies((p) => [...p, c]); setCompanyKey(`manual:${c.id}`); setShowAddCompany(false); }}
        />
      )}

      {showEmployeeModal && (
        <EmployeeModal
          isDark={isDark}
          companyKey={companyKey}
          presets={presets}
          editing={editingEmployee}
          onClose={() => setShowEmployeeModal(false)}
          onSaved={() => { setShowEmployeeModal(false); fetchEmployees(companyKey); fetchSummary(); }}
        />
      )}

      {editingSlip && (
        <EditSlipModal
          isDark={isDark}
          slip={editingSlip}
          presets={presets}
          onClose={() => setEditingSlip(null)}
          onSaved={() => { setEditingSlip(null); fetchHistory(); }}
        />
      )}

      {showImportModal && (
        <ImportEmployeesModal
          isDark={isDark}
          companyKey={companyKey}
          companyName={companies.find((c) => c.key === companyKey)?.name}
          onClose={() => setShowImportModal(false)}
          onImported={() => { fetchEmployees(companyKey); fetchSummary(); }}
        />
      )}
    </div>
  );
}
