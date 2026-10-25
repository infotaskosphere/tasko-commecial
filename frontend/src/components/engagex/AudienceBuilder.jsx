// AudienceBuilder — pick recipients from Clients, pasted text, or a CSV/Excel file.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Building2, ClipboardPaste, FileSpreadsheet, Loader2, Search, Trash2, Upload, Users, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { engagexApi, engagexError } from '@/lib/engagexApi';
import { addressKey, dedupeRecipients, detectColumns, parsePasted, parseSpreadsheet, rowsToRecipients } from './shared';

const NONE = '__none__';

function useDebounced(value, ms = 350) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const t = setTimeout(() => setDebounced(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return debounced;
}

function ClientsTab({ channel, onAdd }) {
  const key = addressKey(channel);
  const [q, setQ] = useState('');
  const [clientType, setClientType] = useState('all');
  const [service, setService] = useState('all');
  const [includeContacts, setIncludeContacts] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState({ items: [], facets: { client_types: [], services: [] } });
  const [picked, setPicked] = useState(() => new Set());
  const debouncedQ = useDebounced(q);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await engagexApi.audience(channel, { q: debouncedQ, client_type: clientType, service, include_contacts: includeContacts });
      setResult(data);
      setPicked(new Set());
    } catch (error) {
      toast.error(engagexError(error));
    } finally {
      setLoading(false);
    }
  }, [channel, debouncedQ, clientType, service, includeContacts]);

  useEffect(() => { load(); }, [load]);

  const items = result.items || [];
  const allPicked = items.length > 0 && picked.size === items.length;
  const toggle = (id) => setPicked((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const add = (rows) => onAdd(rows.map((r) => ({ name: r.name, [key]: r[key], company: r.company, client_id: r.client_id })), 'clients');

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clients, contacts, numbers…" className="pl-8" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={clientType} onValueChange={setClientType}>
          <SelectTrigger className="w-[150px]"><SelectValue placeholder="Client type" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {(result.facets?.client_types || []).map((t) => <SelectItem key={t} value={t}>{t.replace(/_/g, ' ')}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={service} onValueChange={setService}>
          <SelectTrigger className="w-[160px]"><SelectValue placeholder="Service" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All services</SelectItem>
            {(result.facets?.services || []).map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
          <Checkbox checked={includeContacts} onCheckedChange={(v) => setIncludeContacts(Boolean(v))} /> Include contact persons
        </label>
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/60">
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
            <Checkbox checked={allPicked} onCheckedChange={(v) => setPicked(v ? new Set(items.map((i) => i.id)) : new Set())} disabled={!items.length} />
            {loading ? 'Loading…' : `${items.length.toLocaleString('en-IN')} contacts with a ${channel === 'whatsapp' ? 'mobile number' : 'valid email'}`}
          </label>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={!picked.size} onClick={() => add(items.filter((i) => picked.has(i.id)))}>Add selected ({picked.size})</Button>
            <Button size="sm" disabled={!items.length} onClick={() => add(items)}>Add all</Button>
          </div>
        </div>
        <div className="max-h-[300px] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : items.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-400">No matching clients. Clients are managed in Master Data.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-t border-slate-100 dark:border-slate-700/60 hover:bg-slate-50/60 dark:hover:bg-slate-800/40 cursor-pointer" onClick={() => toggle(item.id)}>
                    <td className="w-10 px-3 py-2"><Checkbox checked={picked.has(item.id)} onCheckedChange={() => toggle(item.id)} onClick={(e) => e.stopPropagation()} /></td>
                    <td className="px-2 py-2 min-w-0">
                      <p className="font-medium text-slate-800 dark:text-slate-100 truncate">{item.name}</p>
                      <p className="text-[11px] text-slate-500 truncate">{item.contact_role}{item.contact_role !== 'Primary' && item.company ? ` · ${item.company}` : ''}</p>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">{item[key]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function PasteTab({ channel, onAdd }) {
  const [text, setText] = useState('');
  const placeholder = channel === 'whatsapp'
    ? 'One per line, e.g.\nRavi Sharma, 98765 43210\n+91 99999 00000'
    : 'One per line, e.g.\nRavi Sharma <ravi@example.com>\naccounts@example.com';
  return (
    <div className="space-y-3">
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder={placeholder} className="font-mono text-sm" />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-slate-500">{channel === 'whatsapp' ? '10-digit numbers get the +91 prefix automatically.' : 'Invalid addresses are skipped automatically.'}</p>
        <Button size="sm" disabled={!text.trim()} onClick={() => { onAdd(parsePasted(channel, text), 'pasted list'); setText(''); }}>
          <ClipboardPaste className="h-4 w-4 mr-1.5" />Add to audience
        </Button>
      </div>
    </div>
  );
}

function ImportTab({ channel, onAdd }) {
  const key = addressKey(channel);
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [mapping, setMapping] = useState({});
  const [busy, setBusy] = useState(false);

  const onFile = async (f) => {
    if (!f) return;
    setBusy(true);
    try {
      const result = await parseSpreadsheet(f);
      if (!result.rows.length) throw new Error('The file has no rows.');
      setFile(f);
      setParsed(result);
      setMapping(detectColumns(result.headers));
    } catch (error) {
      toast.error(error?.message || 'Could not read that file.');
    } finally {
      setBusy(false);
    }
  };

  const fields = [[key, channel === 'whatsapp' ? 'Mobile number' : 'Email address', true], ['name', 'Name'], ['company', 'Company / client']];
  return (
    <div className="space-y-3">
      <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls,.txt" className="hidden" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
      {!parsed ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 py-10 text-slate-500 hover:border-teal-400 hover:text-teal-700 dark:border-slate-600 dark:hover:text-teal-300"
        >
          {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <Upload className="h-6 w-6" />}
          <span className="text-sm font-semibold">Upload CSV or Excel</span>
          <span className="text-xs">Columns are matched automatically; extra columns become personalisation fields.</span>
        </button>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
            <span className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200"><FileSpreadsheet className="h-4 w-4 text-emerald-600" />{file?.name} · {parsed.rows.length.toLocaleString('en-IN')} rows</span>
            <Button size="sm" variant="ghost" onClick={() => { setParsed(null); setFile(null); }}><X className="h-4 w-4" /></Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {fields.map(([field, label, required]) => (
              <div key={field}>
                <p className="mb-1 text-[11px] font-semibold text-slate-500">{label}{required ? ' *' : ''}</p>
                <Select value={mapping[field] || NONE} onValueChange={(v) => setMapping((m) => ({ ...m, [field]: v === NONE ? undefined : v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>— Not mapped —</SelectItem>
                    {parsed.headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!mapping[key]}
              onClick={() => { onAdd(rowsToRecipients(parsed.rows, mapping), file?.name || 'file'); setParsed(null); setFile(null); }}
            >
              Add {parsed.rows.length.toLocaleString('en-IN')} rows
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Controlled audience editor.
 * @param {'whatsapp'|'email'} channel
 * @param {Array} value recipients [{name, phone|email, company, client_id, variables}]
 */
export default function AudienceBuilder({ channel, value, onChange, showClients = true }) {
  const key = addressKey(channel);
  const [filter, setFilter] = useState('');

  const add = (incoming, source) => {
    const before = value.length;
    const { rows, invalid } = dedupeRecipients(channel, [...value, ...incoming]);
    const added = rows.length - before;
    onChange(rows);
    const notes = [];
    if (incoming.length - added - invalid > 0) notes.push(`${incoming.length - added - invalid} duplicates skipped`);
    if (invalid) notes.push(`${invalid} invalid`);
    toast.success(`Added ${added.toLocaleString('en-IN')} from ${source}${notes.length ? ` (${notes.join(', ')})` : ''}`);
  };

  const shown = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const list = term ? value.filter((r) => `${r.name} ${r[key]} ${r.company}`.toLowerCase().includes(term)) : value;
    return list.slice(0, 200);
  }, [value, filter, key]);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <Tabs defaultValue={showClients ? 'clients' : 'paste'} className="min-w-0">
        <TabsList className="mb-3 h-auto">
          {showClients && <TabsTrigger value="clients"><Building2 className="h-4 w-4 mr-1.5" />Clients</TabsTrigger>}
          <TabsTrigger value="paste"><ClipboardPaste className="h-4 w-4 mr-1.5" />Paste</TabsTrigger>
          <TabsTrigger value="import"><FileSpreadsheet className="h-4 w-4 mr-1.5" />Import file</TabsTrigger>
        </TabsList>
        {showClients && <TabsContent value="clients"><ClientsTab channel={channel} onAdd={add} /></TabsContent>}
        <TabsContent value="paste"><PasteTab channel={channel} onAdd={add} /></TabsContent>
        <TabsContent value="import"><ImportTab channel={channel} onAdd={add} /></TabsContent>
      </Tabs>

      <div className="min-w-0 rounded-xl border border-slate-200 dark:border-slate-700 flex flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2.5 dark:border-slate-700">
          <span className="flex items-center gap-2 text-sm font-bold text-slate-800 dark:text-slate-100">
            <Users className="h-4 w-4 text-teal-600" /> Audience <span className="rounded-full bg-teal-50 px-2 py-0.5 text-xs text-teal-700 dark:bg-teal-500/15 dark:text-teal-300">{value.length.toLocaleString('en-IN')}</span>
          </span>
          {value.length > 0 && <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => onChange([])}><Trash2 className="h-4 w-4 mr-1" />Clear</Button>}
        </div>
        {value.length > 8 && (
          <div className="px-3 pt-2"><Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter audience…" className="h-8 text-xs" /></div>
        )}
        <div className="max-h-[340px] min-h-[160px] overflow-y-auto">
          {value.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-slate-400">No recipients yet. Add clients, paste a list, or import a file.</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-700/60">
              {shown.map((r) => (
                <li key={r[key]} className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-800 dark:text-slate-100">{r.name || <span className="text-slate-400">No name</span>}</p>
                    <p className="truncate font-mono text-[11px] text-slate-500">{r[key]}{r.company ? ` · ${r.company}` : ''}</p>
                  </div>
                  <button type="button" className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10" onClick={() => onChange(value.filter((x) => x[key] !== r[key]))} aria-label="Remove recipient">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
              {value.length > shown.length && <li className="px-3 py-2 text-center text-xs text-slate-400">+ {(value.length - shown.length).toLocaleString('en-IN')} more</li>}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
