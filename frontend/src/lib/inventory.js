// Pure helpers for the Inventory tab (no React, so they can be tested on their own).

/** Movement types, matching the server's kinds. `direction` says whether stock comes in or goes out. */
export const MOVEMENT_KINDS = {
  purchase: { label: 'Purchase receipt', direction: 'in', needsRate: true },
  opening: { label: 'Opening stock', direction: 'in', needsRate: true },
  sales_return: { label: 'Sales return', direction: 'in', needsRate: false },
  adjustment_in: { label: 'Stock gain (count adjustment)', direction: 'in', needsRate: false },
  sale: { label: 'Sale issue', direction: 'out', needsRate: false },
  purchase_return: { label: 'Purchase return', direction: 'out', needsRate: false },
  adjustment_out: { label: 'Stock loss (damage, shortage)', direction: 'out', needsRate: false },
};

export const needsRate = (kind) => !!MOVEMENT_KINDS[kind]?.needsRate;

/** True when a receipt is missing the rate the server will insist on. */
export const rateMissing = (form) => needsRate(form?.kind) && (form.rate === undefined || form.rate === null || form.rate === '');

/** Label and colour for an item's stock position. */
export function stockStatus(item) {
  const qty = Number(item?.quantity) || 0;
  if (qty < 0) return { label: 'Negative', tone: 'bad' };
  if (qty === 0) return { label: 'Out of stock', tone: 'mute' };
  if (item?.below_reorder) return { label: 'Reorder', tone: 'warn' };
  return { label: 'In stock', tone: 'good' };
}
