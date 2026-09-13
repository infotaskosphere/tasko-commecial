// PageKit.jsx — the shared page chrome that makes every screen in the app
// look like the Dashboard / section-hub pages.
//
// Use these three pieces on any page instead of hand-rolled headings:
//
//   <PageShell>
//     <PageBanner icon={Database} eyebrow="Admin" title="Master Data"
//                 subtitle="…" stats={[{label:'Companies', value:3}]} />
//     <StatRow items={[{icon: X, label:'…', value: 1, color:'#1F6FB2'}]} />
//     <SectionCard icon={Building2} title="Company Profiles" badge={3}
//                  description="…" actions={<Button/>}>
//        …content…
//     </SectionCard>
//   </PageShell>
//
// Everything is dark-mode aware and reuses the same palette/gradient as
// DashboardLayout + SectionHub, so pages read as one design system.

import React from 'react';
import { Loader2, Inbox } from 'lucide-react';
import useDark from '@/hooks/useDark';
import { HubBanner, StatCard, HUB_COLORS } from '@/components/SectionHub.jsx';

export { HUB_COLORS };

/** Page wrapper — consistent padding, max width and vertical rhythm. */
export function PageShell({ children, width = 'wide', className = '' }) {
  const max =
    width === 'narrow' ? 'max-w-3xl' : width === 'medium' ? 'max-w-5xl' : 'max-w-7xl';
  return (
    <div className={`p-4 sm:p-6 ${max} mx-auto space-y-5 ${className}`}>{children}</div>
  );
}

/** Big gradient page header — same component the hub pages use. */
export function PageBanner(props) {
  const isDark = useDark();
  return <HubBanner isDark={isDark} {...props} />;
}

/** Row of KPI tiles under the banner. */
export function StatRow({ items = [], columns = 4 }) {
  const isDark = useDark();
  if (!items.length) return null;
  const cols =
    columns === 2 ? 'sm:grid-cols-2'
      : columns === 3 ? 'sm:grid-cols-2 lg:grid-cols-3'
        : 'sm:grid-cols-2 lg:grid-cols-4';
  return (
    <div className={`grid grid-cols-1 ${cols} gap-3`}>
      {items.map((s, i) => (
        <StatCard key={i} isDark={isDark} color={s.color || HUB_COLORS.mediumBlue} {...s} />
      ))}
    </div>
  );
}

/** The standard content card: icon + title + optional badge/description/actions. */
export function SectionCard({
  icon: Icon,
  title,
  description,
  badge,
  actions,
  children,
  color = HUB_COLORS.mediumBlue,
  padded = true,
  className = '',
}) {
  const isDark = useDark();
  return (
    <section
      className={`rounded-2xl border overflow-hidden ${
        isDark ? 'bg-slate-800/60 border-slate-700/80' : 'bg-white border-slate-100 shadow-sm'
      } ${className}`}
    >
      {(title || actions) && (
        <header
          className={`flex flex-wrap items-start justify-between gap-3 px-5 py-4 border-b ${
            isDark ? 'border-slate-700/80' : 'border-slate-100'
          }`}
        >
          <div className="flex items-start gap-3 min-w-0">
            {Icon && (
              <div className="p-2 rounded-xl shrink-0" style={{ background: `${color}18` }}>
                <Icon className="h-5 w-5" style={{ color }} />
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                  {title}
                </h2>
                {badge !== undefined && badge !== null && (
                  <span
                    className="text-[10px] font-extrabold px-2 py-0.5 rounded-full"
                    style={{ background: `${color}18`, color }}
                  >
                    {badge}
                  </span>
                )}
              </div>
              {description && (
                <p className={`text-xs mt-1 leading-relaxed max-w-2xl ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {description}
                </p>
              )}
            </div>
          </div>
          {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

/** Inline guidance / help note — used heavily by Permission Governance. */
export function GuidanceNote({ children, tone = 'info', icon: Icon, className = '' }) {
  const isDark = useDark();
  const tones = {
    info: { c: '#1F6FB2' },
    success: { c: '#1FAF5A' },
    warning: { c: '#F59E0B' },
    danger: { c: '#EF4444' },
  };
  const { c } = tones[tone] || tones.info;
  return (
    <div
      className={`rounded-xl px-3.5 py-2.5 text-xs leading-relaxed flex gap-2 ${className}`}
      style={{ background: `${c}12`, color: isDark ? '#cbd5e1' : '#475569', border: `1px solid ${c}25` }}
    >
      {Icon && <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" style={{ color: c }} />}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Consistent empty state. */
export function EmptyState({ icon: Icon = Inbox, title = 'Nothing here yet', hint, action }) {
  const isDark = useDark();
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6 gap-2">
      <div className={`p-3 rounded-2xl ${isDark ? 'bg-slate-700/50' : 'bg-slate-100'}`}>
        <Icon className={`h-6 w-6 ${isDark ? 'text-slate-400' : 'text-slate-400'}`} />
      </div>
      <p className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{title}</p>
      {hint && <p className={`text-xs max-w-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Consistent loading state. */
export function LoadingState({ label = 'Loading…' }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  );
}

/** Toolbar row (search + filters + actions) above a list. */
export function Toolbar({ children, className = '' }) {
  return <div className={`flex flex-wrap items-center gap-2 ${className}`}>{children}</div>;
}
