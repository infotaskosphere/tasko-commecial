import React, { useEffect, useMemo, useRef, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { toast } from 'sonner';
import {
  Landmark, Plus, UploadCloud, RefreshCw, CheckCircle2, AlertTriangle, AlertCircle, Sparkles, Check,
  Trash2, Link2, Unlink, X, ChevronRight, Search, Edit3, Eye, History, Ban, BookOpen,
  ShieldCheck, FileCheck2,
} from 'lucide-react';
import GifLoader, { MiniLoader, ContentLoader } from '@/components/ui/GifLoader.jsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import api from '@/lib/api';
import { normalizeCompanies } from "@/lib/companies";
import { useDark } from '@/hooks/useDark';
import { useAuth } from '@/contexts/AuthContext.jsx';
import RequestAccessGate from '@/components/RequestAccessGate.jsx';
import { mirrorBankToSettings, bankFromAccount } from '@/lib/bankSync';
import { GuidanceNote } from '@/components/ui/GuidanceNote.jsx';
import { useNavigate } from 'react-router-dom';
import ExistingRecordsPanel from '@/components/ExistingRecordsPanel.jsx';

const COLORS = { deepBlue: '#0D3B66', mediumBlue: '#1F6FB2', emeraldGreen: '#1FAF5A', amber: '#F59E0B', coral: '#FF6B6B' };
const fmtC = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const fmtDate = (value) => { if (!value) return '—'; try { return format(parseISO(value), 'dd MMM yyyy'); } catch { return value; } };

// ─── Field helpers ── invoices in this app store the invoice number as
// `invoice_no` and the party as `client_name` / `supplier_name` (see
// backend/invoicing.py). Older records may use `invoice_number` /
// `customer_name` / `vendor_name`, so keep the fallbacks. Without these,
// the match dialog rendered "— · —" for every row.
const invNumber = (inv) => inv?.invoice_no || inv?.invoice_number || inv?.number || inv?.bill_number || '';
const invParty = (inv) =>
  inv?.client_name || inv?.customer_name || inv?.supplier_name ||
  inv?.vendor_name || inv?.party_name || inv?.buyer_name || '';
const invAmount = (inv) => Number(inv?.grand_total || inv?.total || inv?.amount || 0);
const invDate = (inv) => inv?.invoice_date || inv?.date || inv?.bill_date;

// Clean numbers and special characters from bank description to get core merchant/party
const cleanDescription = (str) => {
  if (!str) return '';
  return str.toLowerCase()
    .replace(/[0-9]+/g, '')
    .replace(/[\/\-\_\.\,\:\;\*\&\#\@\(\)\+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

// Computes similarity score (0 to 100) between two transactions
const getTxnSimilarity = (t1, t2) => {
  const isDebit1 = Number(t1.debit || 0) > 0;
  const isDebit2 = Number(t2.debit || 0) > 0;
  if (isDebit1 !== isDebit2) return 0;

  const desc1 = cleanDescription(t1.description);
  const desc2 = cleanDescription(t2.description);
  if (desc1 === desc2 && desc1 !== '') return 100;
  if (!desc1 || !desc2) return 0;

  // Dice's Coefficient (bigram matching)
  const getBigrams = (str) => {
    const bigrams = new Set();
    for (let i = 0; i < str.length - 1; i++) {
      bigrams.add(str.slice(i, i + 2));
    }
    return bigrams;
  };
  const b1 = getBigrams(desc1);
  const b2 = getBigrams(desc2);
  if (b1.size === 0 || b2.size === 0) return 0;

  let intersection = 0;
  b1.forEach(b => {
    if (b2.has(b)) intersection++;
  });
  return Math.round((2 * intersection) / (b1.size + b2.size) * 100);
};

// ─── Smart suggestion scorer: amount, date, narration, party name, ───
// ─── invoice no, bank reference, GSTIN — returns a 0-99 confidence %. ───
function scoreInvoiceMatch(txn, inv) {
  let score = 0;
  const txnAmt = Number(txn.debit || txn.credit || 0);
  const invAmt = invAmount(inv);
  if (txnAmt > 0 && invAmt > 0) {
    const diff = Math.abs(txnAmt - invAmt) / Math.max(txnAmt, invAmt);
    if (diff < 0.001) score += 45;
    else if (diff < 0.02) score += 38;
    else if (diff < 0.05) score += 25;
    else if (diff < 0.1) score += 12;
  }
  try {
    const td = new Date(txn.date), id = new Date(invDate(inv));
    const days = Math.abs((td - id) / 86400000);
    if (days <= 1) score += 18;
    else if (days <= 7) score += 12;
    else if (days <= 30) score += 6;
  } catch {}
  const desc = ((txn.description || '') + ' ' + (txn.reference || '')).toLowerCase();
  const party = invParty(inv).toLowerCase();
  if (party && desc.includes(party.split(' ')[0])) score += 14;
  const invNo = invNumber(inv).toLowerCase();
  if (invNo && desc.includes(invNo)) score += 9;
  // Bank reference number — UTR/cheque/ref on the invoice matching the bank line's own reference column.
  const invRef = (inv.reference_number || inv.utr || inv.payment_reference || '').toLowerCase();
  if (invRef && (txn.reference || '').toLowerCase().includes(invRef)) score += 8;
  // GSTIN — occasionally present in narration for GST-linked NEFT/RTGS transfers.
  const gstin = (inv.gstin || inv.customer_gstin || inv.supplier_gstin || '').toLowerCase();
  if (gstin && desc.includes(gstin)) score += 6;
  return Math.min(99, Math.max(0, Math.round(score)));
}

function BankAccountsInner() {
  const navigate = useNavigate();
  const isDark = useDark();
  const { user, hasPermission } = useAuth();
  const canMatch = user?.role === 'admin' || hasPermission('can_match_bank');
  const fileRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [selected, setSelected] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [txnLoading, setTxnLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState(null);
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [form, setForm] = useState({ bank_name: '', account_holder: '', account_number: '', ifsc: '', branch: '', account_type: 'current', opening_balance: 0, upi_id: '', company_id: '' });
  const [savingAccount, setSavingAccount] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState(null);

  const openEditAccount = (a) => {
    setEditingAccountId(a.id);
    setForm({
      bank_name: a.bank_name || '',
      account_holder: a.account_holder || '',
      account_number: a.account_number_masked || '',
      ifsc: a.ifsc || '',
      branch: a.branch || '',
      account_type: a.account_type || 'current',
      opening_balance: a.opening_balance || 0,
      upi_id: a.upi_id || '',
      company_id: a.company_id || '',
    });
    setShowNewAccount(true);
  };

  // Manual match state
  const [filter, setFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState({});
  const [matchDialog, setMatchDialog] = useState(null);
  const [auditDialog, setAuditDialog] = useState(null);
  const [progress, setProgress] = useState(null);
  const [invoiceCache, setInvoiceCache] = useState([]);
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [loadedCompanyId, setLoadedCompanyId] = useState('');

  // States for manual purchase invoice creation
  const [showNewPurchaseForm, setShowNewPurchaseForm] = useState(false);
  const [newPurchaseForm, setNewPurchaseForm] = useState({ supplier_name: '', invoice_no: '', invoice_date: '', gst_rate: '18', grand_total: '' });
  const [savingPurchase, setSavingPurchase] = useState(false);

  // Ledger heads (chart of accounts) for the "Expense Head" tab + inline "Create head"
  const [ledgerCache, setLedgerCache] = useState([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [dialogTab, setDialogTab] = useState('invoice'); // 'invoice' | 'expense'
  const [showNewHead, setShowNewHead] = useState(false);
  const [newHead, setNewHead] = useState({ code: '', name: '', type: 'expense', sub_type: 'operating_expense' });
  const [savingHead, setSavingHead] = useState(false);

  // Direct expense account creation states
  const [showNewExpenseHeadForm, setShowNewExpenseHeadForm] = useState(false);
  const [newExpenseHead, setNewExpenseHead] = useState({ code: '', name: '' });
  const [savingExpenseHead, setSavingExpenseHead] = useState(false);

  // Futuristic AI Copilot & Fast Local Feed Search States
  const [txnSearchText, setTxnSearchText] = useState('');
  const [isAutoMatching, setIsAutoMatching] = useState(false);

  // ─── Pre-upload duplicate check + friendlier drop zone ────────────────
  const [showExistingRecords, setShowExistingRecords] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Helper to explain WHY an invoice has been suggested
  const getScoreReason = (txn, inv) => {
    const reasons = [];
    const txnAmt = Number(txn.debit || txn.credit || 0);
    const invAmt = invAmount(inv);
    if (txnAmt > 0 && invAmt > 0) {
      const diff = Math.abs(txnAmt - invAmt) / Math.max(txnAmt, invAmt);
      if (diff < 0.001) reasons.push('Exact amount match (+45%)');
      else if (diff < 0.02) reasons.push('Amount matches within 2% (+38%)');
      else if (diff < 0.05) reasons.push('Amount matches within 5% (+25%)');
    }
    try {
      const td = new Date(txn.date), id = new Date(invDate(inv));
      const days = Math.abs((td - id) / 86400000);
      if (days <= 1) reasons.push('Date within 1 day (+18%)');
      else if (days <= 7) reasons.push('Date within 7 days (+12%)');
      else if (days <= 30) reasons.push('Date within 30 days (+6%)');
    } catch {}
    const desc = ((txn.description || '') + ' ' + (txn.reference || '')).toLowerCase();
    const party = invParty(inv).toLowerCase();
    if (party && desc.includes(party.split(' ')[0])) reasons.push('Overlap in party name (+14%)');
    const invNo = invNumber(inv).toLowerCase();
    if (invNo && desc.includes(invNo)) reasons.push('Invoice ID in bank narrative (+9%)');
    const invRef = (inv.reference_number || inv.utr || inv.payment_reference || '').toLowerCase();
    if (invRef && (txn.reference || '').toLowerCase().includes(invRef)) reasons.push('Matching payment reference (+8%)');
    return reasons.join(' · ') || 'Partial Match (minimum score threshold met)';
  };

  const fetchAccounts = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/bank-accounts');
      setAccounts(data || []);
      if (data?.length && !selected) setSelected(data[0]);
    } catch { toast.error('Failed to load bank accounts'); }
    finally { setLoading(false); }
  };

  const fetchTransactions = async (bankAccountId) => {
    if (!bankAccountId) return;
    setTxnLoading(true);
    try {
      const { data } = await api.get(`/bank-accounts/${bankAccountId}/transactions`);
      setTransactions(data || []);
      setSelectedIds({});
    } catch { toast.error('Failed to load transactions'); }
    finally { setTxnLoading(false); }
  };

  useEffect(() => {
    fetchAccounts();
    api.get('/companies/list').then(r => setCompanies(normalizeCompanies(r))).catch(() => {});
  }, []);

  const stats = useMemo(() => {
    const totalBalance = accounts.reduce((s, a) => s + Number(a.current_balance || 0), 0);
    const matched = transactions.filter(t => t.matched_type).length;
    return { totalBalance, accountCount: accounts.length, matched, unmatched: transactions.length - matched };
  }, [accounts, transactions]);

  const visibleTxns = useMemo(() => {
    let list = transactions;
    if (filter === 'matched') list = transactions.filter(t => t.matched_type);
    else if (filter === 'unmatched') list = transactions.filter(t => !t.matched_type && !t.ignored);
    else if (filter === 'ignored') list = transactions.filter(t => t.ignored);

    if (txnSearchText.trim()) {
      const q = txnSearchText.toLowerCase();
      list = list.filter(t => {
        const desc = (t.description || '').toLowerCase();
        const ref = (t.reference || '').toLowerCase();
        const amtStr = String(t.debit || t.credit || '');
        const dateStr = fmtDate(t.date).toLowerCase();
        const matchLabel = (t.matched_label || '').toLowerCase();
        return desc.includes(q) || ref.includes(q) || amtStr.includes(q) || dateStr.includes(q) || matchLabel.includes(q);
      });
    }
    return list;
  }, [transactions, filter, txnSearchText]);

  const suggestionsFor = (txn) => {
    if (!invoiceCache.length || !txn) return [];
    const isDebit = Number(txn.debit || 0) > 0;
    return invoiceCache
      .filter(i => isDebit ? !!i.isPurchase : !i.isPurchase)
      .map(inv => ({ inv, score: scoreInvoiceMatch(txn, inv) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  };

  const copilotStats = useMemo(() => {
    const unmatched = transactions.filter(t => !t.matched_type && !t.ignored);
    let totalScore = 0;
    let counted = 0;
    let highConfCount = 0;

    unmatched.forEach(t => {
      const suggestions = suggestionsFor(t);
      if (suggestions.length && suggestions[0].score >= 80) {
        totalScore += suggestions[0].score;
        counted++;
        highConfCount++;
      } else {
        const desc = (t.description || '').toLowerCase();
        if (desc.includes('salary') || desc.includes('wages') || desc.includes('payroll') || desc.includes('rent') || desc.includes('lease') || desc.includes('interest') || desc.includes('audit') || desc.includes('professional') || desc.includes('office') || desc.includes('stationery')) {
          totalScore += 85;
          counted++;
          highConfCount++;
        }
      }
    });

    const avgScore = counted > 0 ? Math.round(totalScore / counted) : 0;
    return { avgScore, highConfCount };
  }, [transactions, invoiceCache]);

  const autoMatchAllHighConfidence = async () => {
    if (!selected) return;
    const unmatched = transactions.filter(t => !t.matched_type && !t.ignored);
    if (!unmatched.length) {
      toast.info('No unmatched transactions found.');
      return;
    }
    
    if (!window.confirm(`Found ${unmatched.length} unmatched transactions. Run advanced AI Auto-Matching now? This will map transactions to matching invoices and ledger accounts.`)) {
      return;
    }

    setIsAutoMatching(true);
    try {
      const { data } = await api.post('/bank-transactions/ai-auto-match', {
        bank_account_id: selected.id
      });
      if (data.success) {
        toast.success(data.message || 'Successfully auto-matched transactions!');
        await fetchAccounts();
        await fetchTransactions(selected.id);
      } else {
        toast.error(data.error || 'Error during AI auto-matching');
      }
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.detail || 'Error during AI auto-matching');
    } finally {
      setIsAutoMatching(false);
    }
  };

  const createAccount = async () => {
    if (!form.bank_name.trim()) { toast.error('Bank name is required'); return; }
    setSavingAccount(true);
    try {
      if (editingAccountId) {
        await api.put(`/bank-accounts/${editingAccountId}`, form);
        if (form.company_id) mirrorBankToSettings(form.company_id, bankFromAccount({ ...form, account_number_full: form.account_number }));
        toast.success(form.company_id ? 'Bank account updated & synced to invoice/quotation settings' : 'Bank account updated');
      } else {
        await api.post('/bank-accounts', form);
        if (form.company_id) mirrorBankToSettings(form.company_id, bankFromAccount(form));
        toast.success(form.company_id ? 'Bank account added & synced to invoice/quotation settings' : 'Bank account added');
      }
      setShowNewAccount(false);
      setEditingAccountId(null);
      setForm({ bank_name: '', account_holder: '', account_number: '', ifsc: '', branch: '', account_type: 'current', opening_balance: 0, upi_id: '', company_id: '' });
      await fetchAccounts();
    } catch (err) { toast.error(err.response?.data?.detail || 'Failed to save bank account'); }
    finally { setSavingAccount(false); }
  };

  const deleteAccount = async (id) => {
    if (!window.confirm('Delete this bank account and all its transactions?')) return;
    try {
      await api.delete(`/bank-accounts/${id}`);
      toast.success('Bank account deleted');
      if (selected?.id === id) setSelected(null);
      await fetchAccounts();
    } catch { toast.error('Failed to delete bank account'); }
  };

  // ─── Live progress driver ────────────────────────────────────────
  const runProgress = () => {
    const steps = [
      { label: 'Preparing Document', pct: 5 },
      { label: 'Converting Pages', pct: 15 },
      { label: 'Reading Batches (OCR)', pct: 45 },
      { label: 'Extracting Transactions', pct: 65 },
      { label: 'Matching Ledger', pct: 82 },
      { label: 'Posting Entries', pct: 94 },
    ];
    let i = 0;
    setProgress({ ...steps[0], step: 1, total: steps.length });
    const timer = setInterval(() => {
      i = Math.min(i + 1, steps.length - 1);
      setProgress({ ...steps[i], step: i + 1, total: steps.length });
    }, 1200);
    return () => clearInterval(timer);
  };

  const fmtFileSize = (bytes) => {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleDragOver = (e) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = (e) => { e.preventDefault(); setIsDragging(false); };
  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer?.files?.[0];
    if (!dropped) return;
    const ext = (dropped.name.split('.').pop() || '').toLowerCase();
    if (!['csv', 'xlsx', 'xls', 'pdf'].includes(ext)) {
      toast.error('Unsupported file type — upload a CSV, XLSX, or PDF statement.');
      return;
    }
    setFile(dropped);
  };

  const handleUpload = async () => {
    if (!file || !selected) { toast.error('Choose a statement file first'); return; }
    const fd = new FormData();
    fd.append('file', file);
    setUploading(true);
    const stop = runProgress();
    try {
      const { data } = await api.post(`/bank-accounts/${selected.id}/upload-statement`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setProgress({ label: 'Completed', pct: 100, step: 6, total: 6 });
      const warnings = Array.isArray(data?.warnings) ? data.warnings : [];
      if (data?.success === false || (data?.transactions_saved ?? 0) === 0) {
        // Backend returned a structured "no rows" response — show the real reason.
        const msg = warnings[0] || 'No transactions could be read from this file.';
        toast.error(msg);
      } else {
        toast.success(`${data.transactions_saved} transactions read · ${data.auto_matched} matched · ${data.auto_posted} posted to ledger`);
        warnings.forEach(w => toast.warning ? toast.warning(w) : toast(w));
        setFile(null);
        if (fileRef.current) fileRef.current.value = '';
        await fetchAccounts();
        await fetchTransactions(selected.id);
      }
    } catch (err) {
      // Prefer the real backend message; only fall back to a generic label.
      const detail = err?.response?.data?.detail
        || err?.response?.data?.warnings?.[0]
        || err?.message
        || 'Could not read this statement';
      toast.error(detail);
    } finally {
      stop();
      setTimeout(() => setProgress(null), 900);
      setUploading(false);
    }
  };

  const unmatchTxn = async (txnId, silent = false) => {
    let reason = '';
    if (!silent) {
      if (!window.confirm('Unmatch this transaction? The reconciliation link and its journal entry will be removed. The invoice, receipt, voucher, ledger and audit history are preserved.')) return false;
      reason = window.prompt('Optional: reason for unmatching (recorded in the audit trail)') || '';
    }
    try {
      await api.post(`/bank-transactions/${txnId}/unmatch`, { reason });
      if (!silent) toast.success('Unmatched — journal entry reversed');
      await fetchTransactions(selected.id);
      return true;
    } catch (err) { toast.error(err.response?.data?.detail || 'Failed to unmatch'); return false; }
  };

  const approveSuggestedMatch = async (txn) => {
    if (!txn || !txn.suggested_match) return;
    const { matched_type, matched_id, matched_label } = txn.suggested_match;
    try {
      const payload = {
        matched_type,
        matched_id,
        matched_label,
        post_journal: true,
        confidence: 100
      };
      await api.post(`/bank-transactions/${txn.id}/match`, payload);
      toast.success('Suggested match approved and posted!');
      await fetchTransactions(selected.id);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to approve suggestion');
    }
  };

  const rejectSuggestedMatch = async (txn) => {
    if (!txn) return;
    try {
      await api.post(`/bank-transactions/${txn.id}/reject-suggestion`);
      toast.success('Suggested match dismissed');
      await fetchTransactions(selected.id);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to dismiss suggestion');
    }
  };

  const loadInvoices = async (force = false) => {
    const companyId = selected?.company_id || '';
    if (invoiceCache.length && loadedCompanyId === companyId && !force) return;
    setInvoiceLoading(true);
    try {
      const [salesRes, purchasesRes] = await Promise.allSettled([
        api.get('/invoices', { params: { page: 1, page_size: 2000, company_id: companyId } }),
        api.get('/purchase-invoices', { params: { page_size: 2000, company_id: companyId } })
      ]);

      let salesList = [];
      if (salesRes.status === 'fulfilled') {
        const data = salesRes.value.data;
        const rawSales = Array.isArray(data) ? data : (data?.items || data?.invoices || []);
        salesList = rawSales.map(s => ({
          ...s,
          isPurchase: false,
          invoice_no: s.invoice_no || s.invoice_number || s.number || s.bill_number || '',
          client_name: s.client_name || s.customer_name || s.party_name || s.buyer_name || 'Customer',
          grand_total: s.grand_total || s.amount || s.total || 0,
          invoice_date: s.invoice_date || s.date || s.bill_date || ''
        }));
      }

      let purchasesList = [];
      if (purchasesRes.status === 'fulfilled') {
        const data = purchasesRes.value.data;
        const rawPurchases = Array.isArray(data) ? data : (data?.items || data?.invoices || data?.purchase_invoices || []);
        purchasesList = rawPurchases.map(p => ({
          ...p,
          isPurchase: true,
          invoice_no: p.invoice_no || p.bill_number || p.invoice_number || '',
          client_name: p.supplier_name || p.vendor_name || p.client_name || 'Vendor',
          grand_total: p.grand_total || p.amount || p.total || 0,
          invoice_date: p.invoice_date || p.date || p.bill_date || ''
        }));
      }

      setInvoiceCache([...salesList, ...purchasesList]);
      setLoadedCompanyId(companyId);
    } catch { /* silent */ }
    finally { setInvoiceLoading(false); }
  };

  const loadLedgers = async (force = false) => {
    if (ledgerCache.length && !force) return;
    setLedgerLoading(true);
    try {
      const companyId = selected?.company_id || '';
      const { data } = await api.get('/chart-of-accounts', { params: { company_id: companyId } });
      setLedgerCache(Array.isArray(data) ? data : []);
    } catch { /* silent — user may not have COA permission */ }
    finally { setLedgerLoading(false); }
  };

  useEffect(() => {
    if (selected) {
      fetchTransactions(selected.id);
      loadInvoices(true);
      loadLedgers(true);
    }
  }, [selected?.id]);

  const openMatch = async (txn, mode) => {
    setInvoiceSearch('');
    setDialogTab('invoice');
    setMatchDialog({ txn, mode });

    // Guess vendor name from transaction description
    const rawDesc = txn.description || '';
    let cleanVendor = rawDesc
      .replace(/(payment to|transfer to|paid to|to|rtgs|neft|imps|upi|gpay|paytm|pos|chg)/gi, '')
      .replace(/[\s\-_]+/g, ' ')
      .trim();
    if (cleanVendor.length > 50) cleanVendor = cleanVendor.slice(0, 50);

    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const billNo = txn.reference ? `BILL-${txn.reference}` : `BILL-${txn.date?.replace(/-/g, '') || ''}-${randomSuffix}`;

    setNewPurchaseForm({
      supplier_name: cleanVendor.toUpperCase(),
      invoice_no: billNo,
      invoice_date: txn.date || new Date().toISOString().split('T')[0],
      gst_rate: '18',
      grand_total: Number(txn.debit || 0).toString()
    });
    setShowNewPurchaseForm(false);
    setShowNewExpenseHeadForm(false);

    loadInvoices();
    loadLedgers();
  };

  const createAndMatchPurchaseInvoice = async () => {
    if (!newPurchaseForm.supplier_name.trim()) { toast.error('Supplier name is required'); return; }
    if (!newPurchaseForm.invoice_no.trim()) { toast.error('Invoice/Bill number is required'); return; }
    if (!newPurchaseForm.invoice_date.trim()) { toast.error('Invoice/Bill date is required'); return; }

    setSavingPurchase(true);
    try {
      const gtotal = Number(newPurchaseForm.grand_total || 0);
      const rate = Number(newPurchaseForm.gst_rate || 0);
      const total_gst = Math.round((gtotal - (gtotal / (1 + rate / 100)) + Number.EPSILON) * 100) / 100;
      const taxable_amount = Math.round((gtotal - total_gst + Number.EPSILON) * 100) / 100;

      const payload = {
        company_id: selected?.company_id || '',
        client_name: selected?.account_holder || '',
        supplier_name: newPurchaseForm.supplier_name.trim(),
        supplier_gstin: '',
        invoice_no: newPurchaseForm.invoice_no.trim(),
        invoice_date: newPurchaseForm.invoice_date,
        taxable_amount,
        total_gst,
        grand_total: gtotal,
        currency: 'INR'
      };

      const { data } = await api.post('/purchase-invoices', payload);
      const newInv = data.purchase_invoice;

      // Force cache reset
      setInvoiceCache([]);

      const matched_label = `${invNumber(newInv) || '—'} · ${invParty(newInv) || '—'}`.trim();
      const matchPayload = {
        matched_type: 'purchase',
        matched_id: newInv.id,
        matched_label,
        post_journal: true,
        confidence: 100
      };

      await api.post(`/bank-transactions/${matchDialog.txn.id}/match`, matchPayload);
      toast.success('Bill created and transaction matched!');

      const origTxn = matchDialog.txn;
      setMatchDialog(null);
      await fetchAccounts();
      await fetchTransactions(selected.id);

      // AI Copilot automatically matches similar transactions
      await checkAndAutoMatchSimilar(origTxn, newInv, 'invoice');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to create and match bill');
    } finally {
      setSavingPurchase(false);
    }
  };

  const checkAndAutoMatchSimilar = async (matchedTxn, matchTarget, type) => {
    // Find all unmatched, non-ignored transactions in the currently selected bank account, excluding matchedTxn itself
    const unmatched = transactions.filter(t => t.id !== matchedTxn.id && !t.matched_type && !t.ignored);
    const similarTxns = [];

    for (const other of unmatched) {
      const sim = getTxnSimilarity(matchedTxn, other);
      if (sim >= 90) {
        similarTxns.push({ txn: other, score: sim });
      }
    }

    if (similarTxns.length === 0) return;

    toast.info(`🤖 AI Copilot: Found ${similarTxns.length} transactions of 90%+ similar nature. Auto-matching them now...`, {
      icon: '🤖',
      duration: 3500
    });

    let successCount = 0;
    try {
      for (const item of similarTxns) {
        if (type === 'ledger') {
          const matched_type = matchTarget.code === '9998' ? 'suspense' : 'expense';
          const matched_label = `${matchTarget.code} · ${matchTarget.name}`;
          const payload = { matched_type, matched_id: matchTarget.id, matched_label, post_journal: true };
          await api.post(`/bank-transactions/${item.txn.id}/match`, payload);
          successCount++;
        } else if (type === 'invoice') {
          const suggestions = suggestionsFor(item.txn);
          if (suggestions.length && suggestions[0].score >= 70) {
            const bestInv = suggestions[0].inv;
            const isDebit = Number(item.txn.debit || 0) > 0;
            const matched_type = isDebit ? 'purchase' : 'sale';
            const matched_label = `${invNumber(bestInv) || '—'} · ${invParty(bestInv) || '—'}`.trim();
            const payload = { 
              matched_type, 
              matched_id: bestInv.id, 
              matched_label, 
              post_journal: true, 
              confidence: suggestions[0].score 
            };
            await api.post(`/bank-transactions/${item.txn.id}/match`, payload);
            successCount++;
          } else {
            const isDebit = Number(item.txn.debit || 0) > 0;
            const matched_type = isDebit ? 'purchase' : 'sale';
            const matched_label = `${invNumber(matchTarget) || '—'} · ${invParty(matchTarget) || '—'}`.trim();
            const payload = { 
              matched_type, 
              matched_id: matchTarget.id, 
              matched_label, 
              post_journal: true, 
              confidence: item.score 
            };
            await api.post(`/bank-transactions/${item.txn.id}/match`, payload);
            successCount++;
          }
        }
      }
      if (successCount > 0) {
        toast.success(`🤖 AI Copilot: Auto-matched ${successCount} additional similar transactions!`);
        await fetchTransactions(selected.id);
      }
    } catch (err) {
      console.error('Error auto-matching similar transactions:', err);
    }
  };

  const confirmMatch = async (txn, inv, score) => {
    try {
      const isDebit = Number(txn.debit || 0) > 0;
      const matched_type = isDebit ? 'purchase' : 'sale';
      const matched_label = `${invNumber(inv) || '—'} · ${invParty(inv) || '—'}`.trim();
      const payload = { matched_type, matched_id: inv.id, matched_label, post_journal: true, confidence: score ?? null };
      if (txn.matched_type) {
        await api.post(`/bank-transactions/${txn.id}/edit-match`, payload);
        toast.success('Match updated · ledger updated');
      } else {
        await api.post(`/bank-transactions/${txn.id}/match`, payload);
        toast.success('Matched · ledger updated');
      }
      setMatchDialog(null);
      await fetchTransactions(selected.id);

      // Trigger auto matching for similar items
      await checkAndAutoMatchSimilar(txn, inv, 'invoice');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to match');
    }
  };

  // Match a bank line to a chart-of-accounts head (any expense ledger, or the
  // "Suspense Account" 9998). Backend posts Dr <head>/Cr Bank for debits and
  // the reverse for credits — see backend/bank_accounts.py::_auto_post_for_match.
  const confirmLedgerMatch = async (txn, acct, opts = {}) => {
    try {
      const matched_type = opts.suspense ? 'suspense' : 'expense';
      const matched_label = `${acct.code} · ${acct.name}`;
      const payload = { matched_type, matched_id: acct.id, matched_label, post_journal: true };
      if (txn.matched_type) {
        await api.post(`/bank-transactions/${txn.id}/edit-match`, payload);
        toast.success(opts.suspense ? 'Parked in Suspense · ledger posted' : 'Matched to head · ledger posted');
      } else {
        await api.post(`/bank-transactions/${txn.id}/match`, payload);
        toast.success(opts.suspense ? 'Parked in Suspense · ledger posted' : 'Matched to head · ledger posted');
      }
      setMatchDialog(null);
      await fetchTransactions(selected.id);

      // Trigger auto matching for similar items
      await checkAndAutoMatchSimilar(txn, acct, 'ledger');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to match');
    }
  };

  // One-click: park directly to Suspense from the transaction row, no dialog.
  const parkToSuspense = async (txn) => {
    if (!ledgerCache.length) await loadLedgers(true);
    const list = ledgerCache.length ? ledgerCache : [];
    const suspense = list.find(a => a.code === '9998') || list.find(a => /suspense/i.test(a.name || ''));
    if (!suspense) {
      toast.error('Suspense account not found — open the Chart of Accounts once to seed defaults.');
      return;
    }
    await confirmLedgerMatch(txn, suspense, { suspense: true });
  };

  const createHead = async () => {
    if (!newHead.code.trim() || !newHead.name.trim()) { toast.error('Code and name are required'); return; }
    setSavingHead(true);
    try {
      const { data } = await api.post('/chart-of-accounts', {
        company_id: selected?.company_id || '',
        code: newHead.code.trim(), name: newHead.name.trim(),
        type: newHead.type, sub_type: newHead.sub_type,
      });
      toast.success(`Ledger head "${data.name}" created`);
      setLedgerCache(prev => [...prev, data].sort((a, b) => (a.code || '').localeCompare(b.code || '')));
      setShowNewHead(false);
      setNewHead({ code: '', name: '', type: 'expense', sub_type: 'operating_expense' });
      // Immediately offer to match the current transaction to the new head
      if (matchDialog?.txn) await confirmLedgerMatch(matchDialog.txn, data);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to create ledger head');
    } finally { setSavingHead(false); }
  };

  const getSuggestedExpenseCode = () => {
    const codes = ledgerCache.map(c => Number(c.code)).filter(c => c >= 5000 && c < 6000);
    if (!codes.length) return '5100';
    return String(Math.max(...codes) + 10);
  };

  const createAndMatchDirectExpense = async () => {
    if (!newExpenseHead.code.trim() || !newExpenseHead.name.trim()) {
      toast.error('Code and name are required');
      return;
    }
    setSavingExpenseHead(true);
    try {
      const { data: acct } = await api.post('/chart-of-accounts', {
        company_id: selected?.company_id || '',
        code: newExpenseHead.code.trim(),
        name: newExpenseHead.name.trim(),
        type: 'expense',
        sub_type: 'operating_expense'
      });
      toast.success(`Expense Account "${acct.name}" created successfully`);
      setLedgerCache(prev => [...prev, acct].sort((a, b) => (a.code || '').localeCompare(b.code || '')));
      setShowNewExpenseHeadForm(false);
      if (matchDialog?.txn) {
        await confirmLedgerMatch(matchDialog.txn, acct);
      }
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to create and match expense account');
    } finally {
      setSavingExpenseHead(false);
    }
  };


  const viewAudit = async (txn) => {
    try {
      const { data } = await api.get(`/bank-transactions/${txn.id}/audit-trail`);
      setAuditDialog({ txn, entries: Array.isArray(data) ? data : (data?.entries || [data]) });
    } catch { toast.error('No audit trail available'); }
  };

  const viewLedger = (txn) => {
    if (!txn.journal_entry_id) { toast.error('No journal entry posted for this transaction yet'); return; }
    navigate(`/journal-entries?entry=${txn.journal_entry_id}`);
  };

  const toggleIgnore = async (txn) => {
    const next = !txn.ignored;
    setTransactions(ts => ts.map(x => x.id === txn.id ? { ...x, ignored: next } : x));
    try {
      await api.post(`/bank-transactions/${txn.id}/ignore`, { ignored: next });
    } catch {
      toast.error('Failed to update — reverting');
      setTransactions(ts => ts.map(x => x.id === txn.id ? { ...x, ignored: !next } : x));
    }
  };

  const selectedList = Object.keys(selectedIds).filter(k => selectedIds[k]);
  const bulkUnmatch = async () => {
    if (!selectedList.length) return;
    if (!window.confirm(`Unmatch ${selectedList.length} transactions? Journal entries will be reversed. Invoices and audit history are preserved.`)) return;
    for (const id of selectedList) { await unmatchTxn(id, true); }
    toast.success(`${selectedList.length} unmatched`);
  };
  const bulkIgnore = async () => {
    if (!selectedList.length) return;
    const ids = [...selectedList];
    setTransactions(ts => ts.map(t => selectedIds[t.id] ? { ...t, ignored: true } : t));
    setSelectedIds({});
    try {
      await Promise.all(ids.map(id => api.post(`/bank-transactions/${id}/ignore`, { ignored: true })));
      toast.success(`${ids.length} marked ignored`);
    } catch {
      toast.error('Some transactions could not be marked ignored');
      await fetchTransactions(selected.id);
    }
  };

  const filteredInvoices = useMemo(() => {
    if (!matchDialog?.txn) return [];
    const isDebit = Number(matchDialog.txn.debit || 0) > 0;
    const q = invoiceSearch.trim().toLowerCase();
    
    // If it's debit, show ONLY purchase invoices; if it's credit, show ONLY sales invoices
    const base = invoiceCache.filter(i => isDebit ? !!i.isPurchase : !i.isPurchase);
    
    if (!q) return base.slice(0, 200);
    return base.filter(i => {
      const hay = [invNumber(i), invParty(i), i.gstin, i.customer_gstin, i.supplier_gstin, invAmount(i), invDate(i)]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    }).slice(0, 200);
  }, [invoiceCache, invoiceSearch, matchDialog?.txn]);

  const filteredLedgers = useMemo(() => {
    const q = invoiceSearch.trim().toLowerCase();
    const base = (ledgerCache || []).filter(a => a.is_active !== false);
    if (!q) return base.slice(0, 300);
    return base.filter(a => `${a.code} ${a.name} ${a.type} ${a.sub_type}`.toLowerCase().includes(q)).slice(0, 300);
  }, [ledgerCache, invoiceSearch]);

  if (loading) return <ContentLoader />;

  return (
    <div className={`min-h-full ${isDark ? 'bg-slate-900' : 'bg-slate-50'}`}>
      <div className="space-y-5 w-full">
        <div className="rounded-3xl overflow-hidden shadow-xl" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
          <div className="p-6 md:p-7 flex flex-col lg:flex-row lg:items-center justify-between gap-5 text-white">
            <div className="flex items-start gap-4 min-w-0 flex-1">
              <div className="h-14 w-14 rounded-2xl bg-white/15 border border-white/20 flex items-center justify-center shadow-lg shrink-0">
                <Landmark className="h-7 w-7" />
              </div>
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-[0.25em] text-blue-100 font-bold">Accounts</p>
                <h1 className="text-2xl md:text-3xl font-bold tracking-tight mt-1">Bank Accounts</h1>
                <p className="text-sm text-blue-100 mt-1 max-w-2xl">
                  Upload a statement from any bank. Transactions are read automatically, matched to purchase/sale invoices, and posted to the ledger.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 shrink-0 lg:max-w-full">
              <Button onClick={() => setShowNewAccount(true)} variant="outline" className="shrink-0 whitespace-nowrap bg-white/10 border-white/25 text-white hover:bg-white/20">
                <Plus className="h-4 w-4 mr-2" /> Add bank account
              </Button>
              <Button onClick={fetchAccounts} variant="outline" className="shrink-0 whitespace-nowrap bg-white/10 border-white/25 text-white hover:bg-white/20">
                <RefreshCw className="h-4 w-4 mr-2" /> Refresh
              </Button>
            </div>
          </div>
        </div>

        <GuidanceNote pageKey="bank-accounts" isDark={isDark} />

        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          {[
            { label: 'Bank Accounts', value: stats.accountCount, icon: Landmark, color: COLORS.mediumBlue },
            { label: 'Total Balance', value: fmtC(stats.totalBalance), icon: CheckCircle2, color: COLORS.emeraldGreen },
            { label: 'Matched (this account)', value: stats.matched, icon: Link2, color: COLORS.deepBlue },
            { label: 'Unmatched (this account)', value: Math.max(stats.unmatched, 0), icon: AlertTriangle, color: stats.unmatched ? COLORS.amber : COLORS.emeraldGreen },
          ].map((s) => (
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

        <div className="space-y-5">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 px-1 mb-2">Your bank accounts</p>
            {accounts.length === 0 ? (
              <div className={`rounded-3xl border shadow-sm p-6 text-center ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                <p className="text-sm text-slate-400">No bank accounts yet. Add one to get started.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                {accounts.map(a => (
                  <button key={a.id} onClick={() => setSelected(a)}
                    className={`w-full text-left rounded-2xl p-4 border shadow-sm transition flex items-center justify-between gap-2 ${
                      selected?.id === a.id ? 'border-blue-300 bg-blue-50/60'
                      : isDark ? 'bg-slate-800 border-slate-700 hover:bg-slate-700/40' : 'bg-white border-slate-200 hover:bg-slate-50'
                    }`}>
                    <div className="min-w-0">
                      <p className={`font-bold text-sm truncate ${isDark && selected?.id !== a.id ? 'text-slate-100' : 'text-slate-900'}`}>{a.bank_name}</p>
                      <p className="text-xs text-slate-400 truncate">{a.account_number_masked || a.account_holder}</p>
                      {a.company_id && companies.find(c => c.id === a.company_id) && (
                        <p className="text-[10px] text-blue-500 font-semibold truncate mt-0.5">
                          {companies.find(c => c.id === a.company_id)?.name}
                        </p>
                      )}
                      <p className="text-sm font-bold mt-1" style={{ color: COLORS.emeraldGreen }}>{fmtC(a.current_balance)}</p>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <ChevronRight className="h-4 w-4 text-slate-300" />
                      <div className="flex items-center gap-2">
                        <Edit3 className="h-3.5 w-3.5 text-slate-400 hover:text-blue-500 cursor-pointer"
                          onClick={(e) => { e.stopPropagation(); openEditAccount(a); }} />
                        <Trash2 className="h-3.5 w-3.5 text-slate-400 hover:text-rose-500 cursor-pointer"
                          onClick={(e) => { e.stopPropagation(); deleteAccount(a.id); }} />
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-4">
            {!selected ? (
              <div className={`rounded-3xl border shadow-sm py-20 text-center ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                <Landmark className="h-12 w-12 mx-auto text-slate-300 mb-3" />
                <p className="text-sm font-semibold text-slate-400">Select or add a bank account</p>
              </div>
            ) : (
              <>
                <div className={`rounded-3xl border shadow-sm p-5 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                  <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="h-10 w-10 rounded-xl flex items-center justify-center text-white shrink-0" style={{ background: COLORS.mediumBlue }}>
                        <UploadCloud className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <h2 className={`font-bold truncate ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Upload statement — {selected.bank_name}</h2>
                        <p className="text-xs text-slate-400">CSV, XLSX, or PDF exports. Large PDFs auto-batch (3 pages/req, parallel).</p>
                      </div>
                    </div>
                  </div>

                  {/* Duplicate-avoidance banner — surfaces what's already on file
                      (from the Invoicing/Purchases cache loaded for this company)
                      so the user can confirm nothing gets booked twice before
                      reading a statement in. */}
                  {(() => {
                    const openSales = invoiceCache.filter(r => !r.isPurchase && !['paid', 'cancelled'].includes((r.status || '').toLowerCase()));
                    const openPurchases = invoiceCache.filter(r => r.isPurchase && (r.payment_status || 'unpaid').toLowerCase() !== 'paid');
                    return (
                      <button
                        type="button"
                        onClick={() => setShowExistingRecords(true)}
                        className={`w-full mb-4 rounded-2xl border px-4 py-3 flex items-center gap-3 text-left transition-all hover:shadow-md ${
                          isDark ? 'bg-emerald-950/20 border-emerald-800/40 hover:bg-emerald-950/30' : 'bg-emerald-50/70 border-emerald-200 hover:bg-emerald-50'
                        }`}
                      >
                        <div className="h-9 w-9 rounded-xl flex items-center justify-center text-white shrink-0" style={{ background: COLORS.emeraldGreen }}>
                          <ShieldCheck className="h-4.5 w-4.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className={`text-sm font-bold ${isDark ? 'text-emerald-300' : 'text-emerald-800'}`}>
                            {invoiceLoading ? 'Checking existing records…' : `${openSales.length} open sale${openSales.length === 1 ? '' : 's'} · ${openPurchases.length} open purchase${openPurchases.length === 1 ? '' : 's'} already on file`}
                          </p>
                          <p className={`text-[11px] ${isDark ? 'text-emerald-400/80' : 'text-emerald-700/80'}`}>Review before uploading — matching statement lines link to these automatically, so nothing is entered twice.</p>
                        </div>
                        <Badge variant="outline" className={`shrink-0 text-[10px] ${isDark ? 'border-emerald-700 text-emerald-300' : 'border-emerald-300 text-emerald-700'}`}>Review</Badge>
                      </button>
                    );
                  })()}

                  <div
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    className={`border-2 border-dashed rounded-2xl p-6 text-center transition-all ${
                      isDragging
                        ? (isDark ? 'border-blue-400 bg-blue-950/40 scale-[1.01]' : 'border-blue-400 bg-blue-100/60 scale-[1.01]')
                        : (isDark ? 'border-slate-700 bg-slate-900/60' : 'border-blue-100 bg-blue-50/60')
                    }`}
                  >
                    <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,.pdf" className="hidden" onChange={e => setFile(e.target.files?.[0] || null)} />
                    {!file ? (
                      <>
                        <UploadCloud className="h-9 w-9 mx-auto mb-3" style={{ color: COLORS.mediumBlue }} />
                        <p className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>Drag &amp; drop your statement here</p>
                        <p className="text-xs text-slate-400 mt-1">or</p>
                        <div className="mt-3">
                          <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} className="rounded-xl">Browse files</Button>
                        </div>
                      </>
                    ) : (
                      <div className={`flex items-center gap-3 rounded-xl p-3 mb-1 text-left ${isDark ? 'bg-slate-800 border border-slate-700' : 'bg-white border border-slate-200'}`}>
                        <div className="h-10 w-10 rounded-lg flex items-center justify-center text-white shrink-0" style={{ background: COLORS.mediumBlue }}>
                          <FileCheck2 className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className={`text-sm font-semibold truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{file.name}</p>
                          <p className="text-[11px] text-slate-400">{fmtFileSize(file.size)} · {(file.name.split('.').pop() || '').toUpperCase()}</p>
                        </div>
                        <button type="button" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ''; }} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 shrink-0">
                          <X className="h-4 w-4 text-slate-400" />
                        </button>
                      </div>
                    )}
                    <div className="mt-4 flex justify-center gap-2">
                      {file && <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} className="rounded-xl">Change file</Button>}
                      <Button onClick={handleUpload} disabled={uploading || !file} className="rounded-xl text-white" style={{ background: COLORS.deepBlue }}>
                        {uploading ? <MiniLoader height={18} /> : 'Read & Match'}
                      </Button>
                    </div>
                    {progress && (
                      <div className="mt-4 text-left">
                        <div className="flex justify-between text-[11px] font-bold text-slate-500 mb-1">
                          <span>{progress.label}</span>
                          <span>{progress.pct}%</span>
                        </div>
                        <div className="h-2 w-full rounded-full bg-slate-200 overflow-hidden">
                          <div className="h-full rounded-full transition-all" style={{ width: `${progress.pct}%`, background: COLORS.mediumBlue }} />
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Futuristic AI Copilot Intelligence Hub */}
                <div className={`relative rounded-3xl border p-5 overflow-hidden shadow-md transition-all duration-300 ${
                  isDark 
                    ? 'bg-gradient-to-br from-slate-900 via-indigo-950/20 to-slate-900 border-indigo-500/30 shadow-indigo-500/5' 
                    : 'bg-gradient-to-br from-white via-indigo-50/20 to-white border-indigo-200 shadow-indigo-100/40'
                }`}>
                  {/* Subtle animated light trail at top */}
                  <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-indigo-500 to-transparent animate-pulse" />
                  
                  <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
                    <div className="flex items-start gap-3.5">
                      <div className="h-10 w-10 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-500 flex-shrink-0 animate-pulse">
                        <Sparkles className="h-5 w-5" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className={`font-bold text-sm ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>AI Matchmaker &amp; AI Search</h3>
                          <span className="text-[9px] uppercase tracking-wider font-extrabold px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-500 border border-indigo-500/20">Active</span>
                        </div>
                        <p className="text-xs text-slate-400 mt-1 max-w-xl">
                          Our neural mapping engine analyzes transaction size, payment dates, party aliases, and narration references to automatically suggest ledger reconciliations.
                        </p>
                      </div>
                    </div>
                    
                    <div className="flex flex-wrap items-center gap-3 sm:self-center">
                      <div className="text-left sm:text-right px-3 py-1 rounded-xl bg-slate-500/5 border border-slate-500/10">
                        <span className="block text-[9px] uppercase tracking-wider font-bold text-slate-400">Match Confidence</span>
                        <span className="text-xs font-black text-indigo-500">{copilotStats.avgScore}% avg</span>
                      </div>
                      
                      <div className="text-left sm:text-right px-3 py-1 rounded-xl bg-slate-500/5 border border-slate-500/10">
                        <span className="block text-[9px] uppercase tracking-wider font-bold text-slate-400">High Conf Ready</span>
                        <span className="text-xs font-black text-emerald-500">{copilotStats.highConfCount} rows</span>
                      </div>
                      
                      <Button
                        onClick={autoMatchAllHighConfidence}
                        disabled={isAutoMatching || transactions.filter(t => !t.matched_type && !t.ignored).length === 0}
                        className="rounded-xl text-white font-bold text-xs shadow-sm shadow-indigo-500/20 px-4 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 border-none h-9 gap-1.5"
                      >
                        {isAutoMatching ? (
                          <MiniLoader height={14} />
                        ) : (
                          <>
                            <Sparkles className="h-3.5 w-3.5" />
                            <span>Run AI Auto-Match</span>
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </div>

                <div className={`rounded-3xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                  <div className="p-4 border-b flex flex-col md:flex-row md:items-center justify-between gap-3" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
                    <div className="flex items-center justify-between w-full md:w-auto">
                      <div>
                        <h2 className={`font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Transactions</h2>
                        <p className="text-xs text-slate-400">{visibleTxns.length} of {transactions.length} rows</p>
                      </div>
                    </div>
                    
                    <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
                      {/* Interactive Instant Local Search Box */}
                      <div className="relative w-full sm:w-48 lg:w-60">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                        <Input 
                          placeholder="Instant feed search…" 
                          value={txnSearchText} 
                          onChange={(e) => setTxnSearchText(e.target.value)} 
                          className="pl-8 h-8 text-xs w-full bg-slate-500/5 border-slate-500/10 focus:border-indigo-500 transition-all rounded-xl" 
                        />
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {['all','matched','unmatched','ignored'].map(f => (
                          <button key={f} onClick={() => setFilter(f)}
                            className={`text-[11px] font-bold px-3 py-1 rounded-full border transition ${filter === f ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'}`}>
                            {f[0].toUpperCase() + f.slice(1)}
                          </button>
                        ))}
                      </div>
                      
                      {selectedList.length > 0 && canMatch && (
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[11px] font-bold text-slate-500">{selectedList.length} selected</span>
                          <Button size="sm" variant="outline" className="rounded-full h-7 text-xs" onClick={bulkUnmatch}>Bulk Unmatch</Button>
                          <Button size="sm" variant="outline" className="rounded-full h-7 text-xs" onClick={bulkIgnore}>Bulk Ignore</Button>
                          <Button size="sm" variant="outline" className="rounded-full h-7 text-xs" onClick={() => { setSelectedIds({}); loadInvoices(); toast.success('Suggestions refreshed'); }}>Refresh Suggestions</Button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="divide-y max-h-[600px] overflow-y-auto" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
                    {txnLoading ? (
                      <div className="p-10 text-center"><MiniLoader height={24} /></div>
                    ) : visibleTxns.length === 0 ? (
                      <div className="py-16 text-center">
                        <p className="text-sm font-semibold text-slate-400">No transactions to show</p>
                        <p className="text-xs text-slate-400 mt-1">Upload a statement above or switch the filter.</p>
                      </div>
                    ) : visibleTxns.map(t => {
                      const top = invoiceCache.length ? suggestionsFor(t)[0] : null;
                      const hasSuggestion = t.suggested_match && t.suggested_match.pending_approval;
                      const isUnmatched = !t.matched_type && !t.ignored;
                      
                      // Compute special background styles based on status
                      let rowBgClass = isDark ? 'hover:bg-slate-700/40' : 'hover:bg-slate-50';
                      let borderClass = '';
                      
                      if (isUnmatched) {
                        if (hasSuggestion) {
                          rowBgClass = isDark ? 'bg-indigo-950/15 hover:bg-indigo-950/25' : 'bg-indigo-50/50 hover:bg-indigo-50/80';
                          borderClass = 'border-l-4 border-indigo-500';
                        } else if (t.credit) {
                          rowBgClass = isDark ? 'bg-amber-950/10 hover:bg-amber-950/20' : 'bg-amber-50/40 hover:bg-amber-50/70';
                          borderClass = 'border-l-4 border-amber-500';
                        } else if (t.debit) {
                          rowBgClass = isDark ? 'bg-rose-950/10 hover:bg-rose-950/20' : 'bg-rose-50/30 hover:bg-rose-50/60';
                          borderClass = 'border-l-4 border-rose-400';
                        }
                      }

                      return (
                        <div key={t.id} className={`p-4 flex items-start gap-3 transition-colors ${rowBgClass} ${borderClass} ${t.ignored ? 'opacity-60' : ''}`}>
                          <input type="checkbox" className="mt-1"
                            checked={!!selectedIds[t.id]}
                            onChange={e => setSelectedIds(s => ({ ...s, [t.id]: e.target.checked }))} />
                          <div className="min-w-0 flex-1">
                            <p className={`text-sm font-semibold truncate ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{t.description || 'No description'}</p>
                            <p className="text-xs text-slate-400 mt-0.5">
                              {fmtDate(t.date)} {t.reference ? `· ${t.reference}` : ''}
                            </p>
                            
                            {/* Visual Discrepancy Badges & AI Suggestions */}
                            <div className="flex flex-wrap items-center gap-2 mt-2">
                              {t.ignored ? (
                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200">Ignored</span>
                              ) : t.matched_type ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                                  <Link2 className="h-3 w-3" /> Matched · {t.matched_label || t.matched_type} {t.journal_entry_id ? '· posted' : ''}
                                </span>
                              ) : hasSuggestion ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800 border border-indigo-200">
                                  <Sparkles className="h-3 w-3 text-indigo-600 animate-pulse" /> Suggested Match (Pending Approval)
                                </span>
                              ) : t.credit ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                                  <AlertCircle className="h-3 w-3 text-amber-600" /> Missing Sale Invoice (Unreported Income)
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 border border-rose-200">
                                  <AlertTriangle className="h-3 w-3 text-rose-600" /> Missing Purchase/Expense Record
                                </span>
                              )}

                              {!t.matched_type && !hasSuggestion && top && top.score >= 30 && (
                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
                                  Suggested Invoice: {invNumber(top.inv) || '—'} · {invParty(top.inv) || '—'} · {top.score}%
                                </span>
                              )}
                            </div>

                            {/* Pending Suggestion Confirmation Panel */}
                            {hasSuggestion && (
                              <div className="mt-3.5 p-3 rounded-xl border border-indigo-100 bg-white dark:bg-slate-800/80 shadow-sm space-y-2 max-w-xl">
                                <p className="text-xs text-slate-600 dark:text-slate-300">
                                  Prior matched logic pattern found: classify as <strong className="text-indigo-900 dark:text-indigo-200">{t.suggested_match.matched_label}</strong> ({t.suggested_match.matched_type})?
                                </p>
                                <div className="flex items-center gap-2">
                                  <button
                                    onClick={() => approveSuggestedMatch(t)}
                                    className="text-[11px] font-bold px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg shadow-sm transition inline-flex items-center gap-1"
                                  >
                                    <Check className="h-3 w-3" /> Approve Match
                                  </button>
                                  <button
                                    onClick={() => rejectSuggestedMatch(t)}
                                    className="text-[11px] font-bold px-3 py-1 bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 rounded-lg transition inline-flex items-center gap-1"
                                  >
                                    <X className="h-3 w-3" /> Reject
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* Informative Help Text for discrepancies with integrated AI Suggestion & Quick Match */}
                            {isUnmatched && !hasSuggestion && top && top.score >= 70 ? (
                              <div className="mt-3 p-3 rounded-2xl border border-dashed border-emerald-500/30 bg-emerald-500/[0.02] max-w-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-all">
                                <div className="space-y-0.5">
                                  <div className="flex items-center gap-1.5">
                                    <Sparkles className="h-3.5 w-3.5 text-emerald-500 animate-pulse" />
                                    <span className={`text-xs font-bold ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
                                      AI Suggested: {top.score}% confidence match
                                    </span>
                                  </div>
                                  <p className={`text-xs font-medium truncate max-w-[320px] ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                                    {invNumber(top.inv)} · {invParty(top.inv)} ({fmtC(invAmount(top.inv))})
                                  </p>
                                  <p className="text-[10px] text-slate-400">
                                    Why this matched: {getScoreReason(t, top.inv)}
                                  </p>
                                </div>
                                <button
                                  onClick={() => confirmMatch(t, top.inv, top.score)}
                                  className="self-end sm:self-center text-[11px] font-bold px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg shadow-sm transition-all duration-200 flex items-center gap-1"
                                >
                                  <Check className="h-3.5 w-3.5" /> Quick Match
                                </button>
                              </div>
                            ) : isUnmatched && !hasSuggestion ? (
                              <p className="text-xs text-slate-400 mt-2 italic">
                                {t.credit 
                                  ? `This deposit of ${fmtC(t.credit)} is on the statement but has no matching sale report invoice. Match it to an existing sale, park it, or create a record.`
                                  : `This expense of ${fmtC(t.debit)} is on the statement but has no matching purchase/expense bill. Match it, park it, or create a purchase bill.`
                                }
                              </p>
                            ) : null}

                            <div className="flex flex-wrap gap-1.5 mt-2.5">
                              {t.matched_type ? (
                                <>
                                  {canMatch && (
                                    <button onClick={() => openMatch(t, 'edit')} className="text-[11px] font-bold px-2.5 py-1 rounded-md border border-slate-200 hover:border-blue-400 hover:text-blue-600 inline-flex items-center gap-1"><Edit3 className="h-3 w-3" /> Edit Match</button>
                                  )}
                                  {canMatch && (
                                    <button onClick={() => unmatchTxn(t.id)} className="text-[11px] font-bold px-2.5 py-1 rounded-md border border-slate-200 hover:border-rose-400 hover:text-rose-600 inline-flex items-center gap-1"><Unlink className="h-3 w-3" /> Unmatch</button>
                                  )}
                                  {t.matched_id && (
                                    <button onClick={() => navigate(`/invoicing?open=${t.matched_id}`)} className="text-[11px] font-bold px-2.5 py-1 rounded-md border border-slate-200 hover:border-slate-400 inline-flex items-center gap-1"><Eye className="h-3 w-3" /> Invoice</button>
                                  )}
                                  {t.journal_entry_id && (
                                    <button onClick={() => viewLedger(t)} className="text-[11px] font-bold px-2.5 py-1 rounded-md border border-slate-200 hover:border-slate-400 inline-flex items-center gap-1"><BookOpen className="h-3 w-3" /> Ledger</button>
                                  )}
                                  <button onClick={() => viewAudit(t)} className="text-[11px] font-bold px-2.5 py-1 rounded-md border border-slate-200 hover:border-slate-400 inline-flex items-center gap-1"><History className="h-3 w-3" /> Audit</button>
                                </>
                              ) : (
                                <>
                                  {canMatch ? (
                                    <>
                                      <button onClick={() => openMatch(t, 'match')} className="text-[11px] font-bold px-2.5 py-1 rounded-md border border-slate-200 hover:border-emerald-400 hover:text-emerald-600 inline-flex items-center gap-1"><Search className="h-3 w-3" /> Match</button>
                                      <button onClick={() => parkToSuspense(t)} title="Post to Suspense — reclassify to the correct expense head later" className="text-[11px] font-bold px-2.5 py-1 rounded-md border border-amber-200 text-amber-700 hover:border-amber-400 hover:bg-amber-50 inline-flex items-center gap-1"><BookOpen className="h-3 w-3" /> Park to Suspense</button>
                                      <button onClick={() => toggleIgnore(t)} className="text-[11px] font-bold px-2.5 py-1 rounded-md border border-slate-200 hover:border-slate-400 inline-flex items-center gap-1"><Ban className="h-3 w-3" /> {t.ignored ? 'Unignore' : 'Ignore'}</button>
                                    </>
                                  ) : (
                                    <span className="text-[10px] text-slate-400 italic">View only — request Match access from your admin</span>
                                  )}
                                </>
                              )}
                            </div>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <p className={`font-bold ${t.debit ? 'text-rose-500' : 'text-emerald-600'}`}>
                              {t.debit ? `- ${fmtC(t.debit)}` : `+ ${fmtC(t.credit)}`}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Match / Edit Match dialog */}
      <Dialog open={!!matchDialog} onOpenChange={(o) => { if (!o) setMatchDialog(null); }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{matchDialog?.mode === 'edit' ? 'Edit Match' : 'Match Transaction'}</DialogTitle>
          </DialogHeader>
          {matchDialog && (
            <div className="space-y-3">
              <div className="rounded-xl border p-3 bg-slate-50 text-sm">
                <div className="flex justify-between">
                  <div>
                    <p className="font-bold text-slate-800">{matchDialog.txn.description || 'Transaction'}</p>
                    <p className="text-xs text-slate-500">{fmtDate(matchDialog.txn.date)} · {matchDialog.txn.reference || '—'}</p>
                  </div>
                  <p className={`font-bold ${matchDialog.txn.debit ? 'text-rose-500' : 'text-emerald-600'}`}>
                    {matchDialog.txn.debit ? `- ${fmtC(matchDialog.txn.debit)}` : `+ ${fmtC(matchDialog.txn.credit)}`}
                  </p>
                </div>
              </div>
              {/* Tabs: Invoice vs Expense Head */}
              <div className="flex items-center gap-1 border-b">
                <button onClick={() => setDialogTab('invoice')}
                  className={`text-xs font-bold px-3 py-2 -mb-px border-b-2 ${dialogTab === 'invoice' ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                  Invoice
                </button>
                <button onClick={() => setDialogTab('expense')}
                  className={`text-xs font-bold px-3 py-2 -mb-px border-b-2 ${dialogTab === 'expense' ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                  Expense / Ledger Head
                </button>
                <div className="ml-auto">
                  <button onClick={() => { parkToSuspense(matchDialog.txn); }}
                    className="text-[11px] font-bold px-2.5 py-1 rounded-md border border-amber-200 text-amber-700 hover:bg-amber-50 inline-flex items-center gap-1">
                    <BookOpen className="h-3 w-3" /> Park to Suspense
                  </button>
                </div>
              </div>

              <div className="relative">
                <Search className="h-4 w-4 absolute left-3 top-3 text-slate-400" />
                <Input
                  placeholder={dialogTab === 'invoice'
                    ? 'Search by invoice #, party, GSTIN, amount, date…'
                    : 'Search ledger heads by code or name (e.g. 5250 Software, Rent)…'}
                  className="pl-9"
                  value={invoiceSearch}
                  onChange={e => setInvoiceSearch(e.target.value)} />
              </div>

              {dialogTab === 'invoice' ? (
                <div className="space-y-3">
                  {showNewPurchaseForm ? (
                    <div className="border rounded-2xl p-4 bg-blue-50/25 dark:bg-slate-900/40 space-y-3 border-blue-200 dark:border-slate-700">
                      <div className="flex items-center justify-between border-b pb-2 mb-2 dark:border-slate-700">
                        <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">Create & Match Purchase Bill</h3>
                        <Button size="xs" variant="ghost" onClick={() => setShowNewPurchaseForm(false)}>Cancel</Button>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs font-semibold text-slate-600 dark:text-slate-400">Supplier Name</Label>
                          <Input placeholder="e.g. AWS SERVICES" value={newPurchaseForm.supplier_name} onChange={e => setNewPurchaseForm(f => ({ ...f, supplier_name: e.target.value.toUpperCase() }))} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs font-semibold text-slate-600 dark:text-slate-400">Bill/Invoice Number</Label>
                          <Input placeholder="e.g. BILL-102" value={newPurchaseForm.invoice_no} onChange={e => setNewPurchaseForm(f => ({ ...f, invoice_no: e.target.value }))} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs font-semibold text-slate-600 dark:text-slate-400">Bill Date</Label>
                          <Input type="date" value={newPurchaseForm.invoice_date} onChange={e => setNewPurchaseForm(f => ({ ...f, invoice_date: e.target.value }))} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs font-semibold text-slate-600 dark:text-slate-400">GST Rate (%)</Label>
                          <Select value={newPurchaseForm.gst_rate} onValueChange={v => setNewPurchaseForm(f => ({ ...f, gst_rate: v }))}>
                            <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="18">18% GST (Standard)</SelectItem>
                              <SelectItem value="12">12% GST</SelectItem>
                              <SelectItem value="5">5% GST</SelectItem>
                              <SelectItem value="28">28% GST</SelectItem>
                              <SelectItem value="0">0% GST (Exempt)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1 col-span-2">
                          <Label className="text-xs font-semibold text-slate-600 dark:text-slate-400">Total Amount (₹)</Label>
                          <Input type="number" placeholder="Total bill amount" value={newPurchaseForm.grand_total} onChange={e => setNewPurchaseForm(f => ({ ...f, grand_total: e.target.value }))} />
                        </div>
                      </div>
                      <div className="flex gap-2 justify-end pt-2">
                        <Button size="sm" variant="outline" className="rounded-xl" onClick={() => setShowNewPurchaseForm(false)}>Cancel</Button>
                        <Button size="sm" onClick={createAndMatchPurchaseInvoice} disabled={savingPurchase} className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl">
                          {savingPurchase ? 'Creating…' : 'Save & Match'}
                        </Button>
                      </div>
                    </div>
                  ) : showNewExpenseHeadForm ? (
                    <div className="border rounded-2xl p-4 bg-amber-50/25 dark:bg-slate-900/40 space-y-3 border-amber-200 dark:border-slate-700">
                      <div className="flex items-center justify-between border-b pb-2 mb-2 dark:border-slate-700">
                        <h3 className="text-xs font-bold text-amber-800 dark:text-amber-200">Create Expense Account & Match</h3>
                        <Button size="xs" variant="ghost" onClick={() => setShowNewExpenseHeadForm(false)}>Cancel</Button>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs font-semibold text-slate-600 dark:text-slate-400">Account Code</Label>
                          <Input placeholder="e.g. 5210" value={newExpenseHead.code} onChange={e => setNewExpenseHead(h => ({ ...h, code: e.target.value }))} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs font-semibold text-slate-600 dark:text-slate-400">Expense Account Name</Label>
                          <Input placeholder="e.g. Travel Expenses" value={newExpenseHead.name} onChange={e => setNewExpenseHead(h => ({ ...h, name: e.target.value }))} />
                        </div>
                      </div>
                      <div className="flex gap-2 justify-end pt-2">
                        <Button size="sm" variant="outline" className="rounded-xl" onClick={() => setShowNewExpenseHeadForm(false)}>Cancel</Button>
                        <Button size="sm" onClick={createAndMatchDirectExpense} disabled={savingExpenseHead} className="bg-amber-600 hover:bg-amber-700 text-white rounded-xl">
                          {savingExpenseHead ? 'Creating…' : 'Create & Match Expense'}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {Number(matchDialog.txn.debit || 0) > 0 && (
                        <div className="flex flex-col sm:flex-row gap-2 mb-1">
                          <button onClick={() => { setShowNewPurchaseForm(true); setShowNewExpenseHeadForm(false); }} className="flex-1 py-2.5 px-3 rounded-xl border border-dashed border-blue-300 text-blue-700 dark:text-blue-400 bg-blue-50/40 dark:bg-slate-900/60 hover:bg-blue-50 font-bold text-xs inline-flex items-center justify-center gap-1">
                            <Plus className="h-3.5 w-3.5" /> Create & Match Bill
                          </button>
                          <button onClick={() => {
                            setShowNewExpenseHeadForm(true);
                            setShowNewPurchaseForm(false);
                            setNewExpenseHead({
                              code: getSuggestedExpenseCode(),
                              name: (matchDialog.txn.description || '').replace(/[\d\-\/]/g, ' ').replace(/\s+/g, ' ').trim()
                            });
                          }} className="flex-1 py-2.5 px-3 rounded-xl border border-dashed border-amber-300 text-amber-700 dark:text-amber-400 bg-amber-50/40 dark:bg-slate-900/60 hover:bg-amber-50 font-bold text-xs inline-flex items-center justify-center gap-1">
                            <Plus className="h-3.5 w-3.5" /> Book directly to new Expense Account
                          </button>
                        </div>
                      )}
                    </>
                  )}

                  <div className="max-h-[360px] overflow-y-auto divide-y border rounded-xl">
                    {invoiceLoading ? (
                      <div className="p-6 text-center"><MiniLoader height={22} /></div>
                    ) : filteredInvoices.length === 0 ? (
                      <div className="p-6 text-center space-y-4">
                        <p className="text-sm text-slate-400">No invoices found for this company.</p>
                        <div className="bg-amber-50/50 dark:bg-slate-900/60 border border-amber-200 dark:border-slate-800 rounded-xl p-4 text-left">
                          <p className="text-xs text-amber-800 dark:text-amber-400 font-semibold mb-3">
                            💡 Since this is an expense with no purchase record (bill), you can book it directly to an Expense Head/Account.
                          </p>
                          <div className="flex flex-col sm:flex-row gap-2">
                            <Button size="sm" variant="outline" className="flex-1 border-amber-300 text-amber-900 dark:text-amber-400 text-xs font-bold bg-white dark:bg-slate-800 hover:bg-amber-50"
                              onClick={() => { setDialogTab('expense'); setShowNewHead(false); }}>
                              Switch to Ledgers
                            </Button>
                            <Button size="sm" className="flex-1 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold"
                              onClick={() => { setDialogTab('expense'); setShowNewHead(true); }}>
                              + Create New Account
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      filteredInvoices
                        .map(inv => ({ inv, score: scoreInvoiceMatch(matchDialog.txn, inv) }))
                        .sort((a, b) => b.score - a.score)
                        .map(({ inv, score }) => (
                          <button key={inv.id} onClick={() => confirmMatch(matchDialog.txn, inv, score)}
                            className="w-full text-left p-3 hover:bg-blue-50 flex items-center justify-between gap-3 dark:hover:bg-slate-700/60">
                            <div className="min-w-0">
                              <p className="text-sm font-bold text-slate-800 dark:text-slate-100 truncate">
                                {invNumber(inv) || '—'} · {invParty(inv) || '—'}
                              </p>
                              <p className="text-xs text-slate-500">{fmtDate(invDate(inv))} · {inv.gstin || inv.customer_gstin || inv.supplier_gstin || ''}</p>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <p className="text-sm font-bold text-slate-700 dark:text-slate-300">{fmtC(invAmount(inv))}</p>
                              <p className={`text-[10px] font-bold ${score >= 70 ? 'text-emerald-600' : score >= 40 ? 'text-amber-600' : 'text-slate-400'}`}>{score}% match</p>
                            </div>
                          </button>
                        ))
                    )}
                  </div>
                </div>
              ) : (
                <div className="border rounded-xl">
                  <div className="flex items-center justify-between px-3 py-2 border-b bg-slate-50">
                    <p className="text-[11px] text-slate-500">
                      Pick the ledger head to book this bank line against. Posts Dr {'<head>'} / Cr Bank automatically.
                    </p>
                    <button onClick={() => setShowNewHead(true)}
                      className="text-[11px] font-bold px-2.5 py-1 rounded-md border border-blue-200 text-blue-700 hover:bg-blue-50 inline-flex items-center gap-1">
                      <Plus className="h-3 w-3" /> New Head
                    </button>
                  </div>
                  {showNewHead && (
                    <div className="p-3 border-b bg-blue-50/40 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <Input placeholder="Code (e.g. 5310)" value={newHead.code} onChange={e => setNewHead(h => ({ ...h, code: e.target.value }))} />
                        <Input placeholder="Name (e.g. Internet & Telephone)" value={newHead.name} onChange={e => setNewHead(h => ({ ...h, name: e.target.value }))} />
                        <Select value={newHead.type} onValueChange={v => setNewHead(h => ({ ...h, type: v }))}>
                          <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="expense">Expense</SelectItem>
                            <SelectItem value="income">Income</SelectItem>
                            <SelectItem value="asset">Asset</SelectItem>
                            <SelectItem value="liability">Liability</SelectItem>
                            <SelectItem value="equity">Equity</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input placeholder="Sub-type (operating_expense)" value={newHead.sub_type} onChange={e => setNewHead(h => ({ ...h, sub_type: e.target.value }))} />
                      </div>
                      <div className="flex gap-2 justify-end">
                        <Button size="sm" variant="outline" onClick={() => setShowNewHead(false)}>Cancel</Button>
                        <Button size="sm" onClick={createHead} disabled={savingHead}>{savingHead ? '…' : 'Create & Match'}</Button>
                      </div>
                    </div>
                  )}
                  <div className="max-h-[360px] overflow-y-auto divide-y">
                    {ledgerLoading ? (
                      <div className="p-6 text-center"><MiniLoader height={22} /></div>
                    ) : filteredLedgers.length === 0 ? (
                      <p className="p-6 text-center text-sm text-slate-400">No ledger heads found. Create one above.</p>
                    ) : (
                      filteredLedgers.map(acct => (
                        <button key={acct.id} onClick={() => confirmLedgerMatch(matchDialog.txn, acct)}
                          className="w-full text-left p-3 hover:bg-emerald-50 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-bold text-slate-800 truncate">{acct.code} · {acct.name}</p>
                            <p className="text-xs text-slate-500 capitalize">{acct.type} · {acct.sub_type?.replace(/_/g, ' ')}</p>
                          </div>
                          {acct.code === '9998' && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">Suspense</span>
                          )}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}

              <p className="text-[11px] text-slate-400">
                {dialogTab === 'invoice'
                  ? `Confirming will ${matchDialog.mode === 'edit' ? 'reverse the previous reconciliation and create a new one' : 'create a new reconciliation'} — invoice status, ledger and dashboard update automatically.`
                  : 'Posting will create a journal entry (Dr chosen head / Cr Bank for debits, reverse for credits). Use Suspense when you\'re not sure yet — reclassify later.'}
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Audit trail dialog */}
      <Dialog open={!!auditDialog} onOpenChange={(o) => { if (!o) setAuditDialog(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Audit trail</DialogTitle></DialogHeader>
          {auditDialog && (
            <div className="space-y-2 max-h-[420px] overflow-y-auto text-sm">
              {(auditDialog.entries || []).length === 0 && <p className="text-slate-400">No audit entries yet.</p>}
              {(auditDialog.entries || []).map((e, i) => {
                const action = e.action || e.match_type || 'event';
                const who = e.performed_by_name || e.matched_by_user || '—';
                const when = e.matched_on || e.edited_on || e.unmatched_on || e.timestamp;
                const badge = action === 'matched' ? { label: 'Matched', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
                  : action === 'edited' ? { label: 'Edited', cls: 'bg-blue-50 text-blue-700 border-blue-200' }
                  : action === 'unmatched' ? { label: 'Unmatched', cls: 'bg-rose-50 text-rose-700 border-rose-200' }
                  : { label: action, cls: 'bg-slate-100 text-slate-600 border-slate-200' };
                const fmtMatch = (m) => m ? `${m.type || '—'} · ${m.label || m.id || '—'}` : '—';
                return (
                  <div key={i} className="border rounded-lg p-3 bg-slate-50 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${badge.cls}`}>{badge.label}</span>
                      <span className="text-[11px] text-slate-400">{when ? fmtDate(when) : ''}</span>
                    </div>
                    <p className="text-xs text-slate-600">By <span className="font-semibold text-slate-800">{who}</span></p>
                    {e.previous_match && <p className="text-xs text-slate-600">Previous match: <span className="font-medium">{fmtMatch(e.previous_match)}</span></p>}
                    {e.new_match && <p className="text-xs text-slate-600">New match: <span className="font-medium">{fmtMatch(e.new_match)}</span></p>}
                    {(e.confidence !== undefined && e.confidence !== null) && <p className="text-xs text-slate-600">Confidence: {Math.round(e.confidence)}%</p>}
                    {e.reason && <p className="text-xs text-slate-600">Reason: <span className="italic">{e.reason}</span></p>}
                  </div>
                );
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={showNewAccount} onOpenChange={(open) => {
        setShowNewAccount(open);
        if (!open) {
          setEditingAccountId(null);
          setForm({ bank_name: '', account_holder: '', account_number: '', ifsc: '', branch: '', account_type: 'current', opening_balance: 0, upi_id: '', company_id: '' });
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{editingAccountId ? 'Edit bank account' : 'Add bank account'}</DialogTitle></DialogHeader>
          <div className="space-y-3 mt-2">
            <Input placeholder="Bank name (e.g. HDFC Bank)" value={form.bank_name} onChange={e => setForm(f => ({ ...f, bank_name: e.target.value }))} />
            <Input placeholder="Account holder name" value={form.account_holder} onChange={e => setForm(f => ({ ...f, account_holder: e.target.value }))} />
            <Input placeholder="Account number" value={form.account_number} onChange={e => setForm(f => ({ ...f, account_number: e.target.value }))} />
            <Input placeholder="IFSC code" value={form.ifsc} onChange={e => setForm(f => ({ ...f, ifsc: e.target.value.toUpperCase() }))} />
            <Input placeholder="Branch (optional)" value={form.branch} onChange={e => setForm(f => ({ ...f, branch: e.target.value }))} />
            <Input placeholder="UPI ID (optional)" value={form.upi_id} onChange={e => setForm(f => ({ ...f, upi_id: e.target.value }))} />
            <Input type="number" placeholder="Opening balance" value={form.opening_balance} onChange={e => setForm(f => ({ ...f, opening_balance: e.target.value }))} />
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-slate-600">Link to Company (optional)</Label>
              <Select value={form.company_id || '__none__'} onValueChange={v => setForm(f => ({ ...f, company_id: v === '__none__' ? '' : v }))}>
                <SelectTrigger className="rounded-xl text-sm"><SelectValue placeholder="Select company…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— Not linked —</SelectItem>
                  {companies.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-slate-400">Links this bank account to a company so Sale &amp; Quotation PDFs can use the same bank details.</p>
            </div>
            <Button onClick={createAccount} disabled={savingAccount} className="w-full rounded-xl">
              {savingAccount ? <MiniLoader height={18} /> : 'Save bank account'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ExistingRecordsPanel
        open={showExistingRecords}
        onOpenChange={setShowExistingRecords}
        companyId={selected?.company_id || ''}
        isDark={isDark}
        title="Existing sale & purchase records"
        description="Everything already booked for this company, before you read in a new statement. A statement line that matches one of these will link to it automatically — nothing gets entered twice."
      />
    </div>
  );
}

function BankAccounts() {
  return (
    <RequestAccessGate module="bank" moduleLabel="Bank Accounts" permissionFlag="can_view_bank">
      <BankAccountsInner />
    </RequestAccessGate>
  );
}

export default BankAccounts;
