/**
 * CampaignDock — floating chips for running and minimised campaigns (email
 * and WhatsApp), shown on every page. Sending happens on the server; this
 * only shows progress and reopens the campaign.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronUp, Mail, MessageCircle, X } from 'lucide-react';
import { engagexApi } from '@/lib/engagexApi';
import { campaignPagePath, dismissCampaign, minimisedCampaigns, subscribeDock } from '@/lib/campaignDock';

const ACTIVE = 'queued,running,scheduled';
const POLL_MS = 30000;

function statusLine(c) {
  const st = c.stats || {};
  const done = (st.sent || 0) + (st.failed || 0) + (st.skipped || 0);
  if (c.status === 'scheduled') return `Starts ${new Date(c.scheduled_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  if (c.throttled_until && new Date(c.throttled_until) > new Date()) {
    return `${done}/${st.total || 0} · resumes ${new Date(c.throttled_until).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  }
  if (c.status === 'running' || c.status === 'queued') return `${done}/${st.total || 0} sent`;
  return `${c.status} · ${st.sent || 0}/${st.total || 0} sent`;
}

export default function CampaignDock() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [collapsed, setCollapsed] = useState(false);
  const [pinned, setPinned] = useState(minimisedCampaigns());
  const denied = useRef(new Set()); // channels this user cannot open (403) — stop asking

  useEffect(() => subscribeDock(setPinned), []);

  const load = useCallback(async () => {
    const found = new Map();
    for (const channel of ['email', 'whatsapp']) {
      if (denied.current.has(channel)) continue;
      try {
        const res = await engagexApi.campaigns(channel, { status: ACTIVE, page_size: 10 });
        (res.items || []).forEach((c) => found.set(c.id, { ...c, channel }));
      } catch (error) {
        const code = error?.response?.status;
        if (code === 401 || code === 403 || code === 404) denied.current.add(channel);
      }
    }
    for (const p of pinned) {
      if (found.has(p.id)) continue;
      try { const res = await engagexApi.campaign(p.channel, p.id, { page_size: 10 }); if (res?.campaign) found.set(p.id, { ...res.campaign, channel: p.channel }); }
      catch { dismissCampaign(p.id); }
    }
    setItems([...found.values()]);
  }, [pinned]);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  if (!items.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[120] w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900" role="region" aria-label="Campaigns sending in the background">
      <button type="button" onClick={() => setCollapsed((v) => !v)} className="flex w-full items-center justify-between px-3 py-2 text-xs font-bold text-slate-700 dark:text-slate-200">
        <span>{items.length} campaign{items.length > 1 ? 's' : ''} in the background</span>
        {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {!collapsed && (
        <ul className="max-h-72 space-y-1.5 overflow-y-auto px-2 pb-2">
          {items.map((c) => {
            const st = c.stats || {};
            const pct = st.total ? Math.round((((st.sent || 0) + (st.failed || 0) + (st.skipped || 0)) / st.total) * 100) : 0;
            const Icon = c.channel === 'whatsapp' ? MessageCircle : Mail;
            const isPinned = pinned.some((p) => p.id === c.id);
            return (
              <li key={c.id} className="rounded-xl border border-slate-100 p-2 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800">
                <div className="flex items-start gap-2">
                  <button type="button" className="flex min-w-0 flex-1 items-start gap-2 text-left" onClick={() => navigate(campaignPagePath(c.channel, c.id))} title="Open campaign">
                    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${c.channel === 'whatsapp' ? 'text-emerald-600' : 'text-indigo-600'}`} />
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-semibold text-slate-800 dark:text-slate-100">{c.name}</span>
                      <span className="block truncate text-[11px] text-slate-500">{statusLine(c)}</span>
                    </span>
                  </button>
                  {isPinned && !['queued', 'running', 'scheduled'].includes(c.status) && (
                    <button type="button" onClick={() => dismissCampaign(c.id)} className="text-slate-400 hover:text-slate-600" aria-label="Remove from dock"><X className="h-3.5 w-3.5" /></button>
                  )}
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div className={`h-full ${c.channel === 'whatsapp' ? 'bg-emerald-500' : 'bg-indigo-500'}`} style={{ width: `${pct}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
