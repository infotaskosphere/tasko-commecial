/**
 * GuidanceNote.jsx
 * ─────────────────────────────────────────────────────────────────────────
 * A small, dismissible "how do I use this page" banner + step-by-step
 * popup, meant to be dropped into any Accounts page with a single line:
 *
 *     <GuidanceNote pageKey="journal-entries" isDark={isDark} />
 *
 * Content lives centrally in GUIDANCE_CONTENT below (plain language, no
 * accounting jargon) so every page stays consistent and new pages just
 * need one new dictionary entry — no new component code.
 *
 * Behaviour:
 *  - First visit: shows an amber banner with a one-line plain-English
 *    summary of the page, and a "Show me how" button that opens a modal
 *    with numbered steps.
 *  - Dismiss (X): collapses to a small "Guide" pill in the same spot so
 *    help is never more than one click away, but doesn't nag once read.
 *  - Dismissal is remembered per page (localStorage), not globally.
 */
import React, { useState } from 'react';
import { HelpCircle, X, Lightbulb, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PopupHeader } from '@/components/ui/popup-header';

export const GUIDANCE_CONTENT = {
  'accounting-integrity': {
    title: 'Fixing a mistake in a locked entry',
    plain: "Entries created automatically by the system (from a sale, purchase, or bank match) are locked so nothing gets silently changed. To fix one, you don't edit it — you add a short correcting note, and the system works out the accounting for you.",
    steps: [
      { h: '1. Find the entry', p: 'Look through the locked entries list for the one with the wrong amount or wrong account.' },
      { h: '2. Click "Raise Adjustment"', p: 'This opens a simple form. Just say which account should go up and which should go down — no debit/credit knowledge needed.' },
      { h: '3. Explain why', p: 'Write a short note like "Vendor invoice amount was entered wrong — corrected from ₹8,000 to ₹8,020." Future-you (or your accountant) will thank you.' },
      { h: '4. Post it', p: 'Both the original and the correction stay visible forever — nothing is ever deleted, so your records stay fully traceable.' },
    ],
    tip: 'You never need to know what "debit" or "credit" means to use this — just say which account should go up and which should go down.',
  },
  'journal-entries': {
    title: 'What is a Journal Entry?',
    plain: "Every sale, purchase, or bank transaction creates an entry here automatically — think of it as your business's diary of money movements. You only add one manually for something that doesn't fit Sale, Purchase, or Bank.",
    steps: [
      { h: 'When do I add one manually?', p: 'Only for things outside normal sales/purchases — e.g. an owner contributing personal cash, or correcting an opening balance.' },
      { h: 'Pick the accounts', p: "Search by plain name (e.g. \"Cash\", \"Rent\") — you don't need to remember any codes." },
      { h: 'Amounts must match', p: "The total going in must equal the total going out. The system checks this for you and won't let you save until it balances." },
    ],
    tip: "If in doubt, don't guess — Zero-Touch Entry (AI) can create the entry for you straight from a document.",
  },
  'chart-of-accounts': {
    title: 'What is the Chart of Accounts?',
    plain: 'This is the master list of every "bucket" your money can sit in or move through — Cash, Bank, Sales, Rent, and so on. Every transaction in the app touches one or more of these buckets.',
    steps: [
      { h: 'Browse, don\'t worry', p: 'Most buckets already exist for you — you rarely need to create new ones.' },
      { h: 'Add one only when needed', p: "Create a new account only when nothing existing fits — e.g. a new bank account or a new expense category." },
      { h: 'Type matters', p: 'When adding one, the type (Asset, Liability, Income, Expense, Equity) tells the system where it shows up in your reports. If unsure, pick the closest match or ask your accountant.' },
    ],
  },
  'bank-accounts': {
    title: 'Connecting and using bank accounts',
    plain: 'Add your business bank accounts here so transactions can be matched automatically against your books, and so reports know where your cash actually sits.',
    steps: [
      { h: '1. Add your account', p: 'Enter the bank name and account number — this is just identification, no accounting knowledge needed.' },
      { h: '2. Import statements', p: 'Upload a bank statement and the system tries to match each line to an existing entry automatically.' },
      { h: '3. Review the leftovers', p: "Anything the system can't match on its own gets flagged — just tell it which invoice or bill it belongs to." },
    ],
  },
  'gst-portal-sync': {
    title: 'What is this page for?',
    plain: 'This pulls your live GST balances — what you owe (Electronic Liability Register) and what credit you have available (Electronic Credit Ledger) — straight from the tax portal, so you always know where you stand before filing.',
    steps: [
      { h: '1. Connect your GSTIN', p: 'Enter your GST number once — this links your account to the portal.' },
      { h: '2. Sync', p: 'Click sync to pull the latest balances — no manual data entry required.' },
      { h: '3. Read the numbers', p: 'The liability figure is what you owe; the credit ledger is what you can use to offset it. Your accountant can confirm the net payable if you\'re unsure.' },
    ],
  },
  'gst-reconciliation': {
    title: 'What is GST Reconciliation?',
    plain: 'This compares the purchases you\'ve recorded against what your vendors have actually reported to the government (GSTR-2B), so you can catch missing or mismatched credit before it costs you.',
    steps: [
      { h: '1. Let it match automatically', p: 'The system pairs up your purchase records with the vendor-reported data for you.' },
      { h: '2. Look at the "unmatched" pile', p: "These are the ones that need a human look — usually a mismatched amount or invoice number." },
      { h: '3. Ask, don\'t guess', p: 'If something looks off, the fastest fix is usually a quick message to the vendor confirming the invoice number and amount.' },
    ],
  },
  'purchase': {
    title: 'Recording a Purchase',
    plain: "Just upload the supplier's invoice (PDF or photo) — the app reads the vendor, amount, and GST for you and creates the accounting entry automatically. You don't need to enter anything by hand or know any accounting.",
    steps: [
      { h: '1. Upload the invoice', p: 'Drop in the PDF or image of the supplier bill.' },
      { h: '2. Let it match', p: 'The app matches it to the right vendor/company automatically.' },
      { h: '3. Review "Needs Review" items', p: "If something couldn't be read confidently, it's flagged here for a quick manual check — everything else posts itself." },
    ],
  },
  'invoicing': {
    title: 'Creating an Invoice',
    plain: "Use this whenever your business sells something to a customer. Fill in what was sold and to whom — the system handles GST, totals, and the accounting entry for you.",
    steps: [
      { h: '1. Pick the customer', p: "Search by name; add a new customer right from this screen if needed." },
      { h: '2. Add what was sold', p: 'List the items or services — amounts and tax are calculated automatically.' },
      { h: '3. Send and track', p: 'Once sent, this page tracks whether it\'s been paid, so you always know who still owes you.' },
    ],
  },
  'accounting-reports': {
    title: 'Finding the right report',
    plain: "This hub links to every accounting report your business needs. You don't need to open all of them — most people only ever use a handful.",
    steps: [
      { h: 'Just starting out?', p: 'Day Book and Cash/Bank Book are the simplest — a plain, chronological list of what happened.' },
      { h: 'Checking who owes you money?', p: 'Outstanding shows unpaid invoices and bills at a glance.' },
      { h: 'Preparing for a CA or investor?', p: "Financial Ratios, Comparative, and Yearly Report are best reviewed together with your accountant." },
    ],
  },
  'extended-reports': {
    title: 'About these reports',
    plain: "Each tab is a different way of looking at the same underlying transactions. Not sure where to start? Day Book is the simplest — it just lists everything that happened, in order.",
    steps: [
      { h: 'Day Book / Cash-Bank Book', p: 'A plain list of what happened and when — closest to a bank statement.' },
      { h: 'Outstanding / Bank Reconciliation', p: 'Shows who owes you, who you owe, and whether your bank account matches your books.' },
      { h: 'Financial Ratios / Comparative / Yearly', p: "Higher-level analysis — most useful with your accountant, not required day-to-day." },
    ],
  },
  default: {
    title: 'Need a hand with this page?',
    plain: 'This page is part of your accounting workflow. If a term looks unfamiliar, your accountant can usually explain it in one sentence — don\'t let it hold you up.',
    steps: [],
  },
};

export function GuidanceNote({ pageKey = 'default', isDark, className = '' }) {
  const content = GUIDANCE_CONTENT[pageKey] || GUIDANCE_CONTENT.default;
  const storageKey = `guidance_dismissed_${pageKey}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(storageKey) === '1'; } catch { return false; }
  });
  const [open, setOpen] = useState(false);

  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(storageKey, '1'); } catch { /* ignore */ }
  };

  return (
    <>
      {dismissed ? (
        <button
          onClick={() => setOpen(true)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition ${
            isDark ? 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
          } ${className}`}
        >
          <HelpCircle className="h-3.5 w-3.5" style={{ color: '#1F6FB2' }} />
          Guide: {content.title}
        </button>
      ) : (
        <div className={`rounded-2xl border p-4 flex items-start gap-3 ${isDark ? 'bg-amber-500/10 border-amber-500/30' : 'bg-amber-50 border-amber-200'} ${className}`}>
          <div className={`h-8 w-8 rounded-xl flex items-center justify-center shrink-0 ${isDark ? 'bg-amber-500/20' : 'bg-amber-100'}`}>
            <Lightbulb className="h-4 w-4 text-amber-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className={`text-sm font-bold ${isDark ? 'text-amber-200' : 'text-amber-900'}`}>{content.title}</p>
            <p className={`text-xs mt-0.5 leading-relaxed ${isDark ? 'text-amber-200/80' : 'text-amber-800/90'}`}>{content.plain}</p>
            {content.steps?.length > 0 && (
              <button onClick={() => setOpen(true)} className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-amber-700 hover:underline">
                Show me how <ChevronRight className="h-3 w-3" />
              </button>
            )}
          </div>
          <button
            onClick={dismiss}
            className={`shrink-0 h-6 w-6 rounded-lg flex items-center justify-center ${isDark ? 'hover:bg-amber-500/20 text-amber-300' : 'hover:bg-amber-100 text-amber-700'}`}
            aria-label="Dismiss guide"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 bg-emerald-900/40 z-[60] flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div
            className={`w-full max-w-lg rounded-2xl shadow-2xl p-6 max-h-[85vh] overflow-y-auto overflow-x-hidden ${isDark ? 'bg-slate-800' : 'bg-white'}`}
            onClick={(e) => e.stopPropagation()}
          >
            <PopupHeader className="-mx-6 -mt-6 mb-4" icon={Lightbulb} eyebrow="How this works" title={content.title} titleAs="h3" onClose={() => setOpen(false)} />
            <p className={`text-sm mb-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{content.plain}</p>
            {content.steps?.length > 0 && (
              <div className="space-y-2.5">
                {content.steps.map((s, i) => (
                  <div key={i} className={`rounded-xl p-3 ${isDark ? 'bg-slate-900/50' : 'bg-slate-50'}`}>
                    <p className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{s.h}</p>
                    <p className={`text-xs mt-1 leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{s.p}</p>
                  </div>
                ))}
              </div>
            )}
            {content.tip && (
              <div className={`mt-4 rounded-xl p-3 text-xs flex items-start gap-2 ${isDark ? 'bg-emerald-500/10 text-emerald-300' : 'bg-emerald-50 text-emerald-800'}`}>
                <Lightbulb className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{content.tip}</span>
              </div>
            )}
            <div className="flex justify-end mt-5">
              <Button onClick={() => setOpen(false)}>Got it</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default GuidanceNote;
