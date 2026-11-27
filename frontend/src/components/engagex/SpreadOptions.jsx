/**
 * SpreadOptions — split a campaign across several days (email and WhatsApp).
 *
 * value: { daily_limit, send_start_hour, send_end_hour }  (null = off)
 * The server keeps sending by itself, day after day, even when nobody is
 * logged in; times are India time (Asia/Kolkata).
 */
import React from 'react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

const HOURS = Array.from({ length: 25 }, (_, h) => h);
const label = (h) => (h === 24 ? '24:00' : `${String(h).padStart(2, '0')}:00`);

export function spreadPayload(v) {
  return {
    daily_limit: v?.daily_limit ? Number(v.daily_limit) : null,
    send_start_hour: v?.hours ? Number(v.send_start_hour) : null,
    send_end_hour: v?.hours ? Number(v.send_end_hour) : null,
    timezone: 'Asia/Kolkata',
  };
}

export function spreadFromSettings(st = {}) {
  return {
    daily_limit: st.daily_limit || '',
    hours: st.send_start_hour != null && st.send_end_hour != null,
    send_start_hour: st.send_start_hour ?? 10,
    send_end_hour: st.send_end_hour ?? 19,
  };
}

export function spreadDays(total, v, mailboxDaily = 0) {
  const caps = [Number(v?.daily_limit) || 0, Number(mailboxDaily) || 0].filter((n) => n > 0);
  const perDay = caps.length ? Math.min(...caps) : 0;
  return perDay && total > perDay ? Math.ceil(total / perDay) : 1;
}

export default function SpreadOptions({ value, onChange, unit = 'emails', total = 0, mailboxDaily = 0, mailboxName = '' }) {
  const v = value || spreadFromSettings();
  const set = (patch) => onChange({ ...v, ...patch });
  const days = spreadDays(total, v, mailboxDaily);
  // The mailbox's own safe daily limit always applies on top of this setting.
  const capped = mailboxDaily && Number(v.daily_limit) > mailboxDaily;
  const perDay = capped ? mailboxDaily : Number(v.daily_limit) || mailboxDaily || 0;
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <p className="text-xs font-semibold text-slate-500">Spread over days <span className="font-normal">(optional — keeps going on its own, even after you log out)</span></p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold text-slate-500">Max {unit} per day
          <Input type="number" min={1} className="mt-1" value={v.daily_limit} placeholder="No daily limit"
            onChange={(e) => set({ daily_limit: e.target.value ? Math.max(1, Number(e.target.value) || 1) : '' })} />
          <span className="mt-1 block font-normal text-slate-400">
            {capped && <span className="block text-amber-600">{mailboxName || 'This mailbox'} sends at most {mailboxDaily} a day to keep the account safe, so {mailboxDaily} a day will be used.</span>}
            {days > 1 ? `${total.toLocaleString('en-IN')} ${unit} will go out over about ${days} days (${perDay.toLocaleString('en-IN')} a day).` : 'The rest continues the next day.'}
          </span>
        </label>
        <div className="text-xs font-semibold text-slate-500">
          <label className="flex items-center gap-2"><Switch checked={!!v.hours} onCheckedChange={(on) => set({ hours: on })} />Only send between (India time)</label>
          {v.hours && (
            <div className="mt-2 flex items-center gap-2">
              <select className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-800" value={v.send_start_hour}
                onChange={(e) => set({ send_start_hour: Number(e.target.value), send_end_hour: Math.max(Number(e.target.value) + 1, v.send_end_hour) })} aria-label="Start hour">
                {HOURS.slice(0, 24).map((h) => <option key={h} value={h}>{label(h)}</option>)}
              </select>
              <span>and</span>
              <select className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-800" value={v.send_end_hour}
                onChange={(e) => set({ send_end_hour: Number(e.target.value) })} aria-label="End hour">
                {HOURS.slice(1).filter((h) => h > v.send_start_hour).map((h) => <option key={h} value={h}>{label(h)}</option>)}
              </select>
            </div>
          )}
          <span className="mt-1 block font-normal text-slate-400">Outside these hours it waits and resumes automatically.</span>
        </div>
      </div>
    </div>
  );
}
