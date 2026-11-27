/**
 * Minimised campaigns. A campaign's progress window can be minimised into the
 * floating dock; sending itself always runs on the server, so it keeps going
 * whether the window is open, minimised, or the user has logged out.
 */
const KEY = 'onenexa_minimised_campaigns';
const listeners = new Set();

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]').filter((c) => c && c.id && c.channel); }
  catch { return []; }
}

function write(items) {
  try { localStorage.setItem(KEY, JSON.stringify(items.slice(0, 12))); } catch { /* storage unavailable */ }
  listeners.forEach((fn) => fn(items));
}

export function minimisedCampaigns() { return read(); }

export function minimiseCampaign({ id, channel, name }) {
  write([{ id, channel, name: name || 'Campaign' }, ...read().filter((c) => c.id !== id)]);
}

export function dismissCampaign(id) { write(read().filter((c) => c.id !== id)); }

export function subscribeDock(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export const campaignPagePath = (channel, id) =>
  `${channel === 'whatsapp' ? '/engagex/whatsapp' : '/engagex/mailmaster'}?campaign=${encodeURIComponent(id)}`;
