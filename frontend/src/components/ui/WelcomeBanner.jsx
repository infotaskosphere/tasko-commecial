/**
 * WelcomeBanner
 * ─────────────
 * Animated colour-shifting banner used across all pages.
 * Props:
 *   title      – main heading text
 *   subtitle   – smaller line below the heading
 *   icon       – lucide-react icon component for the subtitle row
 *   date       – formatted date string (optional)
 *   actions    – React node rendered on the right side (buttons, stats, etc.)
 *   className  – extra classes for the outer wrapper
 */

import React from 'react';
import { format } from 'date-fns';

export function WelcomeBanner({ title, subtitle, icon: Icon, date, actions, className = '', actionsClassName = '' }) {
  return (
    <div
      className={`banner-animated relative overflow-hidden rounded-2xl px-4 sm:px-6 pt-4 sm:pt-5 pb-4 ${className}`}
      style={{ boxShadow: '0 8px 32px rgba(13,59,102,0.28)' }}
    >
      {/* Decorative blobs */}
      <div
        className="absolute right-0 top-0 w-72 h-72 rounded-full -mr-24 -mt-24 opacity-10"
        style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }}
      />
      <div
        className="absolute right-28 bottom-0 w-40 h-40 rounded-full mb-[-40px] opacity-5"
        style={{ background: 'white' }}
      />
      <div
        className="absolute left-0 bottom-0 w-48 h-48 rounded-full -ml-20 -mb-20 opacity-5"
        style={{ background: 'white' }}
      />

      <div className="relative flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 min-w-0">
        {/* Left — title */}
        <div className="flex-1 min-w-0">
          {(Icon || date) && (
            <p className="text-white/50 text-[10px] font-semibold uppercase tracking-widest mb-1 flex items-center gap-1.5 min-w-0 truncate">
              {Icon && <Icon className="h-3 w-3 flex-shrink-0" />}
              {date || format(new Date(), 'EEEE, MMMM d, yyyy')}
            </p>
          )}
          <h1 className="text-lg sm:text-2xl font-bold text-white tracking-tight leading-tight truncate">
            {title}
          </h1>
          {subtitle && (
            <p className="text-white/60 text-sm mt-0.5 truncate">{subtitle}</p>
          )}
        </div>

        {/* Right — actions slot */}
        {actions && (
          <div className={`flex flex-1 min-w-0 justify-end items-center gap-2 ${actionsClassName}`}>
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

export default WelcomeBanner;
