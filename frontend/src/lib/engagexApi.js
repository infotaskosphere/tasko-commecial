// EngageX API client (backend: backend/engagex/router.py, mounted at /api/engagex).
import api, { getErrorMessage } from '@/lib/api';

const BASE = '/engagex';
const channelPrefix = (channel) => (channel === 'whatsapp' ? `${BASE}/whatsapp` : `${BASE}/mail`);
const data = (promise) => promise.then((res) => res.data);
// Never leave a page spinning forever: a stalled backend surfaces as an error with Retry.
const TIMEOUT = { timeout: 45000 };
const UPLOAD_TIMEOUT = { timeout: 180000 };

/** Read a File as base64 (without the data: prefix). */
export function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',').pop());
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}
const clean = (params = {}) =>
  Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== 'all'));

/** Human-readable error text, including EngageX's structured {message, campaign_id} details. */
export function engagexError(error) {
  const detail = error?.response?.data?.detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail) && detail.message) return String(detail.message);
  if (error?.code === 'ECONNABORTED') return 'The server is taking too long to respond. It may be starting up — please retry in a moment.';
  return getErrorMessage(error);
}

export const engagexApi = {
  // Dashboard
  overview: (days = 30) => data(api.get(`${BASE}/overview`, { params: { days }, ...TIMEOUT })),
  history: (params) => data(api.get(`${BASE}/history`, { params: clean(params), ...TIMEOUT })),
  exportHistory: async (params) => {
    const res = await api.get(`${BASE}/history/export`, { params: clean(params), responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const link = document.createElement('a');
    link.href = url;
    link.download = `engagex-history-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },

  // Shared per channel
  audience: (channel, params) => data(api.get(`${channelPrefix(channel)}/audience`, { params: clean(params) })),
  campaigns: (channel, params) => data(api.get(`${channelPrefix(channel)}/campaigns`, { params: clean(params), ...TIMEOUT })),
  campaign: (channel, id, params) => data(api.get(`${channelPrefix(channel)}/campaigns/${id}`, { params: clean(params) })),
  campaignAction: (channel, id, action) => data(api.post(`${channelPrefix(channel)}/campaigns/${id}/${action}`)),
  deleteCampaign: (channel, id) => data(api.delete(`${channelPrefix(channel)}/campaigns/${id}`)),
  templates: (channel) => data(api.get(`${channelPrefix(channel)}/templates`, TIMEOUT)),
  createTemplate: (channel, body) => data(api.post(`${channelPrefix(channel)}/templates`, body)),
  updateTemplate: (channel, id, body) => data(api.put(`${channelPrefix(channel)}/templates/${id}`, body)),
  deleteTemplate: (channel, id) => data(api.delete(`${channelPrefix(channel)}/templates/${id}`)),
  suppressions: (channel, q) => data(api.get(`${channelPrefix(channel)}/suppressions`, { params: clean({ q }) })),
  addSuppressions: (channel, addresses, reason) => data(api.post(`${channelPrefix(channel)}/suppressions`, { addresses, reason })),
  removeSuppression: (channel, address) => data(api.delete(`${channelPrefix(channel)}/suppressions/${encodeURIComponent(address)}`)),

  // WhatsApp Hub
  whatsappSessions: () => data(api.get(`${BASE}/whatsapp/sessions`, TIMEOUT)),
  createWhatsAppCampaign: (body) => data(api.post(`${BASE}/whatsapp/campaigns`, body, UPLOAD_TIMEOUT)),

  // MailMaster
  senders: () => data(api.get(`${BASE}/mail/senders`, TIMEOUT)),
  createSender: (body) => data(api.post(`${BASE}/mail/senders`, body)),
  updateSender: (id, body) => data(api.put(`${BASE}/mail/senders/${id}`, body)),
  deleteSender: (id) => data(api.delete(`${BASE}/mail/senders/${id}`)),
  setDefaultSender: (id) => data(api.post(`${BASE}/mail/senders/${id}/default`)),
  testSend: (body) => data(api.post(`${BASE}/mail/test-send`, body, UPLOAD_TIMEOUT)),
  /** Upload a banner/inline image (public URL returned) or a private attachment. */
  uploadMailFile: async (file, purpose) => data(api.post(`${BASE}/mail/uploads`, {
    filename: file.name, mime_type: file.type || 'application/octet-stream', base64: await readFileBase64(file), purpose,
  }, UPLOAD_TIMEOUT)),
  lists: () => data(api.get(`${BASE}/mail/lists`, TIMEOUT)),
  createList: (body) => data(api.post(`${BASE}/mail/lists`, body)),
  updateList: (id, body) => data(api.put(`${BASE}/mail/lists/${id}`, body)),
  deleteList: (id) => data(api.delete(`${BASE}/mail/lists/${id}`)),
  contacts: (listId, params) => data(api.get(`${BASE}/mail/lists/${listId}/contacts`, { params: clean(params) })),
  addContacts: (listId, contacts) => data(api.post(`${BASE}/mail/lists/${listId}/contacts`, { contacts })),
  removeContact: (listId, contactId) => data(api.delete(`${BASE}/mail/lists/${listId}/contacts/${contactId}`)),
  createMailCampaign: (body, action = 'draft', scheduledAt) =>
    data(api.post(`${BASE}/mail/campaigns`, body, { params: clean({ action, scheduled_at: scheduledAt }) })),
  updateMailCampaign: (id, body) => data(api.put(`${BASE}/mail/campaigns/${id}`, body)),
  launchMailCampaign: (id, action, scheduledAt) =>
    data(api.post(`${BASE}/mail/campaigns/${id}/launch`, { action, scheduled_at: scheduledAt || null })),
  duplicateMailCampaign: (id) => data(api.post(`${BASE}/mail/campaigns/${id}/duplicate`)),
};

export default engagexApi;
