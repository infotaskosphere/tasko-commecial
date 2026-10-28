import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CheckCircle2, Copy, Loader2, Pencil, Plus, QrCode, RefreshCw, Smartphone, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import api from '@/lib/api';

const POLL_MS = 4000;
// Give up polling after this long without a connection, so an abandoned
// dialog does not keep a bridge login open forever.
const GIVE_UP_MS = 4 * 60 * 1000;

const errorText = (error, fallback) => {
  const detail = error?.response?.data?.detail;
  return typeof detail === 'string' ? detail : fallback;
};

const STATUS_STYLE = {
  connected: 'bg-emerald-100 text-emerald-700',
  connecting: 'bg-amber-100 text-amber-700',
  qr: 'bg-amber-100 text-amber-700',
  disconnected: 'bg-slate-100 text-slate-600',
};

function NumberRow({ session, canManage, busy, onReconnect, onRemove, onRename }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(session.label || '');
  useEffect(() => { if (!editing) setValue(session.label || ''); }, [session.label, editing]);
  const status = session.connected ? 'connected' : (session.status || 'disconnected');
  const save = async () => {
    const next = value.trim();
    if (!next || next === session.label) { setEditing(false); return; }
    if (await onRename(next)) setEditing(false);
  };
  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex items-center gap-1">
              <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={60} className="h-7 text-sm" autoFocus onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }} />
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={save} aria-label="Save name"><Check className="h-3.5 w-3.5" /></Button>
            </div>
          ) : (
            <p className="flex items-center gap-1 truncate text-sm font-medium">{session.label || session.session_id}
              {canManage ? <button type="button" className="text-slate-400 hover:text-slate-700" onClick={() => setEditing(true)} aria-label="Rename"><Pencil className="h-3 w-3" /></button> : null}
            </p>
          )}
          <p className="text-[11px] text-slate-500">{session.phone ? `+${session.phone}` : 'Number not linked yet'}</p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${STATUS_STYLE[status] || STATUS_STYLE.connecting}`}>{status}</span>
      </div>
      {canManage ? (
        <div className="mt-2 flex justify-end gap-1">
          {!session.connected ? <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={onReconnect}><RefreshCw className="mr-1 h-3 w-3" />Reconnect</Button> : null}
          <Button size="sm" variant="ghost" className="h-7 text-xs text-rose-600" disabled={busy} onClick={onRemove}><Trash2 className="mr-1 h-3 w-3" />{session.connected ? 'Disconnect' : 'Remove'}</Button>
        </div>
      ) : null}
    </div>
  );
}

export default function WhatsAppConnectDialog({ open, onOpenChange, sessions = [], canManage = true, onChanged }) {
  const [label, setLabel] = useState('');
  const [phone, setPhone] = useState('');
  const [mode, setMode] = useState('qr');
  // The login in progress: { session_id, label, mode, reconnect }
  const [pending, setPending] = useState(null);
  const [qr, setQr] = useState(null);
  const [pairCode, setPairCode] = useState(null);
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');
  const [busyId, setBusyId] = useState(null);
  const timer = useRef(null);
  const startedAt = useRef(0);
  const live = useRef(false);

  const stopPolling = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const poll = useCallback(async (sid, selectedMode) => {
    if (!live.current) return;
    if (Date.now() - startedAt.current > GIVE_UP_MS) {
      setStatus('expired');
      setQr(null);
      setPairCode(null);
      setMessage('The login timed out. Press Reconnect to get a new code.');
      onChanged?.();
      return;
    }
    try {
      const endpoint = selectedMode === 'pair' ? `/whatsapp/sessions/${sid}/pair-code` : `/whatsapp/sessions/${sid}/qr`;
      const { data } = await api.get(endpoint);
      if (!live.current) return;
      if (data.status === 'connected') {
        setStatus('connected');
        setQr(null);
        setPairCode(null);
        setMessage('');
        stopPolling();
        toast.success('WhatsApp number connected');
        onChanged?.();
        return;
      }
      if (data.error) setMessage(String(data.error));
      if (selectedMode === 'pair' && data.code) setPairCode(data.code);
      if (selectedMode === 'qr') setQr(data.qr || null);
      setStatus(data.qr || data.code ? 'ready' : 'waiting');
      timer.current = setTimeout(() => poll(sid, selectedMode), POLL_MS);
    } catch (error) {
      if (!live.current) return;
      const code = error?.response?.status;
      if (code === 429 || code === 502 || code === 503) {
        // Bridge busy or restarting: keep trying, more slowly.
        setStatus('waiting');
        timer.current = setTimeout(() => poll(sid, selectedMode), Math.min(POLL_MS * 3, 15000));
      } else {
        setStatus('error');
        setMessage(errorText(error, 'Could not get the login code from WhatsApp.'));
      }
    }
  }, [onChanged, stopPolling]);

  useEffect(() => {
    live.current = open;
    if (!open) {
      stopPolling();
      setPending(null);
      setQr(null);
      setPairCode(null);
      setStatus('idle');
      setMessage('');
    }
    return () => { live.current = false; stopPolling(); };
  }, [open, stopPolling]);

  const beginPolling = (session, selectedMode) => {
    stopPolling();
    startedAt.current = Date.now();
    setPending({ ...session, mode: selectedMode });
    setQr(null);
    setPairCode(null);
    setMessage('');
    setStatus('waiting');
    poll(session.session_id, selectedMode);
  };

  const cleanedPhone = phone.replace(/\D/g, '');
  const phoneOk = cleanedPhone.length >= 10 && cleanedPhone.length <= 15;

  const startConnection = async (selectedMode = mode) => {
    if (selectedMode === 'pair' && !phoneOk) {
      toast.error('Enter the WhatsApp number with country code, e.g. 919876543210.');
      return;
    }
    setStatus('creating');
    try {
      const { data } = await api.post('/whatsapp/sessions', {
        label: label.trim() || undefined,
        pairing_phone: selectedMode === 'pair' ? cleanedPhone : undefined,
      });
      setLabel('');
      onChanged?.();
      beginPolling({ session_id: data.sessionId, label: data.label }, selectedMode);
    } catch (error) {
      setStatus('error');
      setMessage(errorText(error, 'Could not start the WhatsApp connection.'));
    }
  };

  const reconnect = async (session) => {
    const selectedMode = mode;
    if (selectedMode === 'pair' && !phoneOk) {
      toast.error('Enter the WhatsApp number in the Pairing Code tab first, or switch to QR Code.');
      return;
    }
    setBusyId(session.session_id);
    try {
      await api.post(`/whatsapp/sessions/${session.session_id}/reconnect`, { pairing_phone: selectedMode === 'pair' ? cleanedPhone : undefined });
      onChanged?.();
      beginPolling(session, selectedMode);
    } catch (error) {
      toast.error(errorText(error, 'Could not restart this number.'));
    } finally {
      setBusyId(null);
    }
  };

  const removeSession = async (session) => {
    const verb = session.connected ? 'Disconnect' : 'Remove';
    if (!window.confirm(`${verb} ${session.label || 'this number'}? Broadcasts using it will pause until another number is selected.`)) return;
    setBusyId(session.session_id);
    try {
      await api.delete(`/whatsapp/sessions/${session.session_id}`);
      if (pending?.session_id === session.session_id) { stopPolling(); setPending(null); setStatus('idle'); }
      onChanged?.();
      toast.success(session.connected ? 'WhatsApp number disconnected' : 'Number removed');
    } catch (error) {
      toast.error(errorText(error, 'Could not remove the number.'));
    } finally {
      setBusyId(null);
    }
  };

  const rename = async (session, next) => {
    try {
      await api.patch(`/whatsapp/sessions/${session.session_id}/label`, { label: next });
      onChanged?.();
      return true;
    } catch (error) {
      toast.error(errorText(error, 'Could not rename the number.'));
      return false;
    }
  };

  const copyCode = async () => {
    if (!pairCode) return;
    try { await navigator.clipboard?.writeText(pairCode); toast.success('Pairing code copied'); }
    catch { toast.error('Copy failed — please type the code.'); }
  };

  const cancelPending = () => { stopPolling(); setPending(null); setStatus('idle'); setQr(null); setPairCode(null); setMessage(''); onChanged?.(); };

  const connectedCount = sessions.filter((s) => s.connected).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Smartphone className="h-5 w-5 text-emerald-600" /> WhatsApp numbers</DialogTitle>
          <DialogDescription>Add and connect the WhatsApp numbers your broadcasts are sent from. Numbers are private to your company.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
          <div className="space-y-3 rounded-xl border border-slate-200 p-4">
            <div className="flex items-center justify-between"><p className="text-sm font-semibold">Your numbers</p><span className="text-xs text-slate-400">{connectedCount} connected</span></div>
            {sessions.length === 0 ? <p className="text-xs text-slate-500">No WhatsApp numbers added yet.</p> : (
              <div className="space-y-2">
                {sessions.map((s) => (
                  <NumberRow key={s.session_id} session={s} canManage={canManage} busy={busyId === s.session_id}
                    onReconnect={() => reconnect(s)} onRemove={() => removeSession(s)} onRename={(next) => rename(s, next)} />
                ))}
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-xl border border-emerald-100 bg-emerald-50/30 p-4">
            {!canManage ? (
              <p className="text-sm text-slate-600">Only an admin can add or connect WhatsApp numbers. Ask your admin to connect one; you can then send broadcasts from it.</p>
            ) : pending ? (
              <div className="rounded-xl border bg-white p-4 text-center dark:bg-slate-900">
                <p className="text-xs font-semibold text-slate-600">{pending.label || 'New number'}</p>
                {status === 'connected' ? (
                  <div className="py-6"><CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" /><p className="mt-2 font-semibold text-emerald-700">WhatsApp connected</p><Button size="sm" variant="outline" className="mt-3" onClick={cancelPending}>Add another number</Button></div>
                ) : (
                  <>
                    {qr ? <><img src={qr} alt="WhatsApp QR code" className="mx-auto mt-3 h-56 w-56 rounded-lg border bg-white p-1" /><p className="mt-2 text-[11px] text-slate-500">On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan. The code refreshes automatically.</p></> : null}
                    {pairCode ? <div className="mt-4"><p className="font-mono text-3xl font-bold tracking-[0.2em]">{pairCode}</p><Button size="sm" variant="outline" className="mt-3" onClick={copyCode}><Copy className="mr-1.5 h-4 w-4" />Copy code</Button><p className="mt-2 text-[11px] text-slate-500">On your phone: WhatsApp → Linked devices → Link a device → Link with phone number instead, then enter this code.</p></div> : null}
                    {status === 'waiting' && !qr && !pairCode ? <p className="flex items-center justify-center gap-2 py-6 text-xs text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Preparing the {pending.mode === 'pair' ? 'pairing code' : 'QR code'}…</p> : null}
                    {message ? <p className={`mt-3 text-xs ${status === 'error' || status === 'expired' ? 'text-rose-600' : 'text-slate-500'}`}>{message}</p> : null}
                    <div className="mt-3 flex justify-center gap-2">
                      {status === 'error' || status === 'expired' ? <Button size="sm" onClick={() => reconnect(pending)} className="bg-emerald-600 text-white hover:bg-emerald-700"><RefreshCw className="mr-1.5 h-4 w-4" />Try again</Button> : null}
                      <Button size="sm" variant="ghost" onClick={cancelPending}>Cancel</Button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <>
                <div><p className="text-sm font-semibold">Add a number</p><p className="text-xs text-slate-500">Link it by scanning a QR code or with a pairing code sent to the phone.</p></div>
                <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="Name, e.g. Office WhatsApp" />
                <Tabs value={mode} onValueChange={setMode}>
                  <TabsList className="grid w-full grid-cols-2"><TabsTrigger value="qr"><QrCode className="mr-1.5 h-4 w-4" />QR code</TabsTrigger><TabsTrigger value="pair"><Smartphone className="mr-1.5 h-4 w-4" />Pairing code</TabsTrigger></TabsList>
                  <TabsContent value="qr" className="mt-3 space-y-3">
                    <Button className="w-full bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => startConnection('qr')} disabled={status === 'creating'}>{status === 'creating' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}Generate QR code</Button>
                  </TabsContent>
                  <TabsContent value="pair" className="mt-3 space-y-3">
                    <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="WhatsApp number with country code, e.g. 919876543210" inputMode="numeric" />
                    {phone && !phoneOk ? <p className="text-[11px] text-rose-600">Enter 10–15 digits including the country code.</p> : null}
                    <Button className="w-full bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => startConnection('pair')} disabled={status === 'creating' || !phoneOk}>{status === 'creating' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Smartphone className="mr-2 h-4 w-4" />}Get pairing code</Button>
                  </TabsContent>
                </Tabs>
                {status === 'error' && message ? <p className="text-xs text-rose-600">{message}</p> : null}
                <p className="text-[11px] text-slate-500">To reconnect an existing number, choose QR code or Pairing code here, then press Reconnect next to it.</p>
              </>
            )}
          </div>
        </div>

        <div className="flex justify-end"><Button variant="ghost" onClick={() => onOpenChange(false)}><X className="mr-1.5 h-4 w-4" />Close</Button></div>
      </DialogContent>
    </Dialog>
  );
}
