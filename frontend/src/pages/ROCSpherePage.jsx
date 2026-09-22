// ROCSpherePage.jsx — ROC Sphere: Companies Act (India) document automation
// New, self-contained module. Mirrors the visual language of
// CompliancePage.jsx / TrademarkSphere.jsx / SalarySlips.jsx (Hub banner,
// StatCard, dark-mode-aware Tailwind classes, sonner toasts).

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Landmark, Plus, X, Loader2, Trash2, Building2, Users as UsersIcon,
  Download, FileText, Search, RefreshCw, Save, CheckCircle2, Upload,
  ClipboardList, Gavel, NotebookPen, ChevronRight, AlertTriangle, Info,
  ScrollText, Pencil, DatabaseZap, ListChecks, FileSpreadsheet, FileUp,
  BookOpen, ArrowLeftRight, BadgeCheck, CalendarDays, Zap, UsersRound, Clock3, History, Bell,
} from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { useDark } from '@/hooks/useDark';
import { HubBanner, StatCard, HUB_COLORS } from '@/components/SectionHub.jsx';

/* ── helpers ─────────────────────────────────────────────────────────── */

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

const CATEGORY_LABELS = {
  private: 'Private Limited', public: 'Public Limited', opc: 'One Person Company', section_8: 'Section 8 Company', llp: 'LLP',
};

// Legacy ROC records were sometimes stored as `private` even when the
// company is an LLP. Keep the UI resilient to those records while the
// backend repairs the persisted category.
function getCompanyCategory(c) {
  const raw = String(c?.category || '').trim().toLowerCase().replace(/[- ]+/g, '_');
  const name = String(c?.company_name || '').trim().toLowerCase();
  const llpin = String(c?.llpin || c?.master_data?.llpin || c?.master_data?.llpin_number || '').trim();
  if (llpin || /(?:^|\s)llp$/.test(name) || name.includes(' limited liability partnership')) return 'llp';
  const aliases = {
    llp: 'llp', limited_liability_partnership: 'llp',
    pvt_ltd: 'private', private_limited: 'private', private_limited_company: 'private',
    public_ltd: 'public', public_limited: 'public', public_limited_company: 'public',
    section_8: 'section_8', section8: 'section_8', section_8_company: 'section_8',
    opc: 'opc', one_person_company: 'opc',
  };
  return aliases[raw] || raw || 'private';
}

// financial_data is filled only from AOC-4 uploads (see backend/roc_sphere.py
// FINANCIAL_DATA_FIELDS) — kept read-only here since it's a filing extract,
// not something the user hand-edits on this tab.
const FINANCIAL_DATA_LABELS = [
  ['period_from', 'Period From'],
  ['period_to', 'Period To'],
  ['total_income', 'Total Income (Rs.)'],
  ['total_expenses', 'Total Expenses (Rs.)'],
  ['profit_before_tax', 'Profit Before Tax (Rs.)'],
  ['profit_after_tax', 'Profit / (Loss) After Tax (Rs.)'],
  ['net_worth', 'Net Worth (Rs.)'],
  ['share_capital', 'Share Capital (Rs.)'],
  ['reserves_and_surplus', 'Reserves & Surplus (Rs.)'],
  ['balance_sheet_total', 'Balance Sheet Total (Rs.)'],
  ['turnover', 'Turnover (Rs.)'],
];

const emptyCompanyForm = () => ({
  client_id: null,
  company_name: '',
  cin: '',
  category: 'private',
  pan: '',
  date_of_incorporation: '',
  registered_office_address: '',
  authorized_capital: 0,
  paid_up_capital: 0,
  last_year_turnover: 0,
  last_agm_date: '',
  last_board_meeting_date: '',
  directors: [],
  shareholders: [],
  auditor: { name: '', firm_reg_no: '', membership_no: '', appointed_from: '', appointed_till: '' },
  annual_return_data: {},
  audit_report_data: {},
  board_report_data: {},
  share_transfers: [],
  share_certificates: [],
  notes: '',
});

const TABS = [
  { key: 'master', label: 'Company Master', icon: Building2 },
  { key: 'masterdata', label: 'Master Data', icon: DatabaseZap },
  { key: 'directors', label: 'Directors & Shareholders', icon: UsersIcon },
  { key: 'statutory', label: 'Statutory Registers', icon: BookOpen },
  { key: 'resolution', label: 'Board Resolution', icon: Gavel },
  { key: 'notice', label: 'Notice of Meeting', icon: ScrollText },
  { key: 'minutes', label: 'Minutes of Meeting', icon: NotebookPen },
  { key: 'history', label: 'Record History', icon: History },
  { key: 'checklist', label: 'Compliance Checklist', icon: ClipboardList },
  { key: 'applicable', label: 'Applicable Compliances', icon: ListChecks },
  { key: 'filing', label: 'Filing Desk', icon: FileSpreadsheet },
  { key: 'documents', label: 'Document Vault', icon: ScrollText },
  { key: 'cspractice', label: 'CS Practice Automation', icon: Zap },
  { key: 'notifications', label: 'Notifications', icon: Bell },
];

export default function ROCSpherePage() {
  const isDark = useDark();
  const [companies, setCompanies] = useState([]);
  const [eligibleClients, setEligibleClients] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [company, setCompany] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('master');
  const [showNewCompany, setShowNewCompany] = useState(false);
  const [search, setSearch] = useState('');
  const [companyTypeFilter, setCompanyTypeFilter] = useState('all');
  const [syncing, setSyncing] = useState(false);
  const [filingPrep, setFilingPrep] = useState(null);
  const [generatedDocs, setGeneratedDocs] = useState([]);
  const [filingLoading, setFilingLoading] = useState(false);
  const [csPlan, setCsPlan] = useState(null);
  const [csTasks, setCsTasks] = useState(null);
  const [csLoading, setCsLoading] = useState(false);
  const [csUsers, setCsUsers] = useState([]);

  const card = isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200';
  const text = isDark ? 'text-slate-100' : 'text-slate-900';
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const input = `w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40 ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-slate-300 text-slate-900'}`;

  const loadCompanies = useCallback(async () => {
    try {
      const { data } = await api.get('/roc-sphere/companies');
      setCompanies(data || []);
      return data || [];
    } catch (e) {
      toast.error('Failed to load companies');
      return [];
    }
  }, []);

  const loadFilingDesk = useCallback(async (companyId) => {
    if (!companyId) return;
    setFilingLoading(true);
    try {
      const [prepRes, docsRes] = await Promise.all([
        api.get(`/roc-sphere/companies/${companyId}/filing-preparation`),
        api.get(`/roc-sphere/companies/${companyId}/documents`),
      ]);
      setFilingPrep(prepRes.data || null);
      setGeneratedDocs(docsRes.data || []);
    } catch (e) {
      console.error('Filing desk load failed', e);
      toast.error('Unable to load ROC filing desk');
    } finally {
      setFilingLoading(false);
    }
  }, []);

  const loadCSPractice = useCallback(async (companyId, financialYear) => {
    if (!companyId) return;
    setCsLoading(true);
    try {
      const qs = financialYear ? `?financial_year=${encodeURIComponent(financialYear)}` : '';
      const [planRes, tasksRes, usersRes] = await Promise.all([
        api.get(`/roc-sphere/companies/${companyId}/cs-practice-plan${qs}`),
        api.get(`/roc-sphere/companies/${companyId}/cs-practice-tasks${qs}`),
        api.get('/users'),
      ]);
      setCsPlan(planRes.data || null);
      setCsTasks(tasksRes.data || null);
      setCsUsers((usersRes.data || []).filter((u) => u?.is_active !== false && u?.status !== 'inactive'));
    } catch (e) {
      console.error('CS practice automation load failed', e);
      toast.error('Unable to load CS practice automation');
    } finally {
      setCsLoading(false);
    }
  }, []);

  const loadEligibleClients = useCallback(async () => {
    try {
      const { data } = await api.get('/roc-sphere/clients-eligible');
      setEligibleClients(data || []);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const list = await loadCompanies();
      await loadEligibleClients();
      if (list.length) setSelectedId(list[0].id);
      setLoading(false);
    })();
  }, [loadCompanies, loadEligibleClients]);

  const loadOne = useCallback(async (id) => {
    if (!id) { setCompany(null); setFilingPrep(null); setGeneratedDocs([]); setCsPlan(null); setCsTasks(null); return; }
    try {
      const { data } = await api.get(`/roc-sphere/companies/${id}`);
      setCompany(data);
      void loadFilingDesk(id);
      void loadCSPractice(id);
    } catch (e) {
      toast.error('Failed to load company');
    }
  }, [loadFilingDesk]);

  useEffect(() => { loadOne(selectedId); }, [selectedId, loadOne]);

  const filteredCompanies = useMemo(() => {
    const q = search.toLowerCase();
    return companies.filter((c) => {
      const matchesType = companyTypeFilter === 'all' || getCompanyCategory(c) === companyTypeFilter;
      const matchesSearch = !q || (c.company_name || '').toLowerCase().includes(q) || (c.cin || '').toLowerCase().includes(q);
      return matchesType && matchesSearch;
    });
  }, [companies, search, companyTypeFilter]);

  const saveCompany = async (patch) => {
    if (!company?.id) return;
    try {
      const { data } = await api.put(`/roc-sphere/companies/${company.id}`, { ...company, ...patch });
      setCompany(data);
      setCompanies((prev) => prev.map((c) => (c.id === data.id ? { ...c, ...data } : c)));
      toast.success('Saved');
    } catch (e) {
      toast.error(await parseBlobError(e) || 'Save failed');
    }
  };

  const deleteCompany = async () => {
    if (!company?.id) return;
    if (!window.confirm(`Remove "${company.company_name}" from ROC Sphere? This does not affect the linked client record.`)) return;
    try {
      await api.delete(`/roc-sphere/companies/${company.id}`);
      toast.success('Removed');
      const list = await loadCompanies();
      setSelectedId(list[0]?.id || null);
    } catch {
      toast.error('Delete failed');
    }
  };

  const syncFromClients = async () => {
    setSyncing(true);
    try {
      const { data } = await api.post('/roc-sphere/companies/sync-from-clients');
      const list = await loadCompanies();
      await loadEligibleClients();
      if (!selectedId && list.length) setSelectedId(list[0].id);
      toast.success(data?.created ? `Added ${data.created} compan${data.created === 1 ? 'y' : 'ies'} from Clients` : 'Already up to date with Clients');
    } catch (e) {
      toast.error(await parseBlobError(e) || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className={`min-h-screen ${isDark ? 'bg-slate-950' : 'bg-slate-50'}`}>
      {/* Banner and the card grid below now share the same horizontal
          padding (px-4 sm:px-6) and no max-width cap, so their left/right
          edges line up and the cards use the full width available. */}
      <div className="px-4 sm:px-6 pt-6">
        <HubBanner
          icon={Landmark}
          eyebrow="Compliance"
          title="ROC Sphere"
          subtitle="Company master, Companies Act filings & ready-to-file drafts"
          isDark={isDark}
          stats={[
            { label: 'Companies', value: companies.length },
            { label: 'Private Ltd', value: companies.filter((c) => getCompanyCategory(c) === 'private').length },
            { label: 'Public Ltd', value: companies.filter((c) => getCompanyCategory(c) === 'public').length },
            { label: 'LLP', value: companies.filter((c) => getCompanyCategory(c) === 'llp').length },
          ]}
        />
      </div>

      <div className="px-4 sm:px-6 py-6 grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* ── Company list / picker ───────────────────────────────────── */}
        <div className={`lg:col-span-1 rounded-xl border ${card} p-4 h-fit`}>
          <div className="flex items-center justify-between mb-3">
            <h3 className={`font-semibold text-sm ${text}`}>Companies</h3>
            <div className="flex items-center gap-1.5">
              <button onClick={syncFromClients} disabled={syncing} title="Sync from Clients"
                className={`p-1.5 rounded-lg disabled:opacity-60 ${isDark ? 'bg-slate-700 hover:bg-slate-600 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}>
                {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              </button>
              <button onClick={() => setShowNewCompany(true)} title="Add company manually" className="p-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white">
                <Plus size={14} />
              </button>
            </div>
          </div>
          <p className={`text-[11px] ${muted} mb-3 -mt-2`}>Auto-synced from Pvt Ltd / Public Ltd / LLP / OPC / Section 8 clients</p>
           <select
             value={companyTypeFilter}
             onChange={(e) => setCompanyTypeFilter(e.target.value)}
             aria-label="Filter companies by entity type"
             className={`${input} mb-2 py-1.5 text-xs`}
           >
             <option value="all">All entity types ({companies.length})</option>
             <option value="private">Pvt Ltd ({companies.filter((c) => getCompanyCategory(c) === 'private').length})</option>
             <option value="llp">LLP ({companies.filter((c) => getCompanyCategory(c) === 'llp').length})</option>
             <option value="section_8">Section 8 ({companies.filter((c) => getCompanyCategory(c) === 'section_8').length})</option>
             <option value="public">Public Ltd ({companies.filter((c) => getCompanyCategory(c) === 'public').length})</option>
           </select>
          <div className="relative mb-3">
            <Search size={14} className={`absolute left-2.5 top-2.5 ${muted}`} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search company / CIN…"
              className={`${input} pl-8 py-1.5 text-xs`} />
          </div>
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="animate-spin" size={20} /></div>
          ) : filteredCompanies.length === 0 ? (
            <p className={`text-xs ${muted} py-6 text-center`}>
              No registered-entity clients found (Pvt Ltd / Public Ltd / LLP / OPC / Section 8).<br />
              Add one as a Client, or click <RefreshCw size={11} className="inline" /> to re-sync, or + to add manually.
            </p>
          ) : (
            <div className="space-y-1 max-h-[60vh] overflow-y-auto">
              {filteredCompanies.map((c) => (
                <button key={c.id} onClick={() => setSelectedId(c.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-xs flex items-center justify-between gap-2 transition
                    ${selectedId === c.id ? 'bg-blue-600 text-white' : isDark ? 'hover:bg-slate-700/60 text-slate-200' : 'hover:bg-slate-100 text-slate-700'}`}>
                  <span className="truncate">
                    <span className="font-medium block truncate">{c.company_name}</span>
                    <span className={`text-[10px] ${selectedId === c.id ? 'text-blue-100' : muted}`}>{CATEGORY_LABELS[getCompanyCategory(c)] || getCompanyCategory(c)}</span>
                  </span>
                  <ChevronRight size={12} className="shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ── Detail panel ─────────────────────────────────────────────── */}
        <div className="lg:col-span-3 space-y-4">
          {!company ? (
            <div className={`rounded-xl border ${card} p-10 text-center ${muted}`}>
              Select a company on the left, or add one to get started.
            </div>
          ) : (
            <>
              <div className={`rounded-xl border ${card} p-4 flex flex-wrap items-center justify-between gap-2`}>
                <div>
                  <h2 className={`text-lg font-bold ${text}`}>{company.company_name}</h2>
                  <p className={`text-xs ${muted}`}>CIN: {company.cin || '—'} · {CATEGORY_LABELS[company.category] || company.category}</p>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={deleteCompany} className="text-xs flex items-center gap-1 px-2 py-1.5 rounded-lg text-red-500 hover:bg-red-500/10">
                    <Trash2 size={13} /> Remove
                  </button>
                  <button onClick={() => setTab('upload')} className="text-xs flex items-center gap-1 px-2 py-1.5 rounded-lg text-blue-600 hover:bg-blue-500/10">
                    <Upload size={13} /> Upload ROC Forms
                  </button>
                </div>
              </div>

              {/* Tabs */}
              <div className={`rounded-xl border ${card} overflow-hidden`}>
                {/* Two fixed tab rows: no horizontal scroll. Seven equal slots per row keeps the desktop layout balanced. */}
                <div className={`border-b ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                  {[TABS.slice(0, 7), TABS.slice(7)].map((row, rowIndex) => (
                    <div key={rowIndex} className={`grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 ${rowIndex === 0 ? (isDark ? 'border-b border-slate-700' : 'border-b border-slate-200') : ''}`}>
                      {row.map((t) => {
                        const Icon = t.icon;
                        const active = tab === t.key;
                        return (
                          <button key={t.key} onClick={() => setTab(t.key)} title={t.label}
                            className={`min-w-0 flex items-center justify-center gap-1 px-2 py-2.5 text-[11px] font-medium border-b-2 transition text-center
                              ${active ? 'border-blue-600 text-blue-600 bg-blue-50/40 dark:bg-blue-950/20' : `border-transparent ${muted} hover:text-blue-500 hover:bg-slate-50 dark:hover:bg-slate-800/50`}`}>
                            <Icon size={13} className="shrink-0" /> <span className="truncate">{t.label}</span>
                          </button>
                        );
                      })}
                      {row.length < 7 && <div aria-hidden="true" className="hidden lg:block" />}
                    </div>
                  ))}
                </div>
                <div className="p-4">
                  {tab === 'master' && <MasterTab company={company} isDark={isDark} onSave={saveCompany} input={input} text={text} muted={muted} />}
                  {tab === 'masterdata' && <MasterDataTab company={company} isDark={isDark} text={text} muted={muted} onApplied={() => loadOne(company.id)} />}
                  {tab === 'directors' && <DirectorsTab company={company} isDark={isDark} onSave={saveCompany} input={input} text={text} muted={muted} />}
                  {tab === 'statutory' && <StatutoryRecordsTab company={company} isDark={isDark} input={input} text={text} muted={muted} onApplied={() => loadOne(company.id)} />}
                  {tab === 'resolution' && <ResolutionTab company={company} isDark={isDark} input={input} text={text} muted={muted} />}
                  {tab === 'notice' && <NoticeTab company={company} isDark={isDark} input={input} text={text} muted={muted} />}
                  {tab === 'minutes' && <MinutesTab company={company} isDark={isDark} input={input} text={text} muted={muted} />}
                  {tab === 'history' && <RecordHistoryTab company={company} isDark={isDark} input={input} text={text} muted={muted} onApplied={() => loadOne(company.id)} />}
                  {tab === 'checklist' && <ChecklistTab company={company} isDark={isDark} text={text} muted={muted} />}
                  {tab === 'applicable' && <ApplicableCompliancesTab company={company} isDark={isDark} text={text} muted={muted} />}
                  {tab === 'filing' && <FilingDeskTab company={company} prep={filingPrep} docs={generatedDocs} loading={filingLoading} isDark={isDark} text={text} muted={muted} onRefresh={() => loadFilingDesk(company.id)} />}
                  {tab === 'documents' && <FilingDeskTab company={company} prep={filingPrep} docs={generatedDocs} loading={filingLoading} isDark={isDark} text={text} muted={muted} onRefresh={() => loadFilingDesk(company.id)} />}
                  {tab === 'cspractice' && <CSPracticeAutomationTab company={company} plan={csPlan} tasks={csTasks} users={csUsers} loading={csLoading} isDark={isDark} input={input} text={text} muted={muted} onRefresh={(fy) => loadCSPractice(company.id, fy)} />}
                  {tab === 'notifications' && <NotificationsTab isDark={isDark} input={input} text={text} muted={muted} />}
                  {tab === 'upload' && <UploadTab company={company} isDark={isDark} input={input} text={text} muted={muted} onApplied={() => loadOne(company.id)} />}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {showNewCompany && (
        <NewCompanyModal
          isDark={isDark} input={input} text={text} muted={muted}
          eligibleClients={eligibleClients}
          onClose={() => setShowNewCompany(false)}
          onCreated={async (created) => {
            setShowNewCompany(false);
            const list = await loadCompanies();
            await loadEligibleClients();
            setSelectedId(created.id);
            void list;
          }}
        />
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════════════
 * Filing Desk / Document Vault
 * ═══════════════════════════════════════════════════════════════════════ */
function RecordHistoryTab({ company, isDark, input, text, muted, onApplied }) {
  const blank = {
    meeting_type: 'board', meeting_number: '', meeting_date: '', meeting_time: '11:00 AM', notice_date: '', venue: company.registered_office_address || 'Registered Office',
    mode: 'Physical', chairman: '', quorum_present: true, attendance: [], members_present_count: '', members_entitled_count: '', leave_of_absence: [],
    agenda_items: [], resolutions_passed: [], special_business: [], minutes_date: '', minutes_signed_date: '', adjourned: false, adjourned_to: '',
    auditor_attended: false, secretarial_notes: '', attachments: [], status: 'Completed', remarks: '',
  };
  const [records, setRecords] = useState([]);
  const [summary, setSummary] = useState({ total: 0, board_meetings: 0, agms: 0, egms: 0 });
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const card = isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200';
  const setField = (key, value) => setForm((p) => ({ ...p, [key]: value }));
  const linesToArray = (v) => String(v || '').split(/\n|,/).map(x => x.trim()).filter(Boolean);
  const arrayToLines = (v) => Array.isArray(v) ? v.join('\n') : '';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/roc-sphere/companies/${company.id}/record-history`);
      setRecords(data.records || []);
      setSummary(data.summary || {});
    } catch (e) {
      toast.error(await parseBlobError(e) || 'Failed to load Record History');
    } finally { setLoading(false); }
  }, [company.id]);
  useEffect(() => { load(); }, [load]);

  const openNew = () => { setEditingId(null); setForm({ ...blank, venue: company.registered_office_address || 'Registered Office' }); setShowForm(true); };
  const openEdit = (r) => {
    setEditingId(r.id);
    setForm({ ...blank, ...r, attendance: r.attendance || [], leave_of_absence: r.leave_of_absence || [], agenda_items: r.agenda_items || [], resolutions_passed: r.resolutions_passed || [], special_business: r.special_business || [], attachments: r.attachments || [] });
    setShowForm(true);
  };
  const save = async () => {
    if (!form.meeting_date) { toast.error('Meeting date is required'); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        meeting_number: form.meeting_number || null,
        members_present_count: form.members_present_count === '' ? null : Number(form.members_present_count),
        members_entitled_count: form.members_entitled_count === '' ? null : Number(form.members_entitled_count),
        leave_of_absence: Array.isArray(form.leave_of_absence) ? form.leave_of_absence : linesToArray(form.leave_of_absence),
        agenda_items: Array.isArray(form.agenda_items) ? form.agenda_items : linesToArray(form.agenda_items),
        resolutions_passed: Array.isArray(form.resolutions_passed) ? form.resolutions_passed : linesToArray(form.resolutions_passed),
        special_business: Array.isArray(form.special_business) ? form.special_business : linesToArray(form.special_business),
        attachments: Array.isArray(form.attachments) ? form.attachments : linesToArray(form.attachments),
      };
      const url = editingId ? `/roc-sphere/companies/${company.id}/record-history/${editingId}` : `/roc-sphere/companies/${company.id}/record-history`;
      const method = editingId ? 'put' : 'post';
      await api[method](url, payload);
      toast.success(editingId ? 'Record updated' : 'Meeting record saved');
      setShowForm(false); setEditingId(null); await load(); onApplied?.();
    } catch (e) { toast.error(await parseBlobError(e) || 'Could not save meeting record'); }
    finally { setSaving(false); }
  };
  const remove = async (id) => {
    if (!window.confirm('Delete this meeting record? It will also be removed from MGT-7 preparation data.')) return;
    try { await api.delete(`/roc-sphere/companies/${company.id}/record-history/${id}`); toast.success('Record deleted'); await load(); onApplied?.(); }
    catch (e) { toast.error(await parseBlobError(e) || 'Delete failed'); }
  };

  const addAllDirectors = () => {
    const people = (company.directors || company.designated_partners || []).map(d => ({ name: d.name, din: d.din || '', designation: d.designation || 'Director', status: 'Present', mode: form.mode || 'Physical', remarks: '' }));
    setField('attendance', people);
  };
  const updateAttendance = (i, key, value) => setField('attendance', (form.attendance || []).map((a, x) => x === i ? { ...a, [key]: value } : a));

  return <div className="space-y-4">
    <div className={`rounded-xl border p-4 ${card}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h3 className={`font-semibold ${text}`}>Record History</h3><p className={`text-xs mt-1 ${muted}`}>Permanent meeting register for Board Meetings, AGMs, EGMs and other secretarial records. Entries remain available for future MGT-7 / MGT-7A preparation.</p></div>
        <button onClick={openNew} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 text-white text-xs font-semibold"><Plus size={13}/> Add Meeting Record</button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4">
        {[['Total', summary.total || 0], ['Board Meetings', summary.board_meetings || 0], ['AGM', summary.agms || 0], ['EGM', summary.egms || 0]].map(([k,v]) => <div key={k} className={`rounded-lg border p-3 ${isDark ? 'border-slate-700 bg-slate-900/40' : 'border-slate-200 bg-slate-50'}`}><div className={`text-[10px] uppercase font-bold ${muted}`}>{k}</div><div className={`text-xl font-bold mt-1 ${text}`}>{v}</div></div>)}
      </div>
    </div>

    {showForm && <div className={`rounded-xl border p-4 ${card}`}>
      <div className="flex items-center justify-between mb-3"><h4 className={`font-semibold text-sm ${text}`}>{editingId ? 'Edit Meeting Record' : 'Add Meeting / General Meeting Record'}</h4><button onClick={() => setShowForm(false)}><X size={16} className={muted}/></button></div>
      <div className="grid md:grid-cols-4 gap-3">
        <label><span className={`text-[10px] font-bold ${muted}`}>Meeting Type</span><select className={input} value={form.meeting_type} onChange={e=>setField('meeting_type',e.target.value)}><option value="board">Board Meeting</option><option value="agm">AGM</option><option value="egm">EGM</option><option value="committee">Committee Meeting</option><option value="partner">Partner Meeting</option><option value="other">Other</option></select></label>
        <label><span className={`text-[10px] font-bold ${muted}`}>Meeting No.</span><input className={input} value={form.meeting_number || ''} onChange={e=>setField('meeting_number',e.target.value)} placeholder="BM-04 / AGM-01"/></label>
        <label><span className={`text-[10px] font-bold ${muted}`}>Meeting Date *</span><input type="date" className={input} value={form.meeting_date || ''} onChange={e=>setField('meeting_date',e.target.value)}/></label>
        <label><span className={`text-[10px] font-bold ${muted}`}>Meeting Time</span><input className={input} value={form.meeting_time || ''} onChange={e=>setField('meeting_time',e.target.value)}/></label>
        <label><span className={`text-[10px] font-bold ${muted}`}>Notice Date</span><input type="date" className={input} value={form.notice_date || ''} onChange={e=>setField('notice_date',e.target.value)}/></label>
        <label><span className={`text-[10px] font-bold ${muted}`}>Mode</span><select className={input} value={form.mode || ''} onChange={e=>setField('mode',e.target.value)}><option>Physical</option><option>VC</option><option>OAVM</option><option>Hybrid</option><option>Other</option></select></label>
        <label className="md:col-span-2"><span className={`text-[10px] font-bold ${muted}`}>Venue</span><input className={input} value={form.venue || ''} onChange={e=>setField('venue',e.target.value)}/></label>
        <label><span className={`text-[10px] font-bold ${muted}`}>Chairman</span><input className={input} value={form.chairman || ''} onChange={e=>setField('chairman',e.target.value)}/></label>
        <label><span className={`text-[10px] font-bold ${muted}`}>Members Present</span><input type="number" className={input} value={form.members_present_count ?? ''} onChange={e=>setField('members_present_count',e.target.value)}/></label>
        <label><span className={`text-[10px] font-bold ${muted}`}>Members Entitled</span><input type="number" className={input} value={form.members_entitled_count ?? ''} onChange={e=>setField('members_entitled_count',e.target.value)}/></label>
        <label className="flex items-end gap-2 text-xs"><input type="checkbox" checked={!!form.quorum_present} onChange={e=>setField('quorum_present',e.target.checked)}/> Quorum present</label>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between mb-2"><label className={`text-xs font-semibold ${text}`}>Attendance</label><button onClick={addAllDirectors} type="button" className={`text-[10px] px-2 py-1 rounded border ${isDark?'border-slate-700 text-slate-300':'border-slate-300 text-slate-600'}`}><UsersRound size={11} className="inline mr-1"/>Load Directors / Partners</button></div>
        <div className={`rounded-lg border p-2 space-y-2 ${isDark?'border-slate-700 bg-slate-900/30':'border-slate-200 bg-slate-50'}`}>
          {(form.attendance || []).map((a,i)=><div key={i} className="grid grid-cols-12 gap-2 items-center"><input className={`${input} col-span-4`} value={a.name || ''} onChange={e=>updateAttendance(i,'name',e.target.value)} placeholder="Name"/><input className={`${input} col-span-2`} value={a.din || ''} onChange={e=>updateAttendance(i,'din',e.target.value)} placeholder="DIN / DPIN"/><select className={`${input} col-span-3`} value={a.status || 'Present'} onChange={e=>updateAttendance(i,'status',e.target.value)}><option>Present</option><option>Absent</option><option>Leave of Absence</option></select><select className={`${input} col-span-2`} value={a.mode || form.mode || 'Physical'} onChange={e=>updateAttendance(i,'mode',e.target.value)}><option>Physical</option><option>VC</option><option>OAVM</option><option>Hybrid</option></select><button type="button" onClick={()=>setField('attendance',(form.attendance||[]).filter((_,x)=>x!==i))} className="text-red-500"><Trash2 size={14}/></button></div>)}
          <button type="button" onClick={()=>setField('attendance',[...(form.attendance||[]),{name:'',din:'',designation:'',status:'Present',mode:form.mode||'Physical',remarks:''}])} className="text-xs text-blue-600"><Plus size={12} className="inline"/> Add attendee</button>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-3 mt-4">
        <label><span className={`text-[10px] font-bold ${muted}`}>Agenda Items (one per line)</span><textarea className={input} rows={4} value={arrayToLines(form.agenda_items)} onChange={e=>setField('agenda_items',linesToArray(e.target.value))}/></label>
        <label><span className={`text-[10px] font-bold ${muted}`}>Resolutions Passed (one per line)</span><textarea className={input} rows={4} value={arrayToLines(form.resolutions_passed)} onChange={e=>setField('resolutions_passed',linesToArray(e.target.value))}/></label>
        <label><span className={`text-[10px] font-bold ${muted}`}>Special Business (one per line)</span><textarea className={input} rows={3} value={arrayToLines(form.special_business)} onChange={e=>setField('special_business',linesToArray(e.target.value))}/></label>
        <label><span className={`text-[10px] font-bold ${muted}`}>Leave of Absence (one per line)</span><textarea className={input} rows={3} value={arrayToLines(form.leave_of_absence)} onChange={e=>setField('leave_of_absence',linesToArray(e.target.value))}/></label>
        <label><span className={`text-[10px] font-bold ${muted}`}>Minutes Date</span><input type="date" className={input} value={form.minutes_date || ''} onChange={e=>setField('minutes_date',e.target.value)}/></label>
        <label><span className={`text-[10px] font-bold ${muted}`}>Minutes Signed Date</span><input type="date" className={input} value={form.minutes_signed_date || ''} onChange={e=>setField('minutes_signed_date',e.target.value)}/></label>
        <label className="md:col-span-2"><span className={`text-[10px] font-bold ${muted}`}>Secretarial Notes / Other Details</span><textarea className={input} rows={3} value={form.secretarial_notes || ''} onChange={e=>setField('secretarial_notes',e.target.value)} placeholder="Adjournment, voting, special resolutions, registers updated, forms triggered, attachments, follow-up actions…"/></label>
      </div>
      <div className="flex justify-end gap-2 mt-4"><button onClick={()=>setShowForm(false)} className={`px-3 py-2 rounded-lg text-xs ${isDark?'bg-slate-800 text-slate-300':'bg-slate-100 text-slate-600'}`}>Cancel</button><button onClick={save} disabled={saving} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-semibold disabled:opacity-60">{saving?<Loader2 size={13} className="inline animate-spin mr-1"/>:<Save size={13} className="inline mr-1"/>}{editingId?'Update Record':'Save Record'}</button></div>
    </div>}

    <div className={`rounded-xl border overflow-hidden ${card}`}>
      {loading ? <div className={`p-8 text-center ${muted}`}><Loader2 className="animate-spin inline" size={18}/></div> : records.length === 0 ? <div className={`p-10 text-center ${muted}`}><History size={28} className="mx-auto mb-2 opacity-50"/><p className="text-sm font-medium">No meeting history yet</p><p className="text-xs mt-1">Add your first Board Meeting / AGM / EGM record. It will be retained and exposed automatically to the MGT-7 / MGT-7A filing-preparation data.</p></div> : <div className="divide-y divide-slate-200 dark:divide-slate-700">{records.map(r => { const present=(r.attendance||[]).filter(a=>a.status==='Present').length; return <div key={r.id} className="px-4 py-3"><div className="flex items-start gap-3"><div className="h-9 w-9 rounded-lg bg-blue-50 dark:bg-blue-950/30 text-blue-600 flex items-center justify-center shrink-0"><CalendarDays size={15}/></div><div className="min-w-0 flex-1"><div className={`flex flex-wrap items-center gap-2 text-xs font-semibold ${text}`}><span>{r.meeting_type==='agm'?'AGM':r.meeting_type==='egm'?'EGM':r.meeting_type==='board'?'Board Meeting':(r.meeting_type||'Meeting')}</span>{r.meeting_number&&<span className={`font-normal ${muted}`}>#{r.meeting_number}</span>}<span className={`font-normal ${muted}`}>{r.meeting_date}</span></div><div className={`text-[10px] mt-1 ${muted}`}>{r.venue||'—'} · {r.mode||'—'} · Chairman: {r.chairman||'—'} · Attendance: {present}/{(r.attendance||[]).length}</div>{(r.resolutions_passed||[]).length>0&&<div className={`text-[10px] mt-1 ${muted}`}>Resolutions: {(r.resolutions_passed||[]).length} · Minutes: {r.minutes_date||'Not recorded'}</div>}</div><div className="flex items-center gap-1"><button onClick={()=>openEdit(r)} className="p-1.5 rounded text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/30" title="Edit"><Pencil size={13}/></button><button onClick={()=>remove(r.id)} className="p-1.5 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30" title="Delete"><Trash2 size={13}/></button></div></div></div>; })}</div>}
    </div>
    <p className={`text-[10px] ${muted}`}>Record History is the application's persistent secretarial register. It is not a legal certification: verify minutes, attendance, quorum, resolutions and current MCA requirements before filing.</p>
  </div>;
}

function FilingDeskTab({ company, prep, docs, loading, isDark, text, muted, onRefresh }) {
  const missing = prep?.missing_working_fields || [];
  const ready = prep && missing.length === 0;
  const labelMap = {
    company_name: 'Company name', cin: 'CIN', registered_office_address: 'Registered office',
    period_to: 'Financial year end', turnover: 'Turnover', net_worth: 'Net worth',
    auditor: 'Auditor', directors: 'Directors', shareholders: 'Shareholders',
  };
  return (
    <div className="space-y-4">
      <div className={`rounded-xl border p-4 ${isDark ? 'bg-slate-900/50 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className={`font-semibold ${text}`}>ROC Filing Readiness</h3>
            <p className={`text-xs mt-1 ${muted}`}>Prepare the source data for AOC-4 / MGT-7 / MGT-7A before final MCA filing.</p>
          </div>
          <button onClick={onRefresh} className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border ${isDark ? 'border-slate-700 text-slate-200' : 'border-slate-300 text-slate-700'}`}>
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''}/> Refresh
          </button>
        </div>
        {loading ? (
          <div className={`py-8 text-center text-sm ${muted}`}>Loading filing data…</div>
        ) : (
          <>
            <div className={`mt-4 rounded-lg p-3 border ${ready ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20' : 'border-amber-300 bg-amber-50 dark:bg-amber-950/20'}`}>
              <div className={`font-semibold text-sm ${ready ? 'text-emerald-700' : 'text-amber-700'}`}>
                {ready ? '✓ Filing data appears complete' : `⚠ ${missing.length} field${missing.length === 1 ? '' : 's'} need attention`}
              </div>
              {!ready && <div className="mt-2 flex flex-wrap gap-1.5">{missing.map(k => <span key={k} className="px-2 py-1 rounded-full text-[10px] font-semibold bg-white/70 border border-amber-200 text-amber-800">{labelMap[k] || k}</span>)}</div>}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3">
              {[
                ['AOC-4', prep?.aoc4 && Object.keys(prep.aoc4).length ? 'Source loaded' : 'Awaiting source'],
                ['MGT-7 / 7A', prep?.mgt7a && Object.keys(prep.mgt7a).length ? 'Source loaded' : 'Awaiting source'],
                ['Audit Report', prep?.audit_report && Object.keys(prep.audit_report).length ? 'Loaded' : 'Missing'],
                ['Board Report', prep?.board_report && Object.keys(prep.board_report).length ? 'Loaded' : 'Missing'],
              ].map(([name, state]) => (
                <div key={name} className={`rounded-lg border p-3 ${isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-white'}`}>
                  <div className={`text-[10px] uppercase tracking-wider font-bold ${muted}`}>{name}</div>
                  <div className={`text-xs font-semibold mt-1 ${text}`}>{state}</div>
                </div>
              ))}
            </div>
            <div className={`mt-3 rounded-lg border p-3 ${isDark ? 'border-slate-700 bg-slate-800/60' : 'border-slate-200 bg-white'}`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className={`text-xs font-semibold ${text}`}>Record History → MGT-7 / MGT-7A</div>
                  <div className={`text-[10px] mt-0.5 ${muted}`}>Meeting records stored in ROC Sphere are available to the filing-preparation layer.</div>
                </div>
                <div className="flex items-center gap-2 text-[10px] font-semibold">
                  <span className="px-2 py-1 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">{prep?.record_history_summary?.total || 0} records</span>
                  <span className="px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">{prep?.record_history_summary?.agms || 0} AGM</span>
                </div>
              </div>
              {prep?.record_history_summary?.latest_agm && (
                <div className={`mt-2 text-[10px] ${muted}`}>Latest AGM: <strong className={text}>{prep.record_history_summary.latest_agm.meeting_date}</strong> · Attendance {prep.record_history_summary.latest_agm.attendance?.filter(a => a.status === 'Present').length || 0}</div>
              )}
            </div>
          </>
        )}
      </div>
      <div className={`rounded-xl border overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
        <div className={`px-4 py-3 border-b flex items-center justify-between ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
          <div><h3 className={`font-semibold text-sm ${text}`}>Generated Documents</h3><p className={`text-[11px] ${muted}`}>Audit trail of documents generated from ROC Sphere.</p></div>
          <span className={`text-xs font-semibold ${muted}`}>{docs.length} document{docs.length === 1 ? '' : 's'}</span>
        </div>
        {docs.length === 0 ? <div className={`p-6 text-center text-sm ${muted}`}>No generated documents yet. Use Board Resolution, Notice, Minutes or Checklist to create working documents.</div> :
          <div className="divide-y divide-slate-200 dark:divide-slate-700">
            {docs.slice(0, 20).map((d, i) => (
              <div key={d.id || i} className={`px-4 py-3 flex items-center gap-3 ${isDark ? 'bg-slate-900/20' : 'bg-white'}`}>
                <FileText size={16} className="text-blue-600 shrink-0"/>
                <div className="min-w-0 flex-1"><div className={`text-xs font-medium truncate ${text}`}>{d.filename}</div><div className={`text-[10px] ${muted}`}>{d.doc_type} · {d.generated_at ? new Date(d.generated_at).toLocaleString() : '—'}</div></div>
                <BadgeCheck size={15} className="text-emerald-500 shrink-0" title="Generated"/>
              </div>
            ))}
          </div>}
      </div>
      <p className={`text-[10px] ${muted}`}>This desk is a preparation and documentation layer; final MCA submission, signing, DSC use and statutory verification remain subject to the applicable filing requirements.</p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Legal Notifications / Update Documents
 * ═══════════════════════════════════════════════════════════════════════ */
function NotificationsTab({ isDark, input, text, muted }) {
  const [notifications, setNotifications] = useState([]);
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/roc-sphere/notifications');
      setNotifications(data || []);
    } catch (e) { toast.error('Unable to load legal notifications'); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const upload = async () => {
    if (!files.length) { toast.error('Select at least one notification/update document'); return; }
    setUploading(true);
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.append('file', file);
        await api.post('/roc-sphere/notifications/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      }
      setFiles([]);
      toast.success('Update document(s) uploaded and analysed');
      await load();
    } catch (e) { toast.error(await parseBlobError(e) || 'Notification upload failed'); }
    finally { setUploading(false); }
  };

  const review = async (id, action) => {
    setBusyId(id);
    try {
      await api.post(`/roc-sphere/notifications/${id}/${action}`);
      toast.success(action === 'approve' ? 'Notification rule update approved' : 'Notification marked rejected');
      await load();
    } catch (e) { toast.error(await parseBlobError(e) || 'Could not update notification'); }
    finally { setBusyId(null); }
  };

  const statusClass = (s) => s === 'approved'
    ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
    : s === 'rejected'
      ? 'text-red-700 bg-red-50 border-red-200'
      : 'text-amber-700 bg-amber-50 border-amber-200';

  return (
    <div className="space-y-4">
      <div className={`rounded-2xl border p-4 ${isDark ? 'bg-slate-900/60 border-slate-700' : 'bg-gradient-to-br from-blue-50 to-white border-blue-100'}`}>
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h3 className={`font-bold ${text}`}>Notifications & Legal Updates</h3>
            <p className={`text-xs mt-1 ${muted}`}>Upload MCA/ICSI notifications, circulars, amendments and other legal update documents. ROC Sphere reads them, identifies affected forms/sections and creates proposed rule updates for professional review.</p>
          </div>
          <button onClick={load} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-semibold"><RefreshCw size={13}/> Refresh</button>
        </div>
      </div>

      <div className={`rounded-xl border p-4 ${cardStyle(isDark)}`}>
        <div className="flex flex-col md:flex-row md:items-end gap-3">
          <div className="flex-1">
            <label className={`text-xs font-semibold ${text} mb-1 block`}>Upload Update Documents</label>
            <input type="file" multiple accept=".pdf,.docx,.txt,.csv,.xlsx,.xlsm,.xls" className={`text-xs ${muted}`} onChange={(e) => setFiles(Array.from(e.target.files || []))} />
            <p className={`text-[10px] mt-1 ${muted}`}>PDF/DOCX/XLSX/TXT/CSV/XLSM/XLS, up to 12 MB per document.</p>
          </div>
          <button onClick={upload} disabled={uploading || !files.length} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-semibold disabled:opacity-60">
            {uploading ? 'Reading documents…' : 'Upload & Read'}
          </button>
        </div>
        {!!files.length && <p className={`text-[10px] mt-2 ${muted}`}>{files.length} document(s) selected</p>}
      </div>

      <div className="space-y-2">
        {notifications.length === 0 ? (
          <div className={`rounded-xl border p-8 text-center ${cardStyle(isDark)} ${muted}`}>
            <Bell size={25} className="mx-auto mb-2 opacity-50"/>
            <p className="text-sm font-semibold">No legal update documents uploaded</p>
            <p className="text-xs mt-1">Upload your first MCA/ICSI notification or circular above.</p>
          </div>
        ) : notifications.map((n) => (
          <div key={n.id} className={`rounded-xl border overflow-hidden ${cardStyle(isDark)}`}>
            <div className="p-4 flex flex-col lg:flex-row lg:items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className={`text-sm font-semibold ${text}`}>{n.title || n.filename}</h4>
                  <span className={`px-2 py-0.5 rounded-full border text-[9px] font-bold ${statusClass(n.status)}`}>{(n.status || 'under_review').replace('_',' ')}</span>
                </div>
                <p className={`text-[10px] mt-1 ${muted}`}>{n.filename} · {n.authority || 'Other'} · {n.effective_date || 'Effective date not extracted'} · {n.affected_forms?.join(', ') || 'No forms detected'}</p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button onClick={() => setExpanded(expanded === n.id ? null : n.id)} className="px-2.5 py-1.5 rounded-lg border text-[10px]">Details</button>
                {n.file_available && <button onClick={() => window.open(`/api/roc-sphere/notifications/${n.id}/download`, '_blank')} className="px-2.5 py-1.5 rounded-lg border text-[10px]">Download</button>}
                {n.status !== 'approved' && <button disabled={busyId === n.id} onClick={() => review(n.id,'approve')} className="px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white text-[10px]">Approve</button>}
                {n.status !== 'rejected' && <button disabled={busyId === n.id} onClick={() => review(n.id,'reject')} className="px-2.5 py-1.5 rounded-lg bg-slate-700 text-white text-[10px]">Reject</button>}
              </div>
            </div>
            {expanded === n.id && (
              <div className={`border-t p-4 space-y-3 ${isDark ? 'border-slate-700 bg-slate-900/40' : 'border-slate-200 bg-slate-50'}`}>
                <div className="grid md:grid-cols-4 gap-3 text-[10px]">
                  <div><span className={muted}>Notification no.</span><p className={text}>{n.notification_number || '—'}</p></div>
                  <div><span className={muted}>Effective date</span><p className={text}>{n.effective_date || '—'}</p></div>
                  <div><span className={muted}>Sections</span><p className={text}>{n.affected_sections?.join(', ') || '—'}</p></div>
                  <div><span className={muted}>Forms</span><p className={text}>{n.affected_forms?.join(', ') || '—'}</p></div>
                </div>
                <div>
                  <p className={`text-xs font-semibold ${text} mb-1`}>Proposed updates</p>
                  {(n.proposed_rule_updates || []).map((r) => <div key={r.id} className={`rounded-lg border p-2 mb-1 text-[10px] ${isDark ? 'border-slate-700' : 'border-slate-200'}`}><b>{r.title}</b><div className={muted}>{r.instruction}</div></div>)}
                </div>
                <div>
                  <p className={`text-xs font-semibold ${text} mb-1`}>Extracted source text</p>
                  <pre className={`max-h-64 overflow-auto whitespace-pre-wrap text-[10px] leading-4 rounded-lg p-3 ${isDark ? 'bg-slate-950 text-slate-300' : 'bg-white text-slate-600 border border-slate-200'}`}>{n.extracted_text_preview || 'Source text stored on server.'}</pre>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className={`rounded-lg border p-3 text-[10px] ${isDark ? 'border-amber-900/50 bg-amber-950/20 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
        <b>Update safeguard:</b> uploaded documents are analysed into proposed rules. They do not silently change the legal engine. Approve only after checking the notification/circular against the current MCA/ICSI source and the company's facts.
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════════════
 * CS Practice Automation
 * ═══════════════════════════════════════════════════════════════════════ */
function CSPracticeAutomationTab({ company, plan, tasks, users, loading, isDark, input, text, muted, onRefresh }) {
  const currentYear = new Date().getFullYear();
  const defaultFY = new Date().getMonth() >= 3 ? `${currentYear}-${String(currentYear + 1).slice(-2)}` : `${currentYear - 1}-${String(currentYear).slice(-2)}`;
  const [fy, setFy] = useState(plan?.financial_year || defaultFY);
  const [assignee, setAssignee] = useState('');
  const [leadDays, setLeadDays] = useState(15);
  const [includeReview, setIncludeReview] = useState(true);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (plan?.financial_year) setFy(plan.financial_year);
  }, [plan?.financial_year]);

  useEffect(() => {
    if (!assignee && users?.length) setAssignee(users[0].id);
  }, [users, assignee]);

  const refresh = () => onRefresh(fy);

  const runAutomation = async () => {
    if (!company?.id) return;
    setRunning(true);
    try {
      const { data } = await api.post(`/roc-sphere/companies/${company.id}/cs-practice-plan/run`, {
        financial_year: fy,
        assignee_id: assignee || null,
        lead_days: Number(leadDays),
        include_review_tasks: includeReview,
        replace_existing: false,
      });
      toast.success(data?.message || 'CS practice tasks created');
      await onRefresh(fy);
    } catch (e) {
      toast.error(await parseBlobError(e) || 'Unable to run CS automation');
    } finally {
      setRunning(false);
    }
  };

  const summary = tasks?.summary || { total: 0, completed: 0, pending: 0, overdue: 0, due_30_days: 0 };
  const statusClass = (status) => status === 'completed' ? 'text-emerald-600 bg-emerald-50 border-emerald-200' : 'text-amber-700 bg-amber-50 border-amber-200';

  return (
    <div className="space-y-4">
      <div className={`rounded-2xl border p-4 ${isDark ? 'bg-gradient-to-br from-slate-900 to-slate-800 border-slate-700' : 'bg-gradient-to-br from-blue-50 to-white border-blue-100'}`}>
        <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
          <div className="flex gap-3">
            <div className="h-10 w-10 rounded-xl bg-blue-600 text-white flex items-center justify-center shrink-0"><Zap size={19}/></div>
            <div>
              <h3 className={`font-bold ${text}`}>CS Practice Automation</h3>
              <p className={`text-xs mt-1 ${muted}`}>Turn the company's annual ROC obligations into a structured CS work-plan and push the work directly into Taskosphere.</p>
            </div>
          </div>
          <button onClick={refresh} disabled={loading} className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold bg-white/70 dark:bg-slate-900/50 border-slate-300 dark:border-slate-700">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''}/> Refresh plan
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-4">
          <label className="block"><span className={`text-[10px] uppercase font-bold ${muted}`}>Financial Year</span><select value={fy} onChange={e => setFy(e.target.value)} className={input}><option>{defaultFY}</option><option>{currentYear + 1}-{String(currentYear + 2).slice(-2)}</option><option>{currentYear - 1}-{String(currentYear).slice(-2)}</option></select></label>
          <label className="block"><span className={`text-[10px] uppercase font-bold ${muted}`}>Assign Tasks To</span><select value={assignee} onChange={e => setAssignee(e.target.value)} className={input}><option value="">Myself</option>{users.map(u => <option key={u.id} value={u.id}>{u.full_name || u.username}</option>)}</select></label>
          <label className="block"><span className={`text-[10px] uppercase font-bold ${muted}`}>Lead Time</span><select value={leadDays} onChange={e => setLeadDays(e.target.value)} className={input}><option value="30">30 days before due</option><option value="15">15 days before due</option><option value="7">7 days before due</option><option value="0">On due date</option></select></label>
          <div className="flex items-end"><button onClick={runAutomation} disabled={running || !plan} className="w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold disabled:opacity-60"><Zap size={14}/>{running ? 'Creating practice tasks…' : 'Automate CS Practice'}</button></div>
        </div>
        <label className="inline-flex items-center gap-2 mt-3 text-xs cursor-pointer"><input type="checkbox" checked={includeReview} onChange={e => setIncludeReview(e.target.checked)} /> Include event-based / review tasks</label>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {[
          ['Total', summary.total, FileText], ['Completed', summary.completed, CheckCircle2], ['Pending', summary.pending, Clock3], ['Due ≤ 30 days', summary.due_30_days, CalendarDays], ['Overdue', summary.overdue, AlertTriangle],
        ].map(([label, value, Icon]) => <div key={label} className={`rounded-xl border p-3 ${cardStyle(isDark)}`}><div className={`text-[10px] uppercase font-bold ${muted}`}>{label}</div><div className={`text-xl font-bold mt-1 ${text}`}>{value}</div><Icon size={14} className={`mt-1 ${label === 'Overdue' && value ? 'text-red-500' : 'text-blue-500'}`}/></div>)}
      </div>

      <div className={`rounded-xl border overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
        <div className={`px-4 py-3 border-b flex items-center justify-between ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
          <div><h3 className={`font-semibold text-sm ${text}`}>Automated Secretarial Work-Plan</h3><p className={`text-[11px] ${muted}`}>{plan?.financial_year || fy} · {plan?.items?.length || 0} workflow items</p></div>
          <div className="flex items-center gap-2 text-[10px] font-semibold"><UsersRound size={13}/>{tasks?.tasks?.length || 0} tasks pushed to Taskosphere</div>
        </div>
        {loading && !plan ? <div className={`p-8 text-center text-sm ${muted}`}>Building compliance work-plan…</div> : (
          <div className="divide-y divide-slate-200 dark:divide-slate-700">
            {(plan?.items || []).map(item => {
              const task = (tasks?.tasks || []).find(t => t.roc_automation_key === item.key);
              return <div key={item.key} className={`px-4 py-3 flex items-center gap-3 ${isDark ? 'bg-slate-900/20' : 'bg-white'}`}>
                <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${item.event_based ? 'bg-amber-100 text-amber-700' : 'bg-blue-50 text-blue-600'}`}><CalendarDays size={14}/></div>
                <div className="min-w-0 flex-1"><div className={`text-xs font-semibold ${text}`}>{item.title}</div><div className={`text-[10px] mt-0.5 ${muted}`}>{item.form || item.category} · {item.frequency}{item.due_date ? ` · Planned due ${new Date(item.due_date).toLocaleDateString('en-IN')}` : ' · Event-based review'}</div></div>
                <span className={`hidden sm:inline-flex px-2 py-1 rounded-full border text-[9px] font-bold ${task ? statusClass(task.status) : item.task_created ? 'text-blue-600 bg-blue-50 border-blue-200' : 'text-slate-500 bg-slate-50 border-slate-200'}`}>{task ? (task.status || 'pending') : item.task_created ? 'Created' : 'Plan only'}</span>
              </div>;
            })}
          </div>
        )}
      </div>

      <div className={`rounded-xl border p-3 text-[10px] ${isDark ? 'border-amber-900/50 bg-amber-950/20 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
        <b>CS practice safeguard:</b> this engine creates internal work-planning tasks and document/data chases. It does not certify legal applicability or submit forms to MCA automatically. Verify current MCA rules, actual event dates, client facts and filing prerequisites before submission.
      </div>
    </div>
  );
}

function cardStyle(isDark) {
  return isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200';
}

/* ═══════════════════════════════════════════════════════════════════════
 * New company modal — from scratch or prefilled from an existing client
 * ═══════════════════════════════════════════════════════════════════════ */

function NewCompanyModal({ isDark, input, text, muted, eligibleClients, onClose, onCreated }) {
  const [form, setForm] = useState(emptyCompanyForm());
  const [saving, setSaving] = useState(false);

  const fromClient = (clientId) => {
    if (!clientId) { setForm(emptyCompanyForm()); return; }
    const c = eligibleClients.find((x) => x.client_id === clientId);
    if (!c) return;
    const catMap = { pvt_ltd: 'private', PVT_LTD: 'private', public_ltd: 'public', section_8: 'section_8', llp: 'llp', LLP: 'llp', limited_liability_partnership: 'llp', opc: 'opc' };
    setForm((f) => ({
      ...f,
      client_id: c.client_id,
      company_name: c.company_name || '',
      category: catMap[c.client_type] || 'private',
      pan: c.pan || '',
      date_of_incorporation: (c.date_of_incorporation || '').slice(0, 10),
      registered_office_address: c.address || '',
    }));
  };

  const submit = async () => {
    if (!form.company_name.trim()) { toast.error('Company name is required'); return; }
    setSaving(true);
    try {
      const { data } = await api.post('/roc-sphere/companies', form);
      toast.success('Company added to ROC Sphere');
      onCreated(data);
    } catch (e) {
      toast.error(await parseBlobError(e) || 'Failed to create company');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-emerald-900/50 p-4" onClick={onClose}>
      <div className={`w-full max-w-lg rounded-xl border ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'} p-5`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className={`font-semibold ${text}`}>Add Company Manually</h3>
          <button onClick={onClose}><X size={18} className={muted} /></button>
        </div>
        <p className={`text-xs ${muted} mb-3`}>Companies from your Clients list sync in automatically — use this only for a company that isn't a Client yet.</p>

        {eligibleClients.length > 0 && (
          <div className="mb-3">
            <label className={`text-xs font-medium ${muted} mb-1 block`}>Or link it to an unsynced client instead</label>
            <select className={input} onChange={(e) => fromClient(e.target.value)} defaultValue="">
              <option value="">— Start from scratch —</option>
              {eligibleClients.map((c) => (
                <option key={c.client_id} value={c.client_id}>{c.company_name} ({c.client_type})</option>
              ))}
            </select>
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className={`text-xs font-medium ${muted} mb-1 block`}>Company Name *</label>
            <input className={input} value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={`text-xs font-medium ${muted} mb-1 block`}>Category</label>
              <select className={input} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div>
              <label className={`text-xs font-medium ${muted} mb-1 block`}>CIN</label>
              <input className={input} value={form.cin} onChange={(e) => setForm({ ...form, cin: e.target.value.toUpperCase() })} placeholder="U12345GJ2020PTC000000" />
            </div>
          </div>
          <div>
            <label className={`text-xs font-medium ${muted} mb-1 block`}>Registered Office Address</label>
            <input className={input} value={form.registered_office_address} onChange={(e) => setForm({ ...form, registered_office_address: e.target.value })} />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className={`px-3 py-1.5 rounded-lg text-sm ${isDark ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>Cancel</button>
          <button onClick={submit} disabled={saving} className="px-4 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1.5 disabled:opacity-60">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Create
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Company Master tab
 * ═══════════════════════════════════════════════════════════════════════ */

function MasterTab({ company, isDark, onSave, input, text, muted }) {
  const [form, setForm] = useState(company);
  useEffect(() => setForm(company), [company]);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setNum = (k) => (e) => setForm({ ...form, [k]: parseFloat(e.target.value) || 0 });

  const Field = ({ label, k, type = 'text', numeric }) => (
    <div>
      <label className={`text-xs font-medium ${muted} mb-1 block`}>{label}</label>
      <input type={type} className={input} value={form[k] ?? ''} onChange={numeric ? setNum(k) : set(k)} />
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Company Name" k="company_name" />
        <Field label="CIN" k="cin" />
        <div>
          <label className={`text-xs font-medium ${muted} mb-1 block`}>Category</label>
          <select className={input} value={form.category} onChange={set('category')}>
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <Field label="PAN" k="pan" />
        <Field label="Date of Incorporation" k="date_of_incorporation" type="date" />
        <Field label="Financial Year End (MM-DD)" k="financial_year_end" />
        <Field label="Authorized Capital (Rs.)" k="authorized_capital" numeric />
        <Field label="Paid-up Capital (Rs.)" k="paid_up_capital" numeric />
        <Field label="Last Year's Turnover (Rs.)" k="last_year_turnover" numeric />
        <Field label="Last AGM Date" k="last_agm_date" type="date" />
        <Field label="Last Board Meeting Date" k="last_board_meeting_date" type="date" />
      </div>
      <div>
        <label className={`text-xs font-medium ${muted} mb-1 block`}>Registered Office Address</label>
        <textarea className={input} rows={2} value={form.registered_office_address || ''} onChange={set('registered_office_address')} />
      </div>

      <div className={`rounded-lg border p-3 ${isDark ? 'border-slate-700 bg-slate-900/40' : 'border-slate-200 bg-slate-50'}`}>
        <p className={`text-xs font-semibold ${muted} mb-2`}>Statutory Auditor</p>
        <div className="grid sm:grid-cols-2 gap-3">
          {['name', 'firm_reg_no', 'membership_no'].map((k) => (
            <div key={k}>
              <label className={`text-xs font-medium ${muted} mb-1 block capitalize`}>{k.replace(/_/g, ' ')}</label>
              <input className={input} value={form.auditor?.[k] || ''}
                onChange={(e) => setForm({ ...form, auditor: { ...(form.auditor || {}), [k]: e.target.value } })} />
            </div>
          ))}
        </div>
      </div>

      {company.financial_data && Object.keys(company.financial_data).length > 0 && (
        <div className={`rounded-lg border p-3 ${isDark ? 'border-slate-700 bg-slate-900/40' : 'border-slate-200 bg-slate-50'}`}>
          <p className={`text-xs font-semibold ${muted} mb-2`}>Financial Summary (from AOC-4)</p>
          <div className="grid sm:grid-cols-3 gap-3">
            {FINANCIAL_DATA_LABELS.map(([k, label]) => (
              company.financial_data[k] !== undefined && company.financial_data[k] !== null && company.financial_data[k] !== '' ? (
                <div key={k}>
                  <p className={`text-xs ${muted}`}>{label}</p>
                  <p className={`text-sm ${text}`}>
                    {typeof company.financial_data[k] === 'number'
                      ? company.financial_data[k].toLocaleString('en-IN')
                      : company.financial_data[k]}
                  </p>
                </div>
              ) : null
            ))}
          </div>
          <p className={`text-[11px] ${muted} mt-2`}>Auto-filled from the latest AOC-4 upload on the Upload ROC Forms tab — read-only here.</p>
        </div>
      )}

      <div>
        <label className={`text-xs font-medium ${muted} mb-1 block`}>Notes</label>
        <textarea className={input} rows={2} value={form.notes || ''} onChange={set('notes')} />
      </div>

      <button onClick={() => onSave(form)} className="px-4 py-2 rounded-lg text-sm bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1.5">
        <Save size={14} /> Save Company Master
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Master Data tab — dedicated MCA Master Data importer, separate code
 * path from the Upload ROC Forms tab (own endpoint, own component). Sits
 * right next to Company Master since it's the fastest way to fill it:
 * upload the MCA "Company/LLP Master Data" PDF/XLSX/CSV and fields are
 * fetched and applied automatically, mirroring Smart Import on Clients.
 * ═══════════════════════════════════════════════════════════════════════ */

function MasterDataTab({ company, isDark, text, muted, onApplied }) {
  const [files, setFiles] = useState([]);
  const [fetching, setFetching] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const boxRef = React.useRef(null);
  const master = company.master_data || {};

  const pickFiles = (list) => {
    const picked = Array.from(list || []);
    if (!picked.length) return;
    setFiles((prev) => [...prev, ...picked]);
  };

  const removeFile = (i) => setFiles((prev) => prev.filter((_, x) => x !== i));

  const onDrop = (e) => {
    e.preventDefault();
    boxRef.current?.classList.remove('ring-2', 'ring-blue-500');
    pickFiles(e.dataTransfer.files);
  };

  const fetchAndApply = async () => {
    if (!files.length) { toast.error('Choose the MCA Master Data file (PDF, XLSX or CSV) first'); return; }
    setFetching(true);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f));
      const { data } = await api.post(`/roc-sphere/companies/${company.id}/master-data/fetch`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setLastResult(data);
      if (data.applied) {
        setFiles([]);
        onApplied();
        toast.success(`Master Data fetched — ${data.fields_applied.length} field${data.fields_applied.length === 1 ? '' : 's'} updated on Company Master`, { duration: 5000 });
      } else {
        toast.error((data.errors && data.errors[0]) || 'Could not extract Master Data — please check the file');
      }
      if (data.errors?.length && data.applied) {
        data.errors.forEach((e) => toast.warning(e));
      }
    } catch (e) {
      toast.error(await parseBlobError(e) || 'Master Data fetch failed');
    } finally {
      setFetching(false);
    }
  };

  return (
    <div className="space-y-4">
      <h3 className={`text-sm font-semibold ${text}`}>Master Data</h3>
      <p className={`text-xs ${muted}`}>
        Upload the MCA "View Company/LLP Master Data" export (PDF, or an MCA master-data XLSX/CSV). Company Master
        fields and the Director/Signatory register are fetched and applied automatically — no manual review step,
        just like Smart Import on the Clients page. This uses its own extraction path, kept separate from
        Upload ROC Forms so a filing PDF never affects Master Data accuracy.
      </p>

      <div
        ref={boxRef}
        onDragOver={(e) => { e.preventDefault(); boxRef.current?.classList.add('ring-2', 'ring-blue-500'); }}
        onDragLeave={() => boxRef.current?.classList.remove('ring-2', 'ring-blue-500')}
        onDrop={onDrop}
        onClick={() => document.getElementById('_master_data_input')?.click()}
        className={`rounded-lg border-2 border-dashed p-6 text-center cursor-pointer transition ${isDark ? 'border-slate-700 hover:border-blue-500/60' : 'border-slate-300 hover:border-blue-400'}`}
      >
        <DatabaseZap size={22} className={`mx-auto mb-2 ${muted}`} />
        <p className={`text-xs font-semibold ${text}`}>Drop the MCA Master Data file here, or click to browse</p>
        <p className={`text-[11px] ${muted} mt-1`}>PDF, XLSX or CSV — multiple files are merged into one fetch</p>
        <input id="_master_data_input" type="file" multiple accept=".pdf,.xlsx,.xls,.csv"
          className="hidden" onChange={(e) => { pickFiles(e.target.files); e.target.value = ''; }} />
      </div>

      {!!files.length && (
        <div className={`rounded-lg border p-3 space-y-1.5 ${isDark ? 'border-slate-700 bg-slate-900/40' : 'border-slate-200 bg-slate-50'}`}>
          {files.map((f, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <span className={`flex items-center gap-1.5 ${text}`}><FileSpreadsheet size={13} /> {f.name}</span>
              <button onClick={() => removeFile(i)} className="text-red-500"><X size={13} /></button>
            </div>
          ))}
        </div>
      )}

      <button onClick={fetchAndApply} disabled={fetching || !files.length}
        className="px-4 py-2 rounded-lg text-sm bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1.5 disabled:opacity-60">
        {fetching ? <Loader2 size={14} className="animate-spin" /> : <DatabaseZap size={14} />}
        Fetch &amp; Apply Master Data
      </button>

      {lastResult?.applied && (
        <div className={`rounded-lg border p-3 ${isDark ? 'border-emerald-700/40 bg-emerald-900/10' : 'border-emerald-200 bg-emerald-50'}`}>
          <p className={`text-xs font-semibold flex items-center gap-1.5 ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
            <CheckCircle2 size={13} /> Applied to Company Master
          </p>
          <p className={`text-[11px] ${muted} mt-1`}>{lastResult.fields_applied.join(', ') || '—'}</p>
        </div>
      )}
      {!!lastResult?.errors?.length && (
        <div className={`rounded-lg border p-3 ${isDark ? 'border-amber-700/40 bg-amber-900/10' : 'border-amber-200 bg-amber-50'}`}>
          {lastResult.errors.map((e, i) => (
            <p key={i} className={`text-[11px] flex items-start gap-1.5 ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>
              <AlertTriangle size={12} className="shrink-0 mt-0.5" /> {e}
            </p>
          ))}
        </div>
      )}

      {(master.last_fetched_at || Object.keys(master).length > 0) && (
        <div className={`rounded-lg border p-3 text-xs space-y-1 ${isDark ? 'border-slate-700 bg-slate-900/40' : 'border-slate-200 bg-slate-50'}`}>
          <p className={`font-semibold ${muted} mb-1`}>Last fetched Master Data</p>
          {master.last_fetched_at && <p className={muted}>Fetched {new Date(master.last_fetched_at).toLocaleString('en-IN')}{master.last_fetched_by ? ` by ${master.last_fetched_by}` : ''}</p>}
          <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1 mt-2">
            {['roc_name', 'registration_number', 'email', 'company_status', 'roc_office', 'rd_region', 'date_of_balance_sheet', 'active_compliance'].map((k) => (
              master[k] ? (
                <div key={k} className="flex justify-between gap-2">
                  <span className={muted}>{k.replace(/_/g, ' ')}</span>
                  <span className={text}>{master[k]}</span>
                </div>
              ) : null
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Directors & Shareholders tab
 * ═══════════════════════════════════════════════════════════════════════ */

function DirectorsTab({ company, isDark, onSave, input, text, muted }) {
  const [directors, setDirectors] = useState(company.directors || []);
  const [designatedPartners, setDesignatedPartners] = useState(company.designated_partners || []);
  const [partners, setPartners] = useState(company.partners || []);
  const [shareholders, setShareholders] = useState(company.shareholders || []);
  const isLLP = company.category === 'llp';
  useEffect(() => {
    setDirectors(company.directors || []);
    setDesignatedPartners(company.designated_partners || []);
    setPartners(company.partners || []);
    setShareholders(company.shareholders || []);
  }, [company]);

  const addDirector = () => setDirectors([...directors, { name: '', din: '', designation: 'Director', date_of_appointment: '' }]);
  const addPerson = (setter, list, designation) => setter([...list, { name: '', din: '', designation, date_of_appointment: '' }]);
  const addShareholder = () => setShareholders([...shareholders, { name: '', folio_no: '', shares_held: 0, class_of_shares: 'Equity' }]);

  const totalShares = shareholders.reduce((s, sh) => s + (parseFloat(sh.shares_held) || 0), 0);
  const renderPeople = (title, list, setList, designationOptions) => (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className={`text-sm font-semibold ${text}`}>{title}</h4>
        <button onClick={() => addPerson(setList, list, designationOptions[0])} className="text-xs flex items-center gap-1 text-blue-500"><Plus size={13} /> Add {title.replace(/s$/, '')}</button>
      </div>
      <div className="space-y-2">
        {list.map((d, i) => (
          <div key={i} className={`grid grid-cols-12 gap-2 items-center p-2 rounded-lg ${isDark ? 'bg-slate-900/40' : 'bg-slate-50'}`}>
            <input className={`${input} col-span-3`} placeholder="Name" value={d.name || ''} onChange={(e) => { const c = [...list]; c[i] = { ...c[i], name: e.target.value }; setList(c); }} />
            <input className={`${input} col-span-2`} placeholder="DIN / PAN" value={d.din || d.pan || ''} onChange={(e) => { const c = [...list]; c[i] = { ...c[i], din: e.target.value }; setList(c); }} />
            <select className={`${input} col-span-3`} value={d.designation || designationOptions[0]} onChange={(e) => { const c = [...list]; c[i] = { ...c[i], designation: e.target.value }; setList(c); }}>
              {designationOptions.map((x) => <option key={x}>{x}</option>)}
            </select>
            <input type="date" className={`${input} col-span-3`} value={(d.date_of_appointment || '').slice(0, 10)} onChange={(e) => { const c = [...list]; c[i] = { ...c[i], date_of_appointment: e.target.value }; setList(c); }} />
            <button onClick={() => setList(list.filter((_, x) => x !== i))} className="col-span-1 text-red-500"><Trash2 size={14} /></button>
          </div>
        ))}
        {list.length === 0 && <p className={`text-xs ${muted}`}>No {title.toLowerCase()} added yet.</p>}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {!isLLP && <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className={`text-sm font-semibold ${text}`}>Directors</h4>
          <button onClick={addDirector} className="text-xs flex items-center gap-1 text-blue-500"><Plus size={13} /> Add Director</button>
        </div>
        <div className="space-y-2">
          {directors.map((d, i) => (
            <div key={i} className={`grid grid-cols-12 gap-2 items-center p-2 rounded-lg ${isDark ? 'bg-slate-900/40' : 'bg-slate-50'}`}>
              <input className={`${input} col-span-3`} placeholder="Name" value={d.name} onChange={(e) => { const c = [...directors]; c[i] = { ...c[i], name: e.target.value }; setDirectors(c); }} />
              <input className={`${input} col-span-2`} placeholder="DIN" value={d.din || ''} onChange={(e) => { const c = [...directors]; c[i] = { ...c[i], din: e.target.value }; setDirectors(c); }} />
              <select className={`${input} col-span-3`} value={d.designation || 'Director'} onChange={(e) => { const c = [...directors]; c[i] = { ...c[i], designation: e.target.value }; setDirectors(c); }}>
                {['Director', 'Managing Director', 'Whole-time Director', 'Additional Director', 'Independent Director', 'Nominee Director'].map((x) => <option key={x}>{x}</option>)}
              </select>
              <input type="date" className={`${input} col-span-3`} value={d.date_of_appointment || ''} onChange={(e) => { const c = [...directors]; c[i] = { ...c[i], date_of_appointment: e.target.value }; setDirectors(c); }} />
              <button onClick={() => setDirectors(directors.filter((_, x) => x !== i))} className="col-span-1 text-red-500"><Trash2 size={14} /></button>
            </div>
          ))}
          {directors.length === 0 && <p className={`text-xs ${muted}`}>No directors added yet.</p>}
        </div>
      </div>}

      {isLLP && renderPeople('Designated Partners', designatedPartners, setDesignatedPartners, ['Designated Partner', 'Designated Partner (Managing)'])}
      {isLLP && renderPeople('Partners', partners, setPartners, ['Partner', 'Nominee Partner'])}

      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className={`text-sm font-semibold ${text}`}>Shareholders {totalShares > 0 && <span className={`font-normal ${muted}`}>(Total: {totalShares.toLocaleString('en-IN')} shares)</span>}</h4>
          <button onClick={addShareholder} className="text-xs flex items-center gap-1 text-blue-500"><Plus size={13} /> Add Shareholder</button>
        </div>
        <div className="space-y-2">
          {shareholders.map((s, i) => (
            <div key={i} className={`grid grid-cols-12 gap-2 items-center p-2 rounded-lg ${isDark ? 'bg-slate-900/40' : 'bg-slate-50'}`}>
              <input className={`${input} col-span-3`} placeholder="Name" value={s.name} onChange={(e) => { const c = [...shareholders]; c[i] = { ...c[i], name: e.target.value }; setShareholders(c); }} />
              <input className={`${input} col-span-2`} placeholder="Folio / PAN" value={s.folio_no || ''} onChange={(e) => { const c = [...shareholders]; c[i] = { ...c[i], folio_no: e.target.value }; setShareholders(c); }} />
              <input className={`${input} col-span-2`} placeholder="Class" value={s.class_of_shares || 'Equity'} onChange={(e) => { const c = [...shareholders]; c[i] = { ...c[i], class_of_shares: e.target.value }; setShareholders(c); }} />
              <input type="number" className={`${input} col-span-3`} placeholder="Shares held" value={s.shares_held || 0} onChange={(e) => { const c = [...shareholders]; c[i] = { ...c[i], shares_held: parseFloat(e.target.value) || 0 }; setShareholders(c); }} />
              <button onClick={() => setShareholders(shareholders.filter((_, x) => x !== i))} className="col-span-1 text-red-500"><Trash2 size={14} /></button>
            </div>
          ))}
          {shareholders.length === 0 && <p className={`text-xs ${muted}`}>No shareholders added yet.</p>}
        </div>
      </div>

      <button onClick={() => onSave({ directors, designated_partners: designatedPartners, partners, shareholders })} className="px-4 py-2 rounded-lg text-sm bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1.5">
        <Save size={14} /> Save {isLLP ? 'Partners' : 'Directors'} & Shareholders
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Statutory registers — transfer register, SH-4 and share certificates
 * ═══════════════════════════════════════════════════════════════════════ */

function StatutoryRecordsTab({ company, isDark, input, text, muted, onApplied }) {
  const [mode, setMode] = useState('transfer');
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [data, setData] = useState(null);
  const [transfer, setTransfer] = useState({
    transfer_date: '', transferor_name: company.shareholders?.[0]?.name || '',
    transferee_name: '', transferor_folio_no: '', transferee_folio_no: '',
    share_certificate_no: '', distinctive_from: '', distinctive_to: '',
    number_of_shares: 0, class_of_shares: 'Equity', nominal_value_per_share: 10,
    consideration: 0, stamp_duty: 0, board_resolution_date: '',
    instrument_date: '', instrument_received_date: '', sh4_status: 'Pending review',
    remarks: '', update_register: true,
  });
  const [certificate, setCertificate] = useState({
    certificate_no: '', issue_date: '', holder_name: company.shareholders?.[0]?.name || '',
    holder_address: '', folio_no: '', class_of_shares: 'Equity', number_of_shares: 0,
    distinctive_from: '', distinctive_to: '', nominal_value_per_share: 10,
    amount_paid_per_share: 0, remarks: '',
  });

  const load = useCallback(async () => {
    try {
      const { data: d } = await api.get(`/roc-sphere/companies/${company.id}/statutory-records`);
      setData(d);
    } catch { toast.error('Failed to load statutory records'); }
  }, [company.id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!transfer.transferor_name && company.shareholders?.[0]?.name) {
      setTransfer((p) => ({ ...p, transferor_name: company.shareholders[0].name }));
    }
    if (!certificate.holder_name && company.shareholders?.[0]?.name) {
      setCertificate((p) => ({ ...p, holder_name: company.shareholders[0].name }));
    }
  }, [company.shareholders, transfer.transferor_name, certificate.holder_name]);

  const setTransferField = (key) => (e) => setTransfer((p) => ({
    ...p, [key]: ['number_of_shares', 'nominal_value_per_share', 'consideration', 'stamp_duty'].includes(key)
      ? (parseFloat(e.target.value) || 0) : e.target.value,
  }));
  const setCertificateField = (key) => (e) => setCertificate((p) => ({
    ...p, [key]: ['number_of_shares', 'nominal_value_per_share', 'amount_paid_per_share'].includes(key)
      ? (parseFloat(e.target.value) || 0) : e.target.value,
  }));
  const download = async (url, filename, payload) => {
    setGenerating(true);
    try {
      const res = payload
        ? await api.post(url, payload, { responseType: 'blob' })
        : await api.get(url, { responseType: 'blob' });
      triggerBlobDownload(res.data, filename);
      toast.success('Document downloaded');
    } catch (e) { toast.error(await parseBlobError(e) || 'Download failed'); }
    finally { setGenerating(false); }
  };
  const saveTransfer = async () => {
    if (!transfer.transferor_name || !transfer.transferee_name || !transfer.number_of_shares) {
      toast.error('Transferor, transferee and number of shares are required'); return;
    }
    setSaving(true);
    try {
      await api.post(`/roc-sphere/companies/${company.id}/share-transfers`, transfer);
      toast.success('Transfer added to the Share Transfer Register');
      await load(); onApplied();
      setTransfer((p) => ({ ...p, transferee_name: '', number_of_shares: 0, share_certificate_no: '' }));
    } catch (e) { toast.error(await parseBlobError(e) || 'Could not save transfer'); }
    finally { setSaving(false); }
  };
  const saveCertificate = async () => {
    if (!certificate.certificate_no || !certificate.holder_name || !certificate.number_of_shares) {
      toast.error('Certificate number, holder and number of shares are required'); return;
    }
    setSaving(true);
    try {
      await api.post(`/roc-sphere/companies/${company.id}/share-certificates`, certificate);
      toast.success('Share certificate record saved');
      await load(); onApplied();
    } catch (e) { toast.error(await parseBlobError(e) || 'Could not save certificate'); }
    finally { setSaving(false); }
  };
  const Field = ({ label, value, onChange, type = 'text', placeholder }) => (
    <div>
      <label className={`text-[11px] font-medium ${muted} mb-1 block`}>{label}</label>
      <input className={input} type={type} value={value ?? ''} onChange={onChange} placeholder={placeholder} />
    </div>
  );
  const transferUrlName = `SH-4_${(transfer.transferor_name || 'Transferor').replace(/\s+/g, '_')}_to_${(transfer.transferee_name || 'Transferee').replace(/\s+/g, '_')}.docx`;
  const certUrlName = `Share_Certificate_${(certificate.certificate_no || 'Draft')}.docx`;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className={`text-sm font-semibold ${text}`}>Statutory registers & instruments</h3>
          <p className={`text-xs ${muted} mt-1`}>Record reviewed transfers, keep holdings aligned, and prepare SH-4 / share certificate drafts.</p>
        </div>
        <button onClick={() => download(`/roc-sphere/companies/${company.id}/generate/share-transfer-register`, `Share_Transfer_Register_${company.company_name.replace(/\s+/g, '_')}.docx`)} disabled={generating}
          className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white disabled:opacity-60">
          <Download size={12} /> Download Transfer Register
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          ['members', 'Register of Members', BookOpen],
          ['share_transfer_register', 'Share Transfers', ArrowLeftRight],
          ['share_certificates', 'Certificates', BadgeCheck],
        ].map(([key, label, Icon]) => (
          <div key={key} className={`rounded-lg border p-3 ${isDark ? 'border-slate-700 bg-slate-900/40' : 'border-slate-200 bg-slate-50'}`}>
            <Icon size={15} className={data?.register_status?.[key] ? 'text-emerald-500' : muted} />
            <p className={`text-[11px] font-medium ${text} mt-2`}>{label}</p>
            <p className={`text-[10px] ${muted}`}>{data?.register_status?.[key] ? 'Data available' : 'Awaiting data'}</p>
          </div>
        ))}
      </div>
      <div className={`rounded-lg border p-4 ${isDark ? 'border-slate-700 bg-slate-900/30' : 'border-slate-200 bg-white'}`}>
        <div className="flex items-center gap-2 mb-3"><FileSpreadsheet size={15} className="text-blue-500" /><h4 className={`text-xs font-semibold ${text}`}>Current-year filing preparation</h4></div>
        <div className="grid sm:grid-cols-4 gap-3">
          {[
            ['Turnover', data?.annual_return_data?.turnover ?? data?.financial_data?.turnover ?? company.last_year_turnover, 'Rs.'],
            ['Net worth', data?.annual_return_data?.net_worth ?? data?.financial_data?.net_worth, 'Rs.'],
            ['AOC-4 period', data?.financial_data?.period_from && data?.financial_data?.period_to ? `${data.financial_data.period_from} → ${data.financial_data.period_to}` : 'Not uploaded', ''],
            ['Board meetings', data?.annual_return_data?.board_meetings_held ?? data?.board_report_data?.board_meetings_held, 'held'],
          ].map(([label, value, suffix]) => <div key={label}><p className={`text-[10px] ${muted}`}>{label}</p><p className={`text-xs font-medium ${text} mt-1`}>{value === undefined || value === null || value === '' ? 'Not extracted' : typeof value === 'number' ? `${value.toLocaleString('en-IN')} ${suffix}` : `${value} ${suffix}`}</p></div>)}
        </div>
        <p className={`text-[10px] ${muted} mt-3`}>Sources are kept separate: AOC-4 supplies financials and auditor details; MGT-7/MGT-7A supplies annual-return and member data; Board/Auditor reports supply disclosure context.</p>
      </div>

      <div className={`flex rounded-lg p-1 gap-1 ${isDark ? 'bg-slate-900' : 'bg-slate-100'}`}>
        <button onClick={() => setMode('transfer')} className={`flex-1 text-xs rounded-md py-2 ${mode === 'transfer' ? 'bg-white text-blue-600 shadow-sm' : muted}`}>Share Transfer / SH-4</button>
        <button onClick={() => setMode('certificate')} className={`flex-1 text-xs rounded-md py-2 ${mode === 'certificate' ? 'bg-white text-blue-600 shadow-sm' : muted}`}>Share Certificate (SH-1)</button>
      </div>

      {mode === 'transfer' ? (
        <div className={`rounded-lg border p-4 ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label="Transfer date" value={transfer.transfer_date} onChange={setTransferField('transfer_date')} type="date" />
            <Field label="Transferor / registered holder *" value={transfer.transferor_name} onChange={setTransferField('transferor_name')} />
            <Field label="Transferee *" value={transfer.transferee_name} onChange={setTransferField('transferee_name')} />
            <Field label="Transferor folio" value={transfer.transferor_folio_no} onChange={setTransferField('transferor_folio_no')} />
            <Field label="Transferee folio" value={transfer.transferee_folio_no} onChange={setTransferField('transferee_folio_no')} />
            <Field label="Existing share certificate no." value={transfer.share_certificate_no} onChange={setTransferField('share_certificate_no')} />
            <Field label="Distinctive no. from" value={transfer.distinctive_from} onChange={setTransferField('distinctive_from')} />
            <Field label="Distinctive no. to" value={transfer.distinctive_to} onChange={setTransferField('distinctive_to')} />
            <Field label="Number of shares *" value={transfer.number_of_shares} onChange={setTransferField('number_of_shares')} type="number" />
            <Field label="Nominal value per share" value={transfer.nominal_value_per_share} onChange={setTransferField('nominal_value_per_share')} type="number" />
            <Field label="Consideration (Rs.)" value={transfer.consideration} onChange={setTransferField('consideration')} type="number" />
            <Field label="Stamp duty (Rs.)" value={transfer.stamp_duty} onChange={setTransferField('stamp_duty')} type="number" />
            <Field label="Instrument date" value={transfer.instrument_date} onChange={setTransferField('instrument_date')} type="date" />
            <Field label="Instrument received date" value={transfer.instrument_received_date} onChange={setTransferField('instrument_received_date')} type="date" />
            <Field label="Board approval date" value={transfer.board_resolution_date} onChange={setTransferField('board_resolution_date')} type="date" />
            <div><label className={`text-[11px] font-medium ${muted} mb-1 block`}>SH-4 status</label><select className={input} value={transfer.sh4_status} onChange={setTransferField('sh4_status')}><option>Pending review</option><option>Received</option><option>Approved</option><option>Registered</option><option>Rejected</option></select></div>
          </div>
          <div className="mt-3"><label className={`text-[11px] font-medium ${muted} mb-1 block`}>Remarks</label><textarea className={input} rows={2} value={transfer.remarks} onChange={setTransferField('remarks')} /></div>
          <label className={`flex items-center gap-2 text-xs ${muted} mt-3`}><input type="checkbox" checked={transfer.update_register} onChange={(e) => setTransfer((p) => ({ ...p, update_register: e.target.checked }))} /> Update Register of Members after saving this reviewed transfer</label>
          <div className="flex flex-wrap gap-2 mt-4">
            <button onClick={() => download(`/roc-sphere/companies/${company.id}/generate/sh-4`, transferUrlName, transfer)} disabled={generating} className="px-3 py-2 rounded-lg text-xs bg-slate-700 text-white disabled:opacity-60"><Download size={12} className="inline mr-1" />Prepare SH-4 Draft</button>
            <button onClick={saveTransfer} disabled={saving} className="px-3 py-2 rounded-lg text-xs bg-blue-600 text-white disabled:opacity-60">{saving ? 'Saving…' : 'Save Transfer & Register'}</button>
          </div>
        </div>
      ) : (
        <div className={`rounded-lg border p-4 ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label="Certificate no. *" value={certificate.certificate_no} onChange={setCertificateField('certificate_no')} placeholder="e.g. 001" />
            <Field label="Issue date" value={certificate.issue_date} onChange={setCertificateField('issue_date')} type="date" />
            <Field label="Holder name *" value={certificate.holder_name} onChange={setCertificateField('holder_name')} />
            <Field label="Holder address" value={certificate.holder_address} onChange={setCertificateField('holder_address')} />
            <Field label="Folio no." value={certificate.folio_no} onChange={setCertificateField('folio_no')} />
            <Field label="Class of shares" value={certificate.class_of_shares} onChange={setCertificateField('class_of_shares')} />
            <Field label="Number of shares *" value={certificate.number_of_shares} onChange={setCertificateField('number_of_shares')} type="number" />
            <Field label="Distinctive no. from" value={certificate.distinctive_from} onChange={setCertificateField('distinctive_from')} />
            <Field label="Distinctive no. to" value={certificate.distinctive_to} onChange={setCertificateField('distinctive_to')} />
            <Field label="Nominal value per share" value={certificate.nominal_value_per_share} onChange={setCertificateField('nominal_value_per_share')} type="number" />
            <Field label="Amount paid per share" value={certificate.amount_paid_per_share} onChange={setCertificateField('amount_paid_per_share')} type="number" />
          </div>
          <div className="flex flex-wrap gap-2 mt-4">
            <button onClick={() => download(`/roc-sphere/companies/${company.id}/generate/share-certificate`, certUrlName, certificate)} disabled={generating} className="px-3 py-2 rounded-lg text-xs bg-slate-700 text-white disabled:opacity-60"><Download size={12} className="inline mr-1" />Prepare Certificate Draft</button>
            <button onClick={saveCertificate} disabled={saving} className="px-3 py-2 rounded-lg text-xs bg-blue-600 text-white disabled:opacity-60">{saving ? 'Saving…' : 'Save Certificate Record'}</button>
          </div>
        </div>
      )}

      {!!data?.share_transfers?.length && (
        <div>
          <h4 className={`text-xs font-semibold ${text} mb-2`}>Recorded transfers</h4>
          <div className="overflow-x-auto rounded-lg border border-slate-700/30"><table className="w-full text-[11px]"><thead className={isDark ? 'bg-slate-900' : 'bg-slate-100'}><tr>{['Date', 'Transferor', 'Transferee', 'Shares', 'SH-4 status'].map((h) => <th key={h} className={`text-left px-3 py-2 ${muted}`}>{h}</th>)}</tr></thead><tbody>{data.share_transfers.map((r) => <tr key={r.id} className={`border-t ${isDark ? 'border-slate-800' : 'border-slate-200'}`}><td className={`px-3 py-2 ${muted}`}>{r.transfer_date || '—'}</td><td className={`px-3 py-2 ${text}`}>{r.transferor_name}</td><td className={`px-3 py-2 ${text}`}>{r.transferee_name}</td><td className={`px-3 py-2 ${muted}`}>{Number(r.number_of_shares || 0).toLocaleString('en-IN')}</td><td className={`px-3 py-2 ${muted}`}>{r.sh4_status || 'Pending review'}</td></tr>)}</tbody></table></div>
        </div>
      )}
      <p className={`text-[11px] ${muted} flex items-start gap-1.5`}><AlertTriangle size={13} className="shrink-0 mt-0.5" />{data?.disclaimer || 'Working drafts must be checked against the executed instrument and applicable Companies Act requirements.'}</p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Shared: resolution-list editor used by Board Resolution + Notice(special business)
 * ═══════════════════════════════════════════════════════════════════════ */

function ResolutionListEditor({ items, setItems, input, muted }) {
  const add = () => setItems([...items, { particulars: '', resolution_text: '', proposed_by: '', seconded_by: '' }]);
  return (
    <div className="space-y-3">
      {items.map((r, i) => (
        <div key={i} className={`p-3 rounded-lg border ${muted.includes('slate-400') ? 'border-slate-700 bg-slate-900/40' : 'border-slate-200 bg-slate-50'} space-y-2`}>
          <div className="flex items-center justify-between">
            <span className={`text-xs font-semibold ${muted}`}>Resolution {i + 1}</span>
            <button onClick={() => setItems(items.filter((_, x) => x !== i))} className="text-red-500"><Trash2 size={13} /></button>
          </div>
          <input className={input} placeholder="Particulars (e.g. Opening of Bank Account)" value={r.particulars}
            onChange={(e) => { const c = [...items]; c[i] = { ...c[i], particulars: e.target.value }; setItems(c); }} />
          <textarea className={input} rows={2} placeholder='Resolution text — the part after "RESOLVED THAT ..."' value={r.resolution_text}
            onChange={(e) => { const c = [...items]; c[i] = { ...c[i], resolution_text: e.target.value }; setItems(c); }} />
          <div className="grid grid-cols-2 gap-2">
            <input className={input} placeholder="Proposed by" value={r.proposed_by} onChange={(e) => { const c = [...items]; c[i] = { ...c[i], proposed_by: e.target.value }; setItems(c); }} />
            <input className={input} placeholder="Seconded by" value={r.seconded_by} onChange={(e) => { const c = [...items]; c[i] = { ...c[i], seconded_by: e.target.value }; setItems(c); }} />
          </div>
        </div>
      ))}
      <button onClick={add} className="text-xs flex items-center gap-1 text-blue-500"><Plus size={13} /> Add Resolution</button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Board Resolution tab
 * ═══════════════════════════════════════════════════════════════════════ */

function ResolutionTab({ company, isDark, input, text, muted }) {
  const [templates, setTemplates] = useState([]);
  const [templateKey, setTemplateKey] = useState('');
  const [meetingDate, setMeetingDate] = useState('');
  const [meetingTime, setMeetingTime] = useState('11:00 AM');
  const [venue, setVenue] = useState('Registered Office of the Company');
  const [chairman, setChairman] = useState('');
  const [directorsPresent, setDirectorsPresent] = useState((company.directors || []).map((d) => d.name).join(', '));
  const [resolutions, setResolutions] = useState([{ particulars: '', resolution_text: '', proposed_by: '', seconded_by: '' }]);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    api.get('/roc-sphere/board-resolution-templates').then(({data}) => {
      setTemplates(data || []);
      if (data?.length) setTemplateKey(data[0].key);
    }).catch(() => toast.error('Unable to load Board Resolution templates'));
  }, []);

  const applyTemplate = (key) => {
    const t = templates.find((x) => x.key === key);
    if (!t) return;
    setResolutions([{
      particulars: t.title,
      resolution_text: t.resolution_text
        .replaceAll('[COMPANY NAME]', company.company_name || '')
        .replaceAll('[CIN]', company.cin || '')
        .replaceAll('[DIRECTOR NAME]', company.directors?.[0]?.name || '')
        .replaceAll('[DIN]', company.directors?.[0]?.din || '')
        .replaceAll('[REGISTERED OFFICE]', company.registered_office_address || 'Registered Office'),
      proposed_by: '',
      seconded_by: '',
    }]);
  };

  useEffect(() => {
    if (templateKey) applyTemplate(templateKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateKey, templates.length]);

  const generate = async () => {
    if (!meetingDate) { toast.error('Meeting date is required'); return; }
    if (!resolutions.length || !resolutions[0].resolution_text) { toast.error('Add at least one resolution'); return; }
    setGenerating(true);
    try {
      const payload = { meeting_date: meetingDate, meeting_time: meetingTime, venue, chairman,
        directors_present: directorsPresent.split(',').map((s) => s.trim()).filter(Boolean), resolutions };
      const res = await api.post(`/roc-sphere/companies/${company.id}/generate/board-resolution`, payload, { responseType: 'blob' });
      triggerBlobDownload(res.data, `Board_Resolution_${company.company_name.replace(/\s+/g, '_')}.docx`);
      toast.success('Board Resolution generated');
    } catch (e) {
      toast.error(await parseBlobError(e) || 'Generation failed');
    } finally { setGenerating(false); }
  };

  return (
    <div className="space-y-4">
      <div className={`rounded-lg border p-3 ${isDark ? 'border-slate-700 bg-slate-900/30' : 'border-slate-200 bg-slate-50'}`}>
        <p className={`text-xs font-semibold ${text}`}>ICSI Specimen Resolution Library</p>
        <p className={`text-[11px] mt-1 ${muted}`}>Templates are based on the specimen-resolution sections in the uploaded Company Law & Practice material. Review the current Act, Rules, Articles and notification updates before use.</p>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className={`text-xs font-medium ${muted} mb-1 block`}>Specimen / Resolution Type</label>
          <select className={input} value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
            {templates.map((t) => <option key={t.key} value={t.key}>{t.category} — {t.title}</option>)}
          </select>
        </div>
        <div className="flex items-end">
          <button onClick={() => applyTemplate(templateKey)} className="px-3 py-2 rounded-lg bg-slate-700 text-white text-xs">Load Specimen Format</button>
        </div>
      </div>
      <div className="grid sm:grid-cols-3 gap-3">
        <div><label className={`text-xs font-medium ${muted} mb-1 block`}>Meeting Date *</label><input type="date" className={input} value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} /></div>
        <div><label className={`text-xs font-medium ${muted} mb-1 block`}>Time</label><input className={input} value={meetingTime} onChange={(e) => setMeetingTime(e.target.value)} /></div>
        <div><label className={`text-xs font-medium ${muted} mb-1 block`}>Venue</label><input className={input} value={venue} onChange={(e) => setVenue(e.target.value)} /></div>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div><label className={`text-xs font-medium ${muted} mb-1 block`}>Chairman</label><input className={input} value={chairman} onChange={(e) => setChairman(e.target.value)} /></div>
        <div><label className={`text-xs font-medium ${muted} mb-1 block`}>Directors Present (comma separated)</label><input className={input} value={directorsPresent} onChange={(e) => setDirectorsPresent(e.target.value)} /></div>
      </div>
      <ResolutionListEditor items={resolutions} setItems={setResolutions} input={input} muted={muted} />
      <button onClick={generate} disabled={generating} className="px-4 py-2 rounded-lg text-sm bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1.5 disabled:opacity-60">
        {generating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Generate Board Resolution (.docx)
      </button>
    </div>
  );
}

function NoticeTab({ company, isDark, input, text, muted }) {
  const [meetingType, setMeetingType] = useState('board');
  const [meetingDate, setMeetingDate] = useState('');
  const [meetingTime, setMeetingTime] = useState('11:00 AM');
  const [venue, setVenue] = useState('Registered Office of the Company');
  const [agendaText, setAgendaText] = useState('');
  const [specialBusiness, setSpecialBusiness] = useState([]);
  const [generating, setGenerating] = useState(false);

  const generate = async () => {
    if (!meetingDate) { toast.error('Meeting date is required'); return; }
    setGenerating(true);
    try {
      const payload = {
        meeting_type: meetingType, meeting_date: meetingDate, meeting_time: meetingTime, venue,
        agenda_items: agendaText.split('\n').map((s) => s.trim()).filter(Boolean),
        special_business: specialBusiness,
      };
      const res = await api.post(`/roc-sphere/companies/${company.id}/generate/notice`, payload, { responseType: 'blob' });
      triggerBlobDownload(res.data, `Notice_${meetingType.toUpperCase()}_${company.company_name.replace(/\s+/g, '_')}.docx`);
      toast.success('Notice generated');
    } catch (e) {
      toast.error(await parseBlobError(e) || 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className={`text-xs ${muted}`}>Board Meeting notice needs no minimum notice period under SS-1 unless the AoA says otherwise; General Meeting (AGM/EGM) notices generally require 21 clear days — check applicability of shorter notice.</p>
      <div className="grid sm:grid-cols-4 gap-3">
        <div>
          <label className={`text-xs font-medium ${muted} mb-1 block`}>Meeting Type</label>
          <select className={input} value={meetingType} onChange={(e) => setMeetingType(e.target.value)}>
            <option value="board">Board Meeting</option>
            <option value="agm">Annual General Meeting (AGM)</option>
            <option value="egm">Extra-Ordinary General Meeting (EGM)</option>
          </select>
        </div>
        <div><label className={`text-xs font-medium ${muted} mb-1 block`}>Meeting Date *</label><input type="date" className={input} value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} /></div>
        <div><label className={`text-xs font-medium ${muted} mb-1 block`}>Time</label><input className={input} value={meetingTime} onChange={(e) => setMeetingTime(e.target.value)} /></div>
        <div><label className={`text-xs font-medium ${muted} mb-1 block`}>Venue</label><input className={input} value={venue} onChange={(e) => setVenue(e.target.value)} /></div>
      </div>
      <div>
        <label className={`text-xs font-medium ${muted} mb-1 block`}>Agenda / Ordinary Business (one per line)</label>
        <textarea className={input} rows={4} value={agendaText} onChange={(e) => setAgendaText(e.target.value)}
          placeholder={'To confirm the minutes of the previous meeting\nTo consider and approve the financial statements\n...'} />
      </div>
      <div>
        <label className={`text-xs font-medium ${muted} mb-1 block`}>Special Business (optional)</label>
        <ResolutionListEditor items={specialBusiness} setItems={setSpecialBusiness} input={input} muted={muted} />
      </div>
      <button onClick={generate} disabled={generating} className="px-4 py-2 rounded-lg text-sm bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1.5 disabled:opacity-60">
        {generating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Generate Notice (.docx)
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Minutes of Meeting tab
 * ═══════════════════════════════════════════════════════════════════════ */

function MinutesTab({ company, isDark, input, text, muted }) {
  const [meetingType, setMeetingType] = useState('board');
  const [meetingDate, setMeetingDate] = useState('');
  const [meetingTime, setMeetingTime] = useState('11:00 AM');
  const [venue, setVenue] = useState('Registered Office of the Company');
  const [chairman, setChairman] = useState('');
  const [directorsPresent, setDirectorsPresent] = useState((company.directors || []).map((d) => d.name).join(', '));
  const [directorsAbsent, setDirectorsAbsent] = useState('');
  const [attendeesOther, setAttendeesOther] = useState('');
  const [discussion, setDiscussion] = useState('');
  const [resolutions, setResolutions] = useState([]);
  const [generating, setGenerating] = useState(false);

  const generate = async () => {
    if (!meetingDate) { toast.error('Meeting date is required'); return; }
    setGenerating(true);
    try {
      const payload = {
        meeting_type: meetingType, meeting_date: meetingDate, meeting_time: meetingTime, venue, chairman,
        directors_present: directorsPresent.split(',').map((s) => s.trim()).filter(Boolean),
        directors_absent: directorsAbsent.split(',').map((s) => s.trim()).filter(Boolean),
        attendees_other: attendeesOther.split(',').map((s) => s.trim()).filter(Boolean),
        quorum_present: true,
        discussion_notes: discussion,
        resolutions,
      };
      const res = await api.post(`/roc-sphere/companies/${company.id}/generate/minutes`, payload, { responseType: 'blob' });
      triggerBlobDownload(res.data, `Minutes_${meetingType.toUpperCase()}_${company.company_name.replace(/\s+/g, '_')}.docx`);
      toast.success('Minutes generated');
    } catch (e) {
      toast.error(await parseBlobError(e) || 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className={`text-xs ${muted}`}>Minutes must be entered in the Minutes Book within 30 days of the meeting (Sec. 118) and signed by the Chairman.</p>
      <div className="grid sm:grid-cols-4 gap-3">
        <div>
          <label className={`text-xs font-medium ${muted} mb-1 block`}>Meeting Type</label>
          <select className={input} value={meetingType} onChange={(e) => setMeetingType(e.target.value)}>
            <option value="board">Board Meeting</option>
            <option value="agm">Annual General Meeting (AGM)</option>
            <option value="egm">Extra-Ordinary General Meeting (EGM)</option>
          </select>
        </div>
        <div><label className={`text-xs font-medium ${muted} mb-1 block`}>Meeting Date *</label><input type="date" className={input} value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} /></div>
        <div><label className={`text-xs font-medium ${muted} mb-1 block`}>Time</label><input className={input} value={meetingTime} onChange={(e) => setMeetingTime(e.target.value)} /></div>
        <div><label className={`text-xs font-medium ${muted} mb-1 block`}>Venue</label><input className={input} value={venue} onChange={(e) => setVenue(e.target.value)} /></div>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div><label className={`text-xs font-medium ${muted} mb-1 block`}>Chairman</label><input className={input} value={chairman} onChange={(e) => setChairman(e.target.value)} /></div>
        <div><label className={`text-xs font-medium ${muted} mb-1 block`}>Present (comma separated)</label><input className={input} value={directorsPresent} onChange={(e) => setDirectorsPresent(e.target.value)} /></div>
        <div><label className={`text-xs font-medium ${muted} mb-1 block`}>Absent / Leave granted</label><input className={input} value={directorsAbsent} onChange={(e) => setDirectorsAbsent(e.target.value)} /></div>
        <div><label className={`text-xs font-medium ${muted} mb-1 block`}>Other attendees (auditor, CS, invitees)</label><input className={input} value={attendeesOther} onChange={(e) => setAttendeesOther(e.target.value)} /></div>
      </div>
      <div>
        <label className={`text-xs font-medium ${muted} mb-1 block`}>Discussion Notes (optional)</label>
        <textarea className={input} rows={2} value={discussion} onChange={(e) => setDiscussion(e.target.value)} />
      </div>
      <div>
        <label className={`text-xs font-medium ${muted} mb-1 block`}>Resolutions Passed</label>
        <ResolutionListEditor items={resolutions} setItems={setResolutions} input={input} muted={muted} />
      </div>
      <button onClick={generate} disabled={generating} className="px-4 py-2 rounded-lg text-sm bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1.5 disabled:opacity-60">
        {generating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Generate Minutes (.docx)
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Compliance Checklist tab
 * ═══════════════════════════════════════════════════════════════════════ */

function ChecklistTab({ company, isDark, text, muted }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { data: d } = await api.get(`/roc-sphere/companies/${company.id}/compliance-checklist`);
        setData(d);
      } catch {
        toast.error('Failed to compute checklist');
      } finally {
        setLoading(false);
      }
    })();
  }, [company.id]);

  const downloadShareholders = async () => {
    try {
      const res = await api.get(`/roc-sphere/companies/${company.id}/generate/shareholders`, { responseType: 'blob' });
      triggerBlobDownload(res.data, `Shareholders_${company.company_name.replace(/\s+/g, '_')}.docx`);
    } catch (e) { toast.error(await parseBlobError(e) || 'Download failed'); }
  };

  const downloadChecklist = async () => {
    setDownloading(true);
    try {
      const res = await api.get(`/roc-sphere/companies/${company.id}/generate/checklist`, { responseType: 'blob' });
      triggerBlobDownload(res.data, `Compliance_Checklist_${company.company_name.replace(/\s+/g, '_')}.docx`);
    } catch (e) { toast.error(await parseBlobError(e) || 'Download failed'); } finally { setDownloading(false); }
  };

  if (loading) return <div className="flex justify-center py-10"><Loader2 className="animate-spin" size={20} /></div>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className={`text-xs ${muted} flex items-center gap-1.5`}>
          <Info size={13} /> {data.is_small_company ? 'Classified as a Small Company' : 'Not classified as a Small Company'} based on current capital/turnover.
        </div>
        <div className="flex gap-2">
          <button onClick={downloadShareholders} className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-600/20 text-slate-500 hover:bg-slate-600/30">
            <Download size={12} /> Shareholder Register
          </button>
          <button onClick={downloadChecklist} disabled={downloading} className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60">
            {downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} Download Checklist (.docx)
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-700/40">
        <table className="w-full text-xs">
          <thead className={isDark ? 'bg-slate-900/60' : 'bg-slate-100'}>
            <tr>
              {['Form / Item', 'Particulars', 'Due Date Rule', 'Frequency', 'Applicable'].map((h) => (
                <th key={h} className={`text-left px-3 py-2 font-semibold ${muted}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.checklist.map((item, i) => (
              <tr key={i} className={`border-t ${isDark ? 'border-slate-800' : 'border-slate-200'} ${!item.applicable ? 'opacity-40' : ''}`}>
                <td className={`px-3 py-2 font-medium ${text}`}>{item.form}</td>
                <td className={`px-3 py-2 ${muted}`}>{item.particulars}{item.notes && <span className="block text-[10px] italic">{item.notes}</span>}</td>
                <td className={`px-3 py-2 ${muted}`}>{item.due_date_rule}</td>
                <td className={`px-3 py-2 ${muted}`}>{item.frequency}</td>
                <td className="px-3 py-2">
                  {item.applicable ? <CheckCircle2 size={14} className="text-emerald-500" /> : <span className={muted}>N/A</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={`text-[11px] ${muted} flex items-start gap-1.5`}>
        <AlertTriangle size={13} className="shrink-0 mt-0.5" /> {data.disclaimer}
      </p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Applicable Compliances tab — dashboard view next to Compliance
 * Checklist. Same checklist engine, but only the applicable items,
 * grouped by frequency. Reads live off whatever Upload ROC Forms /
 * Master Data have applied to the Company Master, so it always reflects
 * the latest uploaded data with no extra wiring.
 * ═══════════════════════════════════════════════════════════════════════ */

function ApplicableCompliancesTab({ company, isDark, text, muted }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { data: d } = await api.get(`/roc-sphere/companies/${company.id}/applicable-compliances`);
        setData(d);
      } catch {
        toast.error('Failed to load applicable compliances');
      } finally {
        setLoading(false);
      }
    })();
  }, [company.id]);

  if (loading) return <div className="flex justify-center py-10"><Loader2 className="animate-spin" size={20} /></div>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className={`rounded-lg border px-3 py-2 ${isDark ? 'border-slate-700 bg-slate-900/40' : 'border-slate-200 bg-slate-50'}`}>
          <p className={`text-lg font-bold ${text}`}>{data.total_applicable}</p>
          <p className={`text-[10px] ${muted}`}>Applicable Forms</p>
        </div>
        <div className={`rounded-lg border px-3 py-2 ${isDark ? 'border-slate-700 bg-slate-900/40' : 'border-slate-200 bg-slate-50'}`}>
          <p className={`text-lg font-bold ${text}`}>{data.total_forms_tracked}</p>
          <p className={`text-[10px] ${muted}`}>Total Forms Tracked</p>
        </div>
        {data.master_data_last_fetched && (
          <div className={`text-xs ${muted} flex items-center gap-1.5`}>
            <DatabaseZap size={13} /> Master Data last fetched {new Date(data.master_data_last_fetched).toLocaleDateString('en-IN')}
          </div>
        )}
        {!!data.roc_forms_uploaded && (
          <div className={`text-xs ${muted} flex items-center gap-1.5`}>
            <FileUp size={13} /> {data.roc_forms_uploaded} ROC form{data.roc_forms_uploaded === 1 ? '' : 's'} uploaded
          </div>
        )}
      </div>

      {data.groups.map((g) => (
        <div key={g.frequency} className={`rounded-lg border ${isDark ? 'border-slate-700' : 'border-slate-200'} overflow-hidden`}>
          <div className={`px-3 py-2 text-xs font-semibold ${isDark ? 'bg-slate-900/60 text-slate-200' : 'bg-slate-100 text-slate-700'}`}>
            {g.frequency} <span className={muted}>({g.items.length})</span>
          </div>
          <div className={`divide-y ${isDark ? 'divide-slate-800' : 'divide-slate-200'}`}>
            {g.items.map((item, i) => (
              <div key={i} className="px-3 py-2 flex items-start gap-2">
                <CheckCircle2 size={14} className="text-emerald-500 shrink-0 mt-0.5" />
                <div>
                  <p className={`text-xs font-medium ${text}`}>{item.form} <span className={`font-normal ${muted}`}>— {item.particulars}</span></p>
                  <p className={`text-[11px] ${muted}`}>{item.due_date_rule}{item.notes ? ` · ${item.notes}` : ''}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      <p className={`text-[11px] ${muted} flex items-start gap-1.5`}>
        <AlertTriangle size={13} className="shrink-0 mt-0.5" /> {data.disclaimer}
      </p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * Upload AOC-4 / MGT-7 tab
 * ═══════════════════════════════════════════════════════════════════════ */

function UploadTab({ company, isDark, input, text, muted, onApplied }) {
  const [rocFiles, setRocFiles] = useState([]);
  const [extracting, setExtracting] = useState(false);
  const [extracted, setExtracted] = useState(null);
  const [results, setResults] = useState([]);
  const [errors, setErrors] = useState([]);
  const [conflicts, setConflicts] = useState([]);

  // ROC Forms filing-extraction path — separate endpoint/parser from the
  // Master Data tab (see MasterDataTab above / /master-data/fetch below).
  const handleUpload = async (apply) => {
    if (!rocFiles.length) { toast.error('Choose at least one ROC form or MGT-7/MGT-7A attachment first'); return; }
    setExtracting(true);
    try {
      const fd = new FormData();
      rocFiles.forEach((file) => fd.append('files', file));
      fd.append('source_type', 'roc');
      fd.append('apply', apply ? 'true' : 'false');
      const { data } = await api.post(`/roc-sphere/companies/${company.id}/upload-master-data`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setExtracted(data.extracted);
      setResults(data.results || []);
      setErrors(data.errors || []);
      setConflicts(data.conflicts || []);
      const hasFields = Object.keys(data.extracted || {}).some((k) => !k.startsWith('_') && (
        !['annual_return_data', 'audit_report_data', 'board_report_data'].includes(k)
        || Object.keys(data.extracted[k] || {}).length
      ));
      if (apply && data.applied) {
        toast.success('Company master updated from uploaded ROC forms');
        onApplied();
      } else if (!hasFields) {
        toast.error(data.message || 'Could not extract fields — please enter manually');
      } else {
        toast.success('Fields extracted — review below, then Apply');
      }
      if (data.errors?.length) data.errors.forEach((e) => toast.warning(e));
    } catch (e) {
      toast.error(await parseBlobError(e) || 'Upload failed');
    } finally {
      setExtracting(false);
    }
  };

  return (
    <div className="space-y-4">
      <h3 className={`text-sm font-semibold ${text}`}>Upload ROC Forms</h3>
      <p className={`text-xs ${muted}`}>
         Upload AOC-4, MGT-7/MGT-7A, the separate MGT-7A shareholder XLSM, Board's/Auditor's Report extracts, DIR-12, ADT-1, INC-22, PAS-3, MGT-14 or
         DPT-3 acknowledgement files — multiple PDFs and spreadsheets are merged into one extraction, and each field is only ever
        pulled from its statutory source form: the <strong>Directors &amp; Shareholders register comes only from
        MGT-7 / MGT-7A</strong>, <strong>financial data and the Statutory Auditor come only from AOC-4</strong>, and
        general Company Master fields (CIN, name, address, capital, AGM/board meeting dates) are read from whichever
        recognised form states them. A non-MGT-7/7A form can never add or change a director or shareholder row.
        Applied details are saved in both ROC Company Master and the linked Client record, and feed straight into
        the Compliance Checklist and Applicable Compliances tabs.{' '}
        For the MCA Company/LLP Master Data export (PDF/XLSX/CSV), use the <strong>Master Data</strong> tab instead —
        that's a separate, dedicated extraction path.
      </p>
      <div className={`rounded-lg border-2 border-dashed p-4 ${isDark ? 'border-slate-700' : 'border-slate-300'}`}>
        <p className={`text-xs font-semibold ${text} mb-1`}>ROC Forms (filing extraction)</p>
         <p className={`text-[11px] ${muted} mb-3`}>PDF, XLSX, XLSM or CSV — the MGT-7A shareholder attachment is read without running macros.</p>
         <input type="file" multiple accept=".pdf,.xlsx,.xlsm,.xls,.csv" onChange={(e) => setRocFiles(Array.from(e.target.files || []))}
          className={`text-xs ${muted}`} />
        {!!rocFiles.length && <p className={`text-xs mt-2 ${text}`}>{rocFiles.length} ROC form(s) selected</p>}
        <div className="flex gap-2 mt-3">
          <button onClick={() => handleUpload(false)} disabled={extracting || !rocFiles.length}
            className={`px-3 py-1.5 rounded-lg text-xs flex items-center gap-1 disabled:opacity-60 ${isDark ? 'bg-slate-800 text-slate-200' : 'bg-slate-100 text-slate-700'}`}>
            {extracting ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />} Preview ROC Forms
          </button>
          <button onClick={() => handleUpload(true)} disabled={extracting || !rocFiles.length}
            className="px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white flex items-center gap-1 disabled:opacity-60">
            {extracting ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} Apply
          </button>
        </div>
      </div>

      {!!errors.length && (
        <div className={`rounded-lg border p-3 ${isDark ? 'border-amber-700/40 bg-amber-900/10' : 'border-amber-200 bg-amber-50'}`}>
          {errors.map((e, i) => (
            <p key={i} className={`text-[11px] flex items-start gap-1.5 ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>
              <AlertTriangle size={12} className="shrink-0 mt-0.5" /> {e}
            </p>
          ))}
        </div>
      )}
      {!!conflicts.length && (
        <div className={`rounded-lg border p-3 ${isDark ? 'border-orange-700/40 bg-orange-900/10' : 'border-orange-200 bg-orange-50'}`}>
          <p className={`text-xs font-semibold mb-1 ${isDark ? 'text-orange-300' : 'text-orange-800'}`}>Conflicting filing values — review before Apply</p>
          {conflicts.map((c, i) => <p key={i} className={`text-[11px] ${isDark ? 'text-orange-200' : 'text-orange-700'}`}>{c.field.replace(/_/g, ' ')}: kept “{String(c.kept)}”; previous “{String(c.previous)}” ({c.source})</p>)}
        </div>
      )}

      {extracted && (
        <div className={`rounded-lg border p-3 ${isDark ? 'border-slate-700 bg-slate-900/40' : 'border-slate-200 bg-slate-50'}`}>
          <p className={`text-xs font-semibold ${muted} mb-2`}>Extracted fields</p>
           {results.length > 0 && <p className={`text-[11px] ${muted} mb-2`}>{results.map((r) => `${r.filename} (${r.source_type}${r.shareholder_rows ? `, ${r.shareholder_rows} shareholder rows` : ''}${r.director_rows ? `, ${r.director_rows} director rows` : ''})`).join(' · ')}</p>}
          <div className="grid sm:grid-cols-2 gap-2 text-xs">
            {Object.entries(extracted).filter(([k, v]) => !k.startsWith('_') && !Array.isArray(v) && typeof v !== 'object' && !['financial_data', 'auditor'].includes(k)).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2">
                <span className={muted}>{k.replace(/_/g, ' ')}</span>
                <span className={text}>{String(v)}</span>
              </div>
            ))}
            {extracted.directors && (
              <div className="sm:col-span-2">
                <span className={muted}>directors / partners</span>
                <span className={`${text} block`}>{extracted.directors.map((p) => `${p.name}${p.din ? ` (${p.din})` : ''}`).join(', ')}</span>
              </div>
            )}
            {extracted.shareholders && (
              <div className="sm:col-span-2">
                <span className={muted}>shareholders</span>
                <span className={`${text} block`}>{extracted.shareholders.map((p) => `${p.name} — ${p.shares_held || 0} shares`).join(', ')}</span>
              </div>
            )}
            {extracted.financial_data && (
              <div className="sm:col-span-2">
                <span className={muted}>financial data (from AOC-4)</span>
                <span className={`${text} block`}>
                  {Object.entries(extracted.financial_data).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ')}
                </span>
              </div>
            )}
            {extracted.auditor && (
              <div className="sm:col-span-2">
                <span className={muted}>statutory auditor (from AOC-4)</span>
                <span className={`${text} block`}>
                  {Object.entries(extracted.auditor).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ')}
                </span>
              </div>
            )}
            {[
              ['annual_return_data', 'annual return data (from MGT-7/MGT-7A)'],
              ['audit_report_data', 'audit report data'],
              ['board_report_data', 'Board’s Report data'],
            ].map(([key, label]) => extracted[key] && Object.keys(extracted[key]).length > 0 && (
              <div key={key} className="sm:col-span-2">
                <span className={muted}>{label}</span>
                <span className={`${text} block`}>{Object.entries(extracted[key]).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</span>
              </div>
            ))}
            {!Object.keys(extracted).filter((k) => !k.startsWith('_') && !['directors', 'shareholders', 'financial_data', 'auditor', 'annual_return_data', 'audit_report_data', 'board_report_data'].includes(k)).length
              && !extracted.directors && !extracted.shareholders && !extracted.financial_data && !extracted.auditor
              && !extracted.annual_return_data && !extracted.audit_report_data && !extracted.board_report_data && (
              <p className={muted}>No fields could be confidently extracted from this file.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
