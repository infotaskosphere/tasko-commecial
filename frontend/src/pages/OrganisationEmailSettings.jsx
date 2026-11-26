/**
 * Settings → Organisation Email.
 *
 * The mailbox every module sends from (invoices, quotations, reminders,
 * compliance, client portal codes, EngageX), plus each user's own mailboxes.
 * Reading inboxes for events is separate: Settings → Email Accounts.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Send } from 'lucide-react';
import OrganisationEmail from '@/components/OrganisationEmail';
import { useDark } from '@/hooks/useDark';

export default function OrganisationEmailSettings() {
  const isDark = useDark();
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-50 dark:bg-blue-500/10">
          <Send className="h-5 w-5 text-blue-600" />
        </div>
        <div>
          <h1 className={`text-lg font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Organisation Email</h1>
          <p className={`text-sm ${muted}`}>
            Connect once here — every module sends from this mailbox. To read an inbox for due dates and notices, use{' '}
            <Link to="/settings/email" className="font-semibold text-blue-600 hover:underline">Email Accounts</Link>.
          </p>
        </div>
      </div>
      <OrganisationEmail isDark={isDark} />
    </div>
  );
}
