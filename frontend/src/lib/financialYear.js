/**
 * Indian financial-year helpers (1 April – 31 March).
 *
 * The year in which a financial year STARTS depends on the month:
 *   Apr–Dec  -> starts 1 April of the same calendar year
 *   Jan–Mar  -> started 1 April of the PREVIOUS calendar year
 *
 * Dates are formatted from LOCAL calendar fields. `toISOString()` converts to
 * UTC first, which moves local-midnight dates back one day in time zones east
 * of UTC (e.g. India), so it must not be used to build report date ranges.
 */

const pad = (n) => String(n).padStart(2, '0');

/** YYYY-MM-DD from the local calendar fields of `date`. */
export function toLocalISODate(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Calendar year in which the financial year containing `now` begins. */
export function financialYearStartYear(now = new Date()) {
  return now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
}

/** { from: 'YYYY-04-01', to: 'YYYY+1-03-31', label: 'FY 2026-27' } for the FY containing `now`. */
export function currentFinancialYearRange(now = new Date()) {
  const start = financialYearStartYear(now);
  return {
    from: `${start}-04-01`,
    to: `${start + 1}-03-31`,
    label: `FY ${start}-${String(start + 1).slice(-2)}`,
  };
}
