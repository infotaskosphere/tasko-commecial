// Pure helpers for the Standards and Notes tabs (no React, so they can be tested on their own).

export const PROVISION_TREATMENT = {
  recognise: { label: 'Provided', tone: 'good' },
  disclose: { label: 'Disclose only', tone: 'warn' },
  ignore: { label: 'Remote, not disclosed', tone: 'mute' },
};

export const RELATIONSHIPS = {
  holding_company: 'Holding company', subsidiary: 'Subsidiary', fellow_subsidiary: 'Fellow subsidiary', associate: 'Associate', joint_venture: 'Joint venture',
  kmp: 'Key management personnel', kmp_relative: 'Relative of key management personnel', kmp_enterprise: 'Enterprise controlled or influenced by key management personnel', other: 'Other related party',
};

/** The distinct currency codes among foreign-currency items, sorted. */
export const distinctCurrencies = (items) => [...new Set((items || []).map((i) => String(i.currency || '').toUpperCase()).filter(Boolean))].sort();

/** Totals from a revaluation preview: assets, liabilities and the net gain (+) or loss (-). */
export function fxSummary(preview) {
  const assets = Number(preview?.assets_difference) || 0;
  const liabilities = Number(preview?.liabilities_difference) || 0;
  return { assets, liabilities, net: Math.round((assets + liabilities) * 100) / 100 };
}

export const LEASE_TREATMENT = {
  rou: { label: 'Right-of-use asset', tone: 'info' },
  finance: { label: 'Finance lease', tone: 'info' },
  operating: { label: 'Operating lease', tone: 'mute' },
  exempt: { label: 'Short-term or low-value', tone: 'mute' },
};

/** Whether a lease carries an asset and a liability, and so must be recognised before its periods are posted. */
export const isCapitalLease = (lease) => lease?.treatment === 'rou' || lease?.treatment === 'finance';

/** What the next step is for a lease. */
export function leaseNextStep(lease) {
  if (isCapitalLease(lease) && !lease.recognised) return 'recognise';
  return 'post';
}

export const NOTE_STATUS = {
  complete: { label: 'Complete', tone: 'good' },
  needs_input: { label: 'Needs input', tone: 'warn' },
  not_applicable: { label: 'Not applicable', tone: 'mute' },
};

/** The notes that still need something from the user. */
export const pendingNotes = (sections) => (sections || []).filter((s) => s.status === 'needs_input');

/** Plain-text copy of the notes, for pasting into a document. */
export function notesToText(report) {
  const lines = [`Notes to accounts, ${report.financial_year} (${report.framework === 'IND_AS' ? 'Ind AS' : 'AS'})`, ''];
  (report.sections || []).forEach((s) => {
    lines.push(`${s.no}. ${s.title} [${s.standard}]`);
    if (s.kind === 'policies') s.policies.forEach((p) => lines.push(`  ${p.title} (${p.standard}): ${p.text}`));
    if (s.text) lines.push(`  ${s.text}`);
    if (s.columns) { lines.push(`  ${s.columns.join(' | ')}`); s.rows.forEach((r) => lines.push(`  ${r.join(' | ')}`)); }
    if (s.second_table) { lines.push(`  ${s.second_table.title}`); lines.push(`  ${s.second_table.columns.join(' | ')}`); s.second_table.rows.forEach((r) => lines.push(`  ${r.join(' | ')}`)); }
    lines.push('');
  });
  return lines.join('\n');
}
