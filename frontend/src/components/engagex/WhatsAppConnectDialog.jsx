import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Copy, Loader2, Plus, QrCode, Smartphone, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import api from '@/lib/api';

const POLL_MS = 6000;

export default function WhatsAppConnectDialog({ open, onOpenChange, sessions = [], onChanged }) {
  const [label, setLabel] = useState('');
  const [phone, setPhone] = useState('');
  const [session, setSession] = useState(null);
  const [mode, setMode] = useState('qr');
  const [qr, setQr] = useState(null);
  const [pairCode, setPairCode] = useState(null);
  const [status, setStatus] = useState('idle');
  const timer = useRef(null);

  const stopPolling = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const poll = useCallback(async (sid, selectedMode) => {
    try {
      const endpoint = selectedMode === 'pair'
        ? `/whatsapp/sessions/${sid}/pair-code`
        : `/whatsapp/sessions/${sid}/qr`;
      const { data } = await api.get(endpoint);
      if (data.status === 'connected') {
        setStatus('connected');
        setQr(null);
        setPairCode(null);
        stopPolling();
        onChanged?.();
        return;
      }
      if (selectedMode === 'pair' && data.code) setPairCode(data.code);
      if (selectedMode === 'qr' && data.qr) setQr(data.qr);
      setStatus(data.status || (data.qr || data.code ? 'ready' : 'waiting'));
      timer.current = setTimeout(() => poll(sid, selectedMode), POLL_MS);
    } catch (error) {
      if (error?.response?.status === 429) {
        timer.current = setTimeout(() => poll(sid, selectedMode), Math.min(POLL_MS * 3, 30000));
      } else {
        setStatus('error');
      }
    }
  }, [onChanged, stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  useEffect(() => {
    if (!open) {
      stopPolling();
      setSession(null);
      setQr(null);
      setPairCode(null);
      setStatus('idle');
      return;
    }
    const connected = sessions.find((s) => s.connected);
    if (connected) setSession(connected);
  }, [open, sessions, stopPolling]);

  const startConnection = async (selectedMode = mode) => {
    const cleanedPhone = phone.replace(/\D/g, '');
    if (selectedMode === 'pair' && cleanedPhone.length < 10) {
      toast.error('Enter the WhatsApp number with country code, e.g. 919876543210.');
      return;
    }
    setStatus('creating');
    try {
      const { data } = await api.post('/whatsapp/sessions', {
        label: label.trim() || undefined,
        pairing_phone: selectedMode === 'pair' ? cleanedPhone : undefined,
      });
      setSession({ session_id: data.sessionId, label: data.label, connected: false });
      setQr(null);
      setPairCode(null);
      setStatus('waiting');
      await poll(data.sessionId, selectedMode);
      onChanged?.();
    } catch (error) {
      toast.error(error?.response?.data?.detail || 'Could not start WhatsApp connection.');
      setStatus('error');
    }
  };

  const copyCode = async () => {
    if (!pairCode) return;
    await navigator.clipboard?.writeText(pairCode);
    toast.success('Pairing code copied');
  };

  const removeSession = async (sid) => {
    if (!window.confirm('Disconnect this WhatsApp number from EngageX?')) return;
    try {
      await api.delete(`/whatsapp/sessions/${sid}`);
      if (session?.session_id === sid) setSession(null);
      onChanged?.();
      toast.success('WhatsApp number disconnected');
    } catch (error) {
      toast.error(error?.response?.data?.detail || 'Could not disconnect the number.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Smartphone className="h-5 w-5 text-emerald-600" /> WhatsApp Numbers</DialogTitle>
          <DialogDescription>Connect and manage the WhatsApp number used by EngageX broadcasts. The number remains scoped to your company.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
          <div className="space-y-3 rounded-xl border border-slate-200 p-4">
            <div className="flex items-center justify-between"><p className="text-sm font-semibold">Connected numbers</p><span className="text-xs text-slate-400">{sessions.filter((s) => s.connected).length} active</span></div>
            {sessions.length === 0 ? <p className="text-xs text-slate-500">No WhatsApp numbers connected yet.</p> : (
              <div className="space-y-2">
                {sessions.map((s) => (
                  <div key={s.session_id} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
                    <div className="min-w-0"><p className="truncate text-sm font-medium">{s.label || s.session_id}</p><p className="text-[11px] text-slate-500">{s.phone ? `+${s.phone}` : s.status || 'Unknown'}</p></div>
                    <div className="flex items-center gap-2">
                      <span className={`text-[11px] font-semibold ${s.connected ? 'text-emerald-600' : 'text-amber-600'}`}>{s.connected ? 'Connected' : s.status || 'Connecting'}</span>
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-rose-600" onClick={() => removeSession(s.session_id)} title="Disconnect"><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-xl border border-emerald-100 bg-emerald-50/30 p-4">
            <div><p className="text-sm font-semibold">Connect a new number</p><p className="text-xs text-slate-500">Use QR scanning or a WhatsApp phone pairing code.</p></div>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Number label, e.g. Office WhatsApp" />
            <Tabs value={mode} onValueChange={setMode}>
              <TabsList className="grid w-full grid-cols-2"><TabsTrigger value="qr"><QrCode className="mr-1.5 h-4 w-4" />QR Code</TabsTrigger><TabsTrigger value="pair"><Smartphone className="mr-1.5 h-4 w-4" />Pairing Code</TabsTrigger></TabsList>
              <TabsContent value="qr" className="mt-3 space-y-3"><Button className="w-full bg-emerald-600 hover:bg-emerald-700" onClick={() => startConnection('qr')} disabled={status === 'creating'}>{status === 'creating' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}Generate QR Code</Button></TabsContent>
              <TabsContent value="pair" className="mt-3 space-y-3"><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="919876543210" inputMode="numeric" /><Button className="w-full bg-emerald-600 hover:bg-emerald-700" onClick={() => startConnection('pair')} disabled={status === 'creating'}>{status === 'creating' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Smartphone className="mr-2 h-4 w-4" />}Generate Pairing Code</Button></TabsContent>
            </Tabs>

            {session && (qr || pairCode || status === 'connected') && (
              <div className="rounded-xl border bg-white p-4 text-center">
                <p className="text-xs font-semibold text-slate-600">{session.label}</p>
                {status === 'connected' ? <div className="py-6"><CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" /><p className="mt-2 font-semibold text-emerald-700">WhatsApp connected</p></div> : null}
                {qr ? <img src={qr} alt="WhatsApp QR code" className="mx-auto mt-3 h-56 w-56 rounded-lg border" /> : null}
                {pairCode ? <div className="mt-4"><p className="text-3xl font-mono font-bold tracking-[0.2em]">{pairCode}</p><Button size="sm" variant="outline" className="mt-3" onClick={copyCode}><Copy className="mr-1.5 h-4 w-4" />Copy code</Button><p className="mt-2 text-[11px] text-slate-500">On WhatsApp: Linked Devices → Link a device → Link with phone number.</p></div> : null}
                {status === 'waiting' && !qr && !pairCode ? <p className="py-6 text-xs text-slate-500">Waiting for the WhatsApp bridge…</p> : null}
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end"><Button variant="ghost" onClick={() => onOpenChange(false)}><X className="mr-1.5 h-4 w-4" />Close</Button></div>
      </DialogContent>
    </Dialog>
  );
}
