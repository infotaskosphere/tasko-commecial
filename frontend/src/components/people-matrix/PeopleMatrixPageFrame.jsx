import React from 'react';
import { CalendarDays, IdCard, UserPlus, Users, Wallet } from 'lucide-react';

const PAGE_META = {
  users: {
    eyebrow: 'TEAM MANAGEMENT',
    title: 'User Directory',
    description: 'Organize roles, track access, and onboard new members.',
    icon: Users,
  },
  leave: {
    eyebrow: 'TIME OFF & ABSENCE',
    title: 'Leave Management',
    description: 'Manage leave applications, absences and upcoming time off in one place.',
    icon: CalendarDays,
  },
  payroll: {
    eyebrow: 'PAYROLL PROCESSING',
    title: 'Payroll',
    description: 'Process salaries, statutory deductions and payroll reports with confidence.',
    icon: Wallet,
  },
  hr: {
    eyebrow: 'PEOPLE OPERATIONS',
    title: 'Human Resources',
    description: 'Live headcount, attendance and workforce insights from People Matrix.',
    icon: IdCard,
  },
  recruitment: {
    eyebrow: 'HR MODULE',
    title: 'Recruitment',
    description: 'Track candidates end-to-end — source, interview, rate, and convert hires into users in one click.',
    icon: UserPlus,
  },
};

export default function PeopleMatrixPageFrame({ page, children, action = null }) {
  const meta = PAGE_META[page] || PAGE_META.hr;
  const Icon = meta.icon;

  return (
    <div className="people-matrix-page-frame" data-people-matrix-page={page}>
      <section className="people-matrix-page-hero">
        <div className="people-matrix-page-hero-glow people-matrix-page-hero-glow-a" />
        <div className="people-matrix-page-hero-glow people-matrix-page-hero-glow-b" />
        <div className="people-matrix-page-hero-content">
          <div className="people-matrix-page-hero-icon"><Icon className="h-5 w-5" /></div>
          <div className="min-w-0">
            <p className="people-matrix-page-eyebrow">{meta.eyebrow}</p>
            <h1>{meta.title}</h1>
            <p>{meta.description}</p>
          </div>
          {action && <div className="people-matrix-page-action">{action}</div>}
        </div>
      </section>
      <div className="people-matrix-page-content">{children}</div>
    </div>
  );
}
