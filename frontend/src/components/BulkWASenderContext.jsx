/**
 * BulkWASenderContext.jsx
 * Runs WhatsApp send jobs outside page components so navigation/closing the
 * composer does not stop an active broadcast.
 */
import React, { createContext, useContext, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import api from '@/lib/api';

const Ctx = createContext(null);

const initialState = {
  active: false, minimized: false, visible: false, batchId: null, batchName: '',
  sessionId: null, total: 0, done: 0, results: [], pauseCountdown: null,
  scheduledAt: null, startedAt: null, finishedAt: null,
};

function newBatchId() {
  return `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length === 10 ? `91${digits}` : digits;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

export function BulkWASenderProvider({ children }) {
  const [state, setState] = useState(initialState);
  const cancelRef = useRef(false);
  const runningRef = useRef(false);

  const patch = useCallback((p) => setState(s => ({ ...s, ...p })), []);
  const cancel = useCallback(() => { cancelRef.current = true; patch({ pauseCountdown: null }); }, [patch]);
  const dismiss = useCallback(() => { if (!runningRef.current) setState(initialState); }, []);
  const minimize = useCallback(() => patch({ minimized: true }), [patch]);
  const expand = useCallback(() => patch({ minimized: false }), [patch]);

  const startBatch = useCallback(async ({
    batchName,
    recipients,
    sessionId = null,
    pauseEnabled = false,
    pauseAfterCount = 10,
    pauseDurationSec = 60,
    messageType = 'bulk_client',
    minDelaySec = 0,
    maxDelaySec = 0,
    scheduledAt = null,
  }) => {
    if (runningRef.current) return toast.error('A WhatsApp batch is already running. Please wait or cancel it.');

    const list = (recipients || []).filter(r => r && r.phone && (r.message || r.media || (r.attachments && r.attachments.length)));
    if (!list.length) return toast.error('No recipients with a phone number and message.');

    const batchId = newBatchId();
    const name = (batchName || '').trim() || `Batch ${new Date().toLocaleString('en-IN')}`;
    const lo = Math.max(0, Number(minDelaySec) || 0);
    const hi = Math.max(lo, Number(maxDelaySec) || lo);
    const targetTime = scheduledAt ? new Date(scheduledAt).getTime() : 0;
    if (scheduledAt && (!Number.isFinite(targetTime) || targetTime <= Date.now())) {
      return toast.error('Please choose a future schedule time.');
    }

    runningRef.current = true;
    cancelRef.current = false;
    setState({ ...initialState, active: true, visible: true, minimized: true, batchId, batchName: name, sessionId, total: list.length, scheduledAt: scheduledAt || null, startedAt: targetTime ? null : new Date().toISOString() });

    if (targetTime) {
      toast.success(`Campaign "${name}" scheduled for ${new Date(targetTime).toLocaleString('en-IN')}.`);
      let remaining = targetTime - Date.now();
      while (remaining > 0 && !cancelRef.current) {
        const slice = Math.min(remaining, 1000);
        await sleep(slice);
        remaining = targetTime - Date.now();
      }
      if (cancelRef.current) {
        runningRef.current = false;
        cancelRef.current = false;
        setState(s => ({ ...s, active: false, pauseCountdown: null, finishedAt: new Date().toISOString() }));
        toast.warning(`Scheduled batch "${name}" cancelled.`);
        return;
      }
      setState(s => ({ ...s, scheduledAt: scheduledAt || null, startedAt: new Date().toISOString() }));
      toast.success(`Scheduled batch "${name}" is now sending.`);
    } else {
      toast.success(`Batch "${name}" started — ${list.length} recipients. Sending in background.`);
    }

    const results = [];
    for (let i = 0; i < list.length; i++) {
      if (cancelRef.current) break;
      const r = list[i];
      const to = normalizePhone(r.phone);
      const contextId = r.id || null;
      const attachments = r.attachments?.length ? r.attachments : (r.media ? [r.media] : []);
      let status = 'sent';
      let errorMsg = null;

      try {
        if (r.message && r.message.trim()) {
          await api.post('/whatsapp/send', {
            to, message: r.message, message_type: messageType, context_id: contextId,
            session_id: sessionId || undefined, batch_id: batchId, batch_name: name,
          });
        }
        for (let a = 0; a < attachments.length; a++) {
          if (cancelRef.current) break;
          const media = attachments[a];
          await api.post('/whatsapp/send-media', {
            to,
            caption: !r.message?.trim() && a === 0 ? `Dear ${r.name || 'Client'},` : undefined,
            base64: media.base64,
            mime_type: media.mimeType || media.type || 'application/octet-stream',
            filename: media.name || media.filename || `attachment-${a + 1}`,
            message_type: messageType,
            context_id: contextId,
            session_id: sessionId || undefined,
            batch_id: batchId,
            batch_name: name,
          });
        }
      } catch (err) {
        status = 'failed';
        errorMsg = err?.response?.data?.detail || err?.message || 'Failed';
      }

      results.push({ id: contextId, name: r.name, phone: to, status, error: errorMsg, attachmentCount: attachments.length });
      setState(s => ({ ...s, done: i + 1, results: [...results] }));

      const isLast = i === list.length - 1;
      if (pauseEnabled && !isLast && pauseAfterCount > 0 && (i + 1) % pauseAfterCount === 0) {
        let remaining = Number(pauseDurationSec) || 0;
        setState(s => ({ ...s, pauseCountdown: remaining }));
        while (remaining > 0 && !cancelRef.current) {
          await sleep(1000);
          remaining -= 1;
          setState(s => ({ ...s, pauseCountdown: Math.max(0, remaining) }));
        }
        setState(s => ({ ...s, pauseCountdown: null }));
      } else if (!isLast && hi > 0) {
        const delay = lo === hi ? lo : (lo + Math.random() * (hi - lo));
        let remainingMs = delay * 1000;
        while (remainingMs > 0 && !cancelRef.current) {
          const slice = Math.min(remainingMs, 1000);
          await sleep(slice);
          remainingMs -= slice;
        }
      }
    }

    const sentCount = results.filter(r => r.status === 'sent').length;
    const failCount = results.filter(r => r.status === 'failed').length;
    const aborted = cancelRef.current;
    setState(s => ({ ...s, active: false, pauseCountdown: null, finishedAt: new Date().toISOString() }));
    runningRef.current = false;
    cancelRef.current = false;
    if (aborted) toast.warning(`Batch "${name}" cancelled — ${sentCount} sent, ${failCount} failed.`);
    else toast.success(`Batch "${name}" complete — ${sentCount} sent${failCount ? `, ${failCount} failed` : ''}.`);
  }, []);

  return <Ctx.Provider value={{ state, startBatch, cancel, dismiss, minimize, expand }}>{children}</Ctx.Provider>;
}

export function useBulkWASender() {
  const v = useContext(Ctx);
  if (!v) return { state: initialState, startBatch: async () => toast.error('Bulk WA sender not initialized'), cancel: () => {}, dismiss: () => {}, minimize: () => {}, expand: () => {} };
  return v;
}
