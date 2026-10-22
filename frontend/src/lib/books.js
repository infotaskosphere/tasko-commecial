// Pure helpers for the Books & Vouchers page (kept free of React so they can be tested on their own).

export const VOUCHER_LABELS = { payment: 'Payment', receipt: 'Receipt', contra: 'Contra', journal: 'Journal', sales: 'Sales', purchase: 'Purchase', debit_note: 'Debit Note', credit_note: 'Credit Note' };
export const ENTERABLE = ['payment', 'receipt', 'contra', 'journal'];

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Debit and credit totals of journal lines (blank cells count as nothing), and whether they agree. */
export function journalTotals(lines) {
  const debit = round2((lines || []).reduce((s, l) => s + (Number(l.debit) || 0), 0));
  const credit = round2((lines || []).reduce((s, l) => s + (Number(l.credit) || 0), 0));
  return { debit, credit, difference: round2(debit - credit), balanced: debit > 0 && Math.abs(debit - credit) < 0.005 };
}

/** The sum of the particulars of a payment or receipt. */
export const particularsTotal = (rows) => round2((rows || []).reduce((s, r) => s + (Number(r.amount) || 0), 0));

/** Cash and bank ledgers, the only accounts Payment, Receipt and Contra vouchers may use. Journals must avoid them. */
export const isCashBank = (a) => a?.type === 'asset' && a?.schedule3_head === 'Cash and cash equivalents';

/** Accounts a payment/receipt may list as particulars (anything except cash and bank). */
export const particularAccounts = (accounts) => (accounts || []).filter((a) => a.is_active !== false && !a.is_group && !isCashBank(a));

/** Financial years (April to March) around a date, newest first, as "2026-27". */
export function fyOptions(now = new Date(), back = 4) {
  const start = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return Array.from({ length: back + 1 }, (_, i) => { const y = start - i; return `${y}-${String(y + 1).slice(-2)}`; });
}

/** A readable message from an API error whose detail may be a string, a list or {message, items}. */
export function errText(err, fallback = 'Something went wrong. Please try again.') {
  const d = err?.response?.data?.detail;
  if (!d) return err?.message && !err?.response ? err.message : fallback;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d.map((x) => x?.msg || x?.message || String(x)).join('. ');
  return d.message || fallback;
}

/** Today as YYYY-MM-DD in local time. */
export const todayIso = (now = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
};

export const SEVERITY_ORDER = { blocker: 0, warning: 1, info: 2 };
export const sortChecklist = (items) => [...(items || [])].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));

export const FRAMEWORK_INFO = {
  AS: { label: 'ICAI Accounting Standards (AS)', blurb: 'For companies not covered by Ind AS, firms, LLPs and proprietors. Follows AS 1 to AS 29 and Schedule III Division I.' },
  IND_AS: { label: 'Indian Accounting Standards (Ind AS)', blurb: 'Mandatory for listed companies and those over the net-worth thresholds. Follows Ind AS and Schedule III Division II.' },
};
