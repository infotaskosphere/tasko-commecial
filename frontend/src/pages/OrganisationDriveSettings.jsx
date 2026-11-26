/**
 * Settings → Google Drive.
 *
 * One place to connect the organisation's Google Drive. Every module saves
 * to it (no module has its own Drive connection). Users can also connect a
 * personal Drive here for their own browsing.
 */
import React from 'react';
import { HardDrive } from 'lucide-react';
import DriveIntegrations from '@/components/DriveIntegrations';
import { useDark } from '@/hooks/useDark';

const USED_BY = [
  'Finix — invoices, quotations & billing PDFs',
  'ClientSync — client documents',
  'Client portal — files shared with clients',
  'Backup & Restore — backups',
];

export default function OrganisationDriveSettings() {
  const isDark = useDark();
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: 'rgba(66,133,244,0.12)' }}>
          <HardDrive className="h-5 w-5" style={{ color: '#4285F4' }} />
        </div>
        <div>
          <h1 className={`text-lg font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Google Drive</h1>
          <p className={`text-sm ${muted}`}>Connect once here — every module saves to this Drive.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {USED_BY.map((m) => (
              <span key={m} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${isDark ? 'bg-slate-700 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>{m}</span>
            ))}
          </div>
        </div>
      </div>
      <DriveIntegrations isDark={isDark} />
    </div>
  );
}
