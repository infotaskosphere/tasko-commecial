// CompliancePage.jsx — Universal Compliance Tracker v2
// Full-page detail view · Row numbers · Dynamic FY years · Recurring due dates

import { useDark } from '@/hooks/useDark';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { PopupHeader } from '@/components/ui/popup-header';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { toast } from 'sonner';
import { format, parseISO, isPast, differenceInDays } from 'date-fns';
import {
  CheckCircle2, X, Plus, Upload, Search, ChevronDown,
  Users, Trash2, Edit2, Loader2, RefreshCw, ChevronRight,
  FileUp, Zap, Target, Calendar, BookOpen, FolderOpen,
  ArrowLeft, StickyNote, ShieldCheck, AlertTriangle,
  Info, Repeat, LayoutGrid, List, MessageSquare, Send,
  BarChart3, ChevronLeft, TrendingUp, Settings2, Sparkles,
  IndianRupee, Download, FileSpreadsheet, Filter, CalendarClock,
} from 'lucide-react';
import LayoutCustomizer from '@/components/layout/LayoutCustomizer';
import AIFileInsights from '@/components/ui/AIFileInsights.jsx';
import { usePageLayout } from '@/hooks/usePageLayout';
import AIDuplicateDialog from '@/components/ui/AIDuplicateDialog';
import { detectComplianceDuplicates } from '@/lib/aiDuplicateEngine';
import StandaloneGovtFeeDialog from '@/components/StandaloneGovtFeeDialog';
import { getXLSX, getJsPDF, getAutoTable } from '@/lib/lazyLibs';

const D = {
  bg:'#0f172a',card:'#1e293b',raised:'#263348',border:'#334155',
  text:'#f1f5f9',muted:'#94a3b8',dimmer:'#64748b',
};
const CATEGORY_CFG = {
  ROC:    {label:'ROC / MCA',  color:'#1F6FB2',bg:'rgba(31,111,178,0.12)', border:'rgba(31,111,178,0.3)' },
  GST:    {label:'GST',        color:'#F97316',bg:'rgba(249,115,22,0.12)', border:'rgba(249,115,22,0.3)' },
  ITR:    {label:'Income Tax', color:'#1FAF5A',bg:'rgba(31,175,90,0.12)',  border:'rgba(31,175,90,0.3)'  },
  TDS:    {label:'TDS / TCS',  color:'#8B5CF6',bg:'rgba(139,92,246,0.12)',border:'rgba(139,92,246,0.3)' },
  AUDIT:  {label:'Audit',      color:'#F59E0B',bg:'rgba(245,158,11,0.12)',border:'rgba(245,158,11,0.3)' },
  PF_ESIC:{label:'PF / ESIC', color:'#0D9488',bg:'rgba(13,148,136,0.12)',border:'rgba(13,148,136,0.3)' },
  PT:     {label:'Prof. Tax',  color:'#EF4444',bg:'rgba(239,68,68,0.12)', border:'rgba(239,68,68,0.3)'  },
  OTHER:  {label:'Other',      color:'#64748b',bg:'rgba(100,116,139,0.12)',border:'rgba(100,116,139,0.3)'},
};
const STATUS_CFG = {
  not_started:{label:'Not Started',color:'#64748b',bg:'rgba(100,116,139,0.12)',border:'rgba(100,116,139,0.25)',dot:'#94a3b8'},
  in_progress:{label:'In Progress',color:'#3B82F6',bg:'rgba(59,130,246,0.12)', border:'rgba(59,130,246,0.25)', dot:'#60a5fa'},
  completed:  {label:'Completed',  color:'#1FAF5A',bg:'rgba(31,175,90,0.12)',  border:'rgba(31,175,90,0.25)',  dot:'#4ade80'},
  filed:      {label:'Filed',      color:'#8B5CF6',bg:'rgba(139,92,246,0.12)', border:'rgba(139,92,246,0.25)', dot:'#a78bfa'},
  na:         {label:'N/A',        color:'#94a3b8',bg:'rgba(148,163,184,0.08)',border:'rgba(148,163,184,0.2)', dot:'#cbd5e1'},
};
const STATUSES   = ['not_started','in_progress','completed','filed','na'];
const CATEGORIES = ['ROC','GST','ITR','TDS','AUDIT','PF_ESIC','PT','OTHER'];
const FREQUENCIES = [
  {value:'monthly',    label:'Monthly'    },
  {value:'quarterly',  label:'Quarterly'  },
  {value:'half_yearly',label:'Half-Yearly'},
  {value:'annual',     label:'Annual'     },
  {value:'one_time',   label:'One-Time'   },
];

// Dynamic FY years 2010-11 to 2035-36, newest first
const FY_OPTIONS = Array.from({length:26},(_,i)=>{const y=2010+i; return `${y}-${String(y+1).slice(2)}`;}).reverse();

const RECURRING_DAYS = [
  ...Array.from({length:31},(_,i)=>({value:String(i+1),label:String(i+1)})),
  {value:'last',label:'Last day'},
];
const QUARTER_MONTHS = [
  {value:'1',label:'1st month of quarter'},{value:'2',label:'2nd month of quarter'},
  {value:'3',label:'3rd month of quarter'},{value:'4',label:'Month after quarter end'},
];

const containerVariants = {hidden:{opacity:0},visible:{opacity:1,transition:{staggerChildren:0.05}}};
const itemVariants = {hidden:{opacity:0,y:16},visible:{opacity:1,y:0,transition:{duration:0.35,ease:[0.23,1,0.32,1]}}};
const pageVariants = {
  hidden:{opacity:0,x:40},
  visible:{opacity:1,x:0,transition:{duration:0.32,ease:[0.23,1,0.32,1]}},
  exit:{opacity:0,x:-30,transition:{duration:0.22,ease:'easeIn'}},
};

const safeDate = s=>{try{const d=parseISO(s);return isNaN(d)?null:d;}catch{return null;}};
const fmtDate  = (s,f='dd MMM yyyy')=>{const d=safeDate(s);return d?format(d,f):'—';};

// ── GovtFeeRow: isolated component so a single bad record never blanks the table ──
function GovtFeeRow({ fee, idx, govtFeesSubTab, isDark, canManage, onEdit, onDelete }) {
  try {
    const colsAll    = 'minmax(180px,1.6fr) minmax(140px,1.3fr) 96px 70px 110px 96px minmax(130px,1fr) 80px 92px';
    const colsDirect = 'minmax(200px,1.8fr) minmax(160px,1.4fr) 96px 70px 110px 96px minmax(150px,1.1fr) 92px';
    const gridCols   = govtFeesSubTab === 'all' ? colsAll : colsDirect;
    const isLinked   = fee._source === 'linked';

    const dueDateStr     = fee.due_date ? fmtDate(String(fee.due_date).slice(0, 10)) : '—';
    const paymentDateStr = (() => {
      const pd = fee.payment_date || fee.paid_on || fee.paid_at;
      if (!pd) return null;
      const s = fmtDate(String(pd).slice(0, 10));
      return s !== '—' ? s : null;
    })();

    const catCfg = CATEGORY_CFG[fee.category] || CATEGORY_CFG.OTHER;
    const statusLower = String(fee.status || '').toLowerCase();
    const isPaid = statusLower === 'paid';
    const isCompletedOrFiled = statusLower === 'completed' || statusLower === 'filed';

    return (
      <div key={fee.id || `fee-row-${idx}`}
        className="group grid items-center gap-2 px-4 py-3.5 border-b text-sm transition-colors hover:bg-blue-500/[0.04]"
        style={{ gridTemplateColumns: gridCols, borderColor: isDark ? D.border : '#f1f5f9', color: isDark ? D.text : '#1e293b' }}>

        {/* Title */}
        <div className="min-w-0">
          <p className="font-semibold truncate" title={fee.title || ''}>{fee.title || '—'}</p>
          {fee.period_label ? <p className="text-[11px] truncate" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>{fee.period_label}</p> : null}
        </div>

        {/* Client */}
        <div className="text-xs truncate" title={fee.client_name || ''}>{fee.client_name || '—'}</div>

        {/* Category */}
        <div>
          <span className="px-2 py-0.5 rounded-md text-[10px] font-bold whitespace-nowrap"
            style={{ backgroundColor: catCfg.bg, color: catCfg.color }}>
            {catCfg.label}
          </span>
        </div>

        {/* FY */}
        <div className="text-xs">{fee.fy_year || '—'}</div>

        {/* Due Date */}
        <div className="text-xs whitespace-nowrap">{dueDateStr}</div>

        {/* Status */}
        <div>
          {isLinked ? (
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${isCompletedOrFiled ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-blue-50 text-blue-700 border-blue-200'}`}>
              {STATUS_CFG[fee.status]?.label || fee.status || 'In Progress'}
            </span>
          ) : (
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${isPaid ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
              {isPaid ? 'Paid' : 'Unpaid'}
            </span>
          )}
          {paymentDateStr && <p className="text-[10px] mt-1" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>{paymentDateStr}</p>}
        </div>

        {/* Amount / SRN */}
        <div className="min-w-0">
          <p className="font-bold whitespace-nowrap">&#8377; {Number(fee.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
          <p className="text-[11px] font-mono truncate" title={fee.srn || ''} style={{ color: isDark ? D.dimmer : '#94a3b8' }}>{fee.srn || '—'}</p>
        </div>

        {/* Type badge (All Payments tab only) */}
        {govtFeesSubTab === 'all' && (
          <div>
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border whitespace-nowrap ${isLinked ? 'bg-purple-50 text-purple-700 border-purple-200' : 'bg-sky-50 text-sky-700 border-sky-200'}`}>
              {isLinked ? 'Compliance' : 'Direct'}
            </span>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
          <button onClick={() => onEdit(fee)}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg hover:bg-blue-500/10 hover:text-blue-600 transition-colors"
            title={isLinked ? 'Edit linked compliance payment' : 'Edit fee'}
            style={{ color: isDark ? D.muted : '#64748b' }}>
            <Edit2 className="w-3.5 h-3.5" />
          </button>
          {!isLinked && canManage && (
            <button onClick={() => onDelete(fee)}
              className="inline-flex items-center justify-center w-8 h-8 rounded-lg hover:bg-red-500/10 text-red-500 hover:text-red-600 transition-colors"
              title="Delete fee">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    );
  } catch (err) {
    console.warn('GovtFeeRow render error for fee:', fee?.id, err);
    return null;
  }
}
const timeAgo  = s=>{
  if(!s)return'—'; const d=new Date(s); if(isNaN(d))return'—';
  const diff=Math.floor((Date.now()-d)/1000);
  if(diff<60)return'just now'; if(diff<3600)return`${Math.floor(diff/60)}m ago`;
  if(diff<86400)return`${Math.floor(diff/3600)}h ago`; return`${Math.floor(diff/86400)}d ago`;
};

function StatusPill({status,onClick,size='sm'}){
  const cfg=STATUS_CFG[status]||STATUS_CFG.not_started;
  return(
    <button onClick={onClick}
      className={`inline-flex items-center gap-1.5 font-semibold rounded-full border transition-all ${onClick?'hover:opacity-80 active:scale-95 cursor-pointer':'cursor-default'} ${size==='xs'?'text-[10px] px-2 py-0.5':'text-xs px-2.5 py-1'}`}
      style={{color:cfg.color,backgroundColor:cfg.bg,borderColor:cfg.border}}>
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{backgroundColor:cfg.dot}}/>
      {cfg.label}
      {onClick&&<ChevronDown className="w-2.5 h-2.5 opacity-50"/>}
    </button>
  );
}

function StatusDropdown({current,onSelect,isDark}){
  return(
    <div className="rounded-xl overflow-hidden shadow-2xl border z-50 min-w-[160px]"
      style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0'}}>
      {STATUSES.map(s=>{
        const cfg=STATUS_CFG[s];
        return(
          <button key={s} onClick={()=>onSelect(s)}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium hover:opacity-80 text-left"
            style={{backgroundColor:s===current?(isDark?'rgba(255,255,255,0.06)':'#f1f5f9'):'transparent',color:cfg.color}}>
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{backgroundColor:cfg.dot}}/>
            {cfg.label}
            {s===current&&<CheckCircle2 className="w-3 h-3 ml-auto opacity-60"/>}
          </button>
        );
      })}
    </div>
  );
}

function ProgressBar({pct,color='#1FAF5A',height='h-1.5',isDark}){
  return(
    <div className={`${height} rounded-full overflow-hidden`} style={{backgroundColor:isDark?'rgba(255,255,255,0.08)':'#f1f5f9'}}>
      <motion.div className="h-full rounded-full"
        style={{background:`linear-gradient(90deg,${color},${color}bb)`}}
        initial={{width:0}} animate={{width:`${Math.min(100,pct||0)}%`}}
        transition={{duration:0.9,ease:'easeOut'}}/>
    </div>
  );
}

// ── Shared pagination control ─────────────────────────────────────────────
function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange, isDark, label='records' }) {
  const totalPages = Math.max(1, Math.ceil((total || 0) / pageSize));
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = total ? Math.min(page * pageSize, total) : 0;
  const go = (next) => onPageChange(Math.min(totalPages, Math.max(1, next)));

  if (!total) return null;

  const pages = [];
  const push = (n) => { if (!pages.includes(n)) pages.push(n); };
  push(1);
  if (page > 3) pages.push('ellipsis-left');
  for (let n = Math.max(2, page - 1); n <= Math.min(totalPages - 1, page + 1); n += 1) push(n);
  if (page < totalPages - 2) pages.push('ellipsis-right');
  if (totalPages > 1) push(totalPages);

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 border-t flex-wrap"
      style={{borderColor:isDark?D.border:'#e2e8f0',backgroundColor:isDark?D.raised:'#f8fafc'}}>
      <div className="flex items-center gap-2 text-xs font-semibold" style={{color:isDark?D.dimmer:'#64748b'}}>
        <span>Showing {start}–{end} of {total} {label}</span>
        <span className="hidden sm:inline">·</span>
        <label className="flex items-center gap-1.5">
          <span>Rows</span>
          <select value={pageSize} onChange={e=>onPageSizeChange(Number(e.target.value))}
            className="h-8 px-2 border rounded-lg text-xs font-bold focus:outline-none focus:ring-2 focus:ring-blue-500"
            style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#d1d5db',color:isDark?D.text:'#1e293b'}}>
            {[25,50,100].map(size=><option key={size} value={size}>{size}</option>)}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-1">
        <button onClick={()=>go(page-1)} disabled={page<=1}
          className="w-8 h-8 rounded-lg border flex items-center justify-center transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:bg-blue-500/10"
          style={{borderColor:isDark?D.border:'#e2e8f0',color:isDark?D.muted:'#64748b',backgroundColor:isDark?D.card:'#fff'}}
          aria-label="Previous page"><ChevronLeft className="w-3.5 h-3.5"/></button>
        {pages.map((item, idx)=> item === 'ellipsis-left' || item === 'ellipsis-right' ? (
          <span key={`${item}-${idx}`} className="w-8 h-8 flex items-center justify-center text-xs" style={{color:isDark?D.dimmer:'#94a3b8'}}>…</span>
        ) : (
          <button key={item} onClick={()=>go(item)}
            className="w-8 h-8 rounded-lg border text-xs font-bold transition-all"
            style={{backgroundColor:page===item?'#1F6FB2':(isDark?D.card:'#fff'),borderColor:page===item?'#1F6FB2':(isDark?D.border:'#e2e8f0'),color:page===item?'#fff':(isDark?D.muted:'#64748b')}}>
            {item}
          </button>
        ))}
        <button onClick={()=>go(page+1)} disabled={page>=totalPages}
          className="w-8 h-8 rounded-lg border flex items-center justify-center transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:bg-blue-500/10"
          style={{borderColor:isDark?D.border:'#e2e8f0',color:isDark?D.muted:'#64748b',backgroundColor:isDark?D.card:'#fff'}}
          aria-label="Next page"><ChevronRight className="w-3.5 h-3.5"/></button>
      </div>
    </div>
  );
}

// ── Inline Calendar Picker ─────────────────────────────────────────────────
function CalendarPicker({value,onChange,isDark,onClose}){
  const today=new Date();
  const initDate=value?new Date(value):today;
  const[viewYear,setViewYear]=useState(initDate.getFullYear());
  const[viewMonth,setViewMonth]=useState(initDate.getMonth()); // 0-indexed
  const MONTH_NAMES=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DAY_NAMES=['Su','Mo','Tu','We','Th','Fr','Sa'];
  const firstDay=new Date(viewYear,viewMonth,1).getDay();
  const daysInMonth=new Date(viewYear,viewMonth+1,0).getDate();
  const selectedDay=value?new Date(value):null;
  const isSelected=(d)=>selectedDay&&selectedDay.getFullYear()===viewYear&&selectedDay.getMonth()===viewMonth&&selectedDay.getDate()===d;
  const isToday=(d)=>today.getFullYear()===viewYear&&today.getMonth()===viewMonth&&today.getDate()===d;
  const prevMonth=()=>{if(viewMonth===0){setViewMonth(11);setViewYear(y=>y-1);}else setViewMonth(m=>m-1);};
  const nextMonth=()=>{if(viewMonth===11){setViewMonth(0);setViewYear(y=>y+1);}else setViewMonth(m=>m+1);};
  const selectDay=(d)=>{
    const mm=String(viewMonth+1).padStart(2,'0');
    const dd=String(d).padStart(2,'0');
    onChange(`${viewYear}-${mm}-${dd}`);
    onClose&&onClose();
  };
  const cells=[];
  for(let i=0;i<firstDay;i++)cells.push(null);
  for(let d=1;d<=daysInMonth;d++)cells.push(d);
  while(cells.length%7!==0)cells.push(null);
  return(
    <div className="rounded-2xl border shadow-2xl overflow-hidden"
      style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0',width:280}}>
      {/* Month/Year nav */}
      <div className="flex items-center justify-between px-4 py-3 border-b"
        style={{borderColor:isDark?D.border:'#f1f5f9',backgroundColor:isDark?D.raised:'#f8fafc'}}>
        <button onClick={prevMonth} className="w-7 h-7 rounded-lg flex items-center justify-center hover:opacity-70 transition-opacity"
          style={{color:isDark?D.muted:'#64748b',backgroundColor:isDark?'rgba(255,255,255,0.06)':'#fff',border:`1px solid ${isDark?D.border:'#e2e8f0'}`}}>
          <ChevronLeft className="w-3.5 h-3.5"/>
        </button>
        <div className="text-center">
          <p className="text-sm font-black" style={{color:isDark?D.text:'#0f172a'}}>{MONTH_NAMES[viewMonth]}</p>
          <div className="flex items-center gap-1 justify-center mt-0.5">
            <button onClick={()=>setViewYear(y=>y-1)} className="text-[10px] font-bold hover:opacity-70" style={{color:isDark?D.dimmer:'#94a3b8'}}>◀</button>
            <span className="text-xs font-bold" style={{color:isDark?D.muted:'#64748b'}}>{viewYear}</span>
            <button onClick={()=>setViewYear(y=>y+1)} className="text-[10px] font-bold hover:opacity-70" style={{color:isDark?D.dimmer:'#94a3b8'}}>▶</button>
          </div>
        </div>
        <button onClick={nextMonth} className="w-7 h-7 rounded-lg flex items-center justify-center hover:opacity-70 transition-opacity"
          style={{color:isDark?D.muted:'#64748b',backgroundColor:isDark?'rgba(255,255,255,0.06)':'#fff',border:`1px solid ${isDark?D.border:'#e2e8f0'}`}}>
          <ChevronRight className="w-3.5 h-3.5"/>
        </button>
      </div>
      {/* Day headers */}
      <div className="grid grid-cols-7 px-2 pt-2">
        {DAY_NAMES.map(d=>(
          <div key={d} className="text-center text-[10px] font-black py-1" style={{color:isDark?D.dimmer:'#94a3b8'}}>{d}</div>
        ))}
      </div>
      {/* Day cells */}
      <div className="grid grid-cols-7 px-2 pb-3 gap-y-0.5">
        {cells.map((d,i)=>(
          <div key={i} className="flex items-center justify-center py-0.5">
            {d?(
              <button onClick={()=>selectDay(d)}
                className="w-8 h-8 rounded-full text-xs font-semibold transition-all hover:scale-110 active:scale-95"
                style={{
                  backgroundColor:isSelected(d)?'#1F6FB2':isToday(d)?(isDark?'rgba(31,111,178,0.2)':'#dbeafe'):'transparent',
                  color:isSelected(d)?'#fff':isToday(d)?'#1F6FB2':(isDark?D.text:'#0f172a'),
                  fontWeight:isToday(d)||isSelected(d)?'800':'600',
                  boxShadow:isSelected(d)?'0 2px 8px rgba(31,111,178,0.4)':'none',
                }}>
                {d}
              </button>
            ):null}
          </div>
        ))}
      </div>
      {/* Today shortcut */}
      <div className="border-t px-3 py-2 flex items-center justify-between"
        style={{borderColor:isDark?D.border:'#f1f5f9',backgroundColor:isDark?D.raised:'#f8fafc'}}>
        <button onClick={()=>{const t=new Date();selectDay(t.getDate());setViewMonth(t.getMonth());setViewYear(t.getFullYear());}}
          className="text-[11px] font-bold text-blue-500 hover:text-blue-400 transition-colors">Today</button>
        {value&&<button onClick={()=>{onChange('');onClose&&onClose();}}
          className="text-[11px] font-bold hover:opacity-70 transition-opacity" style={{color:isDark?D.dimmer:'#94a3b8'}}>Clear</button>}
      </div>
    </div>
  );
}


// ── Add/Edit Compliance Modal ──────────────────────────────────────────────
// Smart due-date logic: selecting a period (month / quarter / half) auto-
// computes and previews the exact filing dates so nothing is ever forgotten.

// Quarter → [first month index (0-based), last month index, filing month index]
const QUARTER_MAP = {
  Q1:{ label:'Q1', sub:'Apr – Jun',  months:[3,4,5],  filingMonth:6,  filingLabel:'July'   },
  Q2:{ label:'Q2', sub:'Jul – Sep',  months:[6,7,8],  filingMonth:9,  filingLabel:'October'},
  Q3:{ label:'Q3', sub:'Oct – Dec',  months:[9,10,11], filingMonth:0, filingLabel:'January',filingYearOffset:1},
  Q4:{ label:'Q4', sub:'Jan – Mar',  months:[0,1,2],  filingMonth:3,  filingLabel:'April'  },
};
const HALF_MAP = {
  H1:{ label:'H1 — First Half',  sub:'Apr – Sep', filingMonth:9,  filingLabel:'Oct 31',  defaultDay:'31' },
  H2:{ label:'H2 — Second Half', sub:'Oct – Mar', filingMonth:3,  filingLabel:'Apr 30',  defaultDay:'30', filingYearOffset:1 },
};
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_PILLS = Array.from({length:12},(_,i)=>({key:String(i+1).padStart(2,'0'),label:MONTH_NAMES[i],monthIdx:i}));

// Smart default recurring day per frequency/category
function defaultDayFor(frequency, category){
  if(frequency==='monthly'){
    if(category==='GST')   return '20'; // GSTR-3B
    if(category==='TDS')   return '7';
    if(category==='PF_ESIC') return '15';
    if(category==='PT')    return '15';
    return '20';
  }
  if(frequency==='quarterly') return '13';
  if(frequency==='half_yearly') return '30';
  return '1';
}

// Compute preview dates for the current selection
function computeDueDates(frequency, applicablePeriods, recurDay, recurMonth, fyYear, filingOffset=1){
  const day = recurDay === 'last' ? null : parseInt(recurDay, 10);
  const results = [];

  if(frequency === 'monthly'){
    const yr = fyYear ? parseInt(fyYear.split('-')[0], 10) : new Date().getFullYear();
    applicablePeriods.forEach(key => {
      const mIdx = parseInt(key, 10) - 1; // 0-based applicable month
      // filing month = applicable month + offset
      const filingMIdx = (mIdx + parseInt(filingOffset, 10)) % 12;
      const filingYearBump = (mIdx + parseInt(filingOffset, 10)) >= 12 ? 1 : 0;
      const baseYear = (mIdx < 3) ? yr + 1 : yr; // Indian FY
      const filingYear = baseYear + filingYearBump;
      const daysInMonth = new Date(filingYear, filingMIdx + 1, 0).getDate();
      const d = day ? Math.min(day, daysInMonth) : daysInMonth;
      const dt = new Date(filingYear, filingMIdx, d);
      const offsetLabel = parseInt(filingOffset)===0?'same month':parseInt(filingOffset)===1?'next month':'2 months after';
      results.push({
        label: `${MONTH_NAMES[mIdx]} return`,
        filing: `${MONTH_NAMES[filingMIdx]} ${filingYear}`,
        date: dt.toISOString().slice(0,10),
      });
    });
    results.sort((a,b)=>a.date.localeCompare(b.date));
  }

  if(frequency === 'quarterly'){
    const yr = fyYear ? parseInt(fyYear.split('-')[0], 10) : new Date().getFullYear();
    const qMonth = parseInt(recurMonth, 10); // 1=first, 2=second, 3=third, 4=after quarter
    applicablePeriods.forEach(key => {
      const q = QUARTER_MAP[key]; if(!q) return;
      let mIdx;
      if(qMonth === 4)      mIdx = q.filingMonth;
      else                   mIdx = q.months[qMonth - 1];
      const yOffset = (q.filingYearOffset && qMonth >= 3) ? 1 : 0;
      const year = (mIdx < 3 && (key === 'Q3' || key === 'Q4')) ? yr + 1 : yr + yOffset;
      const daysInMonth = new Date(year, mIdx + 1, 0).getDate();
      const d = day ? Math.min(day, daysInMonth) : daysInMonth;
      const dt = new Date(year, mIdx, d);
      results.push({ label: key, date: dt.toISOString().slice(0,10) });
    });
  }

  if(frequency === 'half_yearly'){
    const yr = fyYear ? parseInt(fyYear.split('-')[0], 10) : new Date().getFullYear();
    applicablePeriods.forEach(key => {
      const h = HALF_MAP[key]; if(!h) return;
      const mIdx = h.filingMonth;
      const year = h.filingYearOffset ? yr + 1 : yr;
      const d2 = parseInt(h.defaultDay, 10);
      const dt = new Date(year, mIdx, d2);
      results.push({ label: `${key} — Due ${h.filingLabel} ${year}`, date: dt.toISOString().slice(0,10) });
    });
  }

  return results;
}

function ComplianceFormModal({existing,onClose,onSave,isDark}){
  const[name,setName]=useState(existing?.name||'');
  const[category,setCategory]=useState(existing?.category||'ROC');
  const[frequency,setFrequency]=useState(existing?.frequency||'annual');
  const[fyYear,setFyYear]=useState(existing?.fy_year||'2025-26');
  const[period,setPeriod]=useState(existing?.period_label||'');
  const[dueType,setDueType]=useState(existing?.recurring_due?'recurring':'specific');
  const[dueDate,setDueDate]=useState(existing?.due_date||'');
  const[recurDay,setRecurDay]=useState(existing?.recurring_day||'20');
  const[recurMonth,setRecurMonth]=useState(existing?.recurring_quarter_month||'4');
  const[filingOffset,setFilingOffset]=useState(existing?.filing_offset??'1');
  const[desc,setDesc]=useState(existing?.description||'');
  const[govtFees,setGovtFees]=useState(!!existing?.govt_fees);
  const[saving,setSaving]=useState(false);
  const[templates,setTemplates]=useState([]);
  const nativeDateInputRef=useRef(null);
  const[applicablePeriods,setApplicablePeriods]=useState(()=>existing?.applicable_periods||[]);

  const isRecurring=['monthly','quarterly','half_yearly'].includes(frequency);

  // When frequency changes, reset periods and set smart defaults
  useEffect(()=>{
    setApplicablePeriods([]);
    setRecurDay(defaultDayFor(frequency, category));
    if(isRecurring) setDueType('recurring'); else setDueType('specific');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[frequency]);

  // When category changes while monthly, update smart default day
  useEffect(()=>{
    if(frequency==='monthly') setRecurDay(defaultDayFor(frequency, category));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[category]);

  useEffect(()=>{
    api.get('/compliance/common-templates').then(r=>setTemplates(r.data||[])).catch(()=>{});
  },[]);

  // Auto-generate period label from selections
  useEffect(()=>{
    if(applicablePeriods.length===0){setPeriod('');return;}
    if(frequency==='monthly'){
      const names=applicablePeriods.map(k=>MONTH_NAMES[parseInt(k,10)-1]);
      setPeriod(names.join(', ')+(fyYear?` FY${fyYear.slice(2)}`:''));
    } else if(frequency==='quarterly'){
      setPeriod(applicablePeriods.join(', ')+(fyYear?` FY${fyYear.slice(2)}`:''));
    } else if(frequency==='half_yearly'){
      setPeriod(applicablePeriods.join(' & ')+(fyYear?` FY${fyYear.slice(2)}`:''));
    }
  },[applicablePeriods, frequency, fyYear]);

  const inputStyle={backgroundColor:isDark?D.raised:'#fff',borderColor:isDark?D.border:'#d1d5db',color:isDark?D.text:'#1e293b'};
  const inputCls='w-full px-3.5 py-2.5 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all';

  const previewDates = useMemo(()=>
    computeDueDates(frequency, applicablePeriods, recurDay, recurMonth, fyYear, filingOffset),
    [frequency, applicablePeriods, recurDay, recurMonth, fyYear, filingOffset]
  );

  const recurringLabel=()=>{
    const day=recurDay==='last'?'Last day':`${recurDay}`;
    if(frequency==='monthly') return `Due on day ${day} of every selected month`;
    if(frequency==='quarterly'){
      const mo=QUARTER_MONTHS.find(m=>m.value===recurMonth)?.label||'';
      return `Due on day ${day} · ${mo}`;
    }
    if(frequency==='half_yearly') return `Auto-computed from half selection`;
    return '';
  };

  const fmtDisplayDate=(d)=>{
    if(!d) return 'Select due date…';
    try{const dt=new Date(d);return dt.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'});}
    catch{return d;}
  };

  const openNativeDatePicker=()=>{
    const input=nativeDateInputRef.current;
    if(!input) return;
    try{
      if(typeof input.showPicker==='function') input.showPicker();
      else { input.focus(); input.click(); }
    }catch{
      input.focus();
      input.click();
    }
  };

  const togglePeriod=(key)=>{
    setApplicablePeriods(prev=>prev.includes(key)?prev.filter(k=>k!==key):[...prev,key]);
  };

  const QUARTER_PILLS=Object.entries(QUARTER_MAP).map(([k,v])=>({key:k,...v}));
  const HALF_PILLS=Object.entries(HALF_MAP).map(([k,v])=>({key:k,...v}));

  const handleSave=async()=>{
    if(!name.trim()){toast.error('Name is required');return;}
    // For monthly: if periods selected and recurring, use first computed date as due_date
    const firstComputed = previewDates.length > 0 ? previewDates[0].date : undefined;
    setSaving(true);
    try{
      const payload={
        name:name.trim(),category,frequency,
        fy_year:fyYear||undefined,
        period_label:period||undefined,
        description:desc||undefined,
        govt_fees:!!govtFees,
        applicable_periods:applicablePeriods.length>0?applicablePeriods:undefined,
        ...(dueType==='specific'&&dueDate?{due_date:dueDate}:{}),
        ...(dueType==='recurring'?{
          recurring_due:true,
          recurring_day:recurDay,
          filing_offset:frequency==='monthly'?parseInt(filingOffset,10):undefined,
          recurring_quarter_month:frequency==='quarterly'?recurMonth:undefined,
          period_label:period||recurringLabel(),
          // Store first computed date as the canonical next due_date
          ...(firstComputed&&!dueDate?{due_date:firstComputed}:{}),
        }:{}),
      };
      if(existing?.id){await api.patch(`/compliance/${existing.id}`,payload);toast.success('Updated');}
      else{await api.post('/compliance',payload);toast.success('Created');}
      onSave();
    }catch(err){toast.error(err?.response?.data?.detail||'Save failed');}
    finally{setSaving(false);}
  };

  const pillBase='py-2 rounded-xl text-xs font-bold border transition-all hover:opacity-90 active:scale-95 cursor-pointer select-none';
  const pillOn={backgroundColor:'#1F6FB2',borderColor:'#1F6FB2',color:'#fff',boxShadow:'0 2px 8px rgba(31,111,178,0.4)'};
  const pillOff={backgroundColor:isDark?D.raised:'#f8fafc',borderColor:isDark?D.border:'#e2e8f0',color:isDark?D.muted:'#374151'};

  return(
    <motion.div className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{background:'rgba(6,78,59,0.75)',backdropFilter:'blur(8px)'}}
      initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onClick={onClose}>
      <motion.div className="w-full max-w-3xl rounded-3xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col"
        style={{backgroundColor:isDark?D.card:'#fff',border:isDark?`1px solid ${D.border}`:'1px solid #e2e8f0'}}
        initial={{scale:0.92,y:24}} animate={{scale:1,y:0}} exit={{scale:0.92,y:24}}
        transition={{type:'spring',stiffness:220,damping:22}} onClick={e=>e.stopPropagation()}>

        {/* Header */}
        <div className="px-6 py-5 flex items-center justify-between text-white flex-shrink-0"
          style={{background:'linear-gradient(135deg,#0D3B66,#1F6FB2)'}}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
              <BookOpen className="w-5 h-5 text-white"/>
            </div>
            <div>
              <h2 className="text-lg font-black">{existing?'Edit Compliance':'New Compliance'}</h2>
              <p className="text-blue-200 text-xs">Define compliance type and filing schedule</p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-xl bg-white/20 hover:bg-white/30 flex items-center justify-center">
            <X className="w-4 h-4 text-white"/>
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-6 space-y-5" style={{scrollbarWidth:'thin'}}>

          {/* Quick Templates */}
          {!existing&&templates.length>0&&(
            <div>
              <p className="text-xs font-bold uppercase tracking-wider mb-2" style={{color:isDark?D.muted:'#64748b'}}>Quick Templates</p>
              <div className="flex flex-wrap gap-1.5">
                {templates.slice(0,14).map(t=>(
                  <button key={t.name}
                    onClick={()=>{setName(t.name);setCategory(t.category);setFrequency(t.frequency);}}
                    className="text-[11px] px-2 py-1 rounded-lg border font-semibold transition-all hover:opacity-80 active:scale-95"
                    style={{backgroundColor:CATEGORY_CFG[t.category]?.bg,borderColor:CATEGORY_CFG[t.category]?.border,color:CATEGORY_CFG[t.category]?.color}}>
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Name */}
          <div>
            <label className="text-sm font-semibold mb-1.5 block" style={{color:isDark?D.muted:'#374151'}}>Compliance Name *</label>
            <input value={name} onChange={e=>setName(e.target.value)}
              placeholder="e.g. GSTR-3B, AOC-4 Filing, MSME Form 1"
              className={inputCls} style={inputStyle}/>
          </div>

          {/* Category + Frequency + FY Year + Period in 2x2 grid */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-semibold mb-1.5 block" style={{color:isDark?D.muted:'#374151'}}>Category</label>
              <select value={category} onChange={e=>setCategory(e.target.value)} className={inputCls} style={inputStyle}>
                {CATEGORIES.map(c=><option key={c} value={c}>{CATEGORY_CFG[c]?.label||c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm font-semibold mb-1.5 block" style={{color:isDark?D.muted:'#374151'}}>Frequency</label>
              <select value={frequency} onChange={e=>setFrequency(e.target.value)} className={inputCls} style={inputStyle}>
                {FREQUENCIES.map(f=><option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm font-semibold mb-1.5 block" style={{color:isDark?D.muted:'#374151'}}>FY Year</label>
              <select value={fyYear} onChange={e=>setFyYear(e.target.value)} className={inputCls} style={inputStyle}>
                <option value="">— Select —</option>
                {FY_OPTIONS.map(y=><option key={y} value={y}>FY {y}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm font-semibold mb-1.5 block" style={{color:isDark?D.muted:'#374151'}}>Period Label</label>
              <input value={period} onChange={e=>setPeriod(e.target.value)}
                placeholder="Auto-filled from selection"
                className={inputCls} style={inputStyle}/>
            </div>
          </div>

          {/* Government Fees toggle */}
          <div className="rounded-2xl border p-4 flex items-center justify-between gap-4"
            style={{borderColor:isDark?D.border:'#e2e8f0',backgroundColor:isDark?D.raised:'#fafbff'}}>
            <div>
              <p className="text-sm font-bold" style={{color:isDark?D.text:'#1e293b'}}>Government Fees</p>
              <p className="text-[11px] mt-0.5" style={{color:isDark?D.muted:'#64748b'}}>
                Show this compliance under each client's "Govt Fees" tab so you can record the fee paid.
              </p>
            </div>
            <div className="flex items-center gap-1 rounded-lg overflow-hidden border text-xs font-bold"
              style={{borderColor:isDark?D.border:'#e2e8f0'}}>
              {[['no','No',false],['yes','Yes',true]].map(([k,l,v])=>(
                <button key={k} type="button" onClick={()=>setGovtFees(v)}
                  className="px-3.5 py-1.5 transition-all"
                  style={{backgroundColor:govtFees===v?'#1F6FB2':'transparent',
                          color:govtFees===v?'#fff':isDark?D.dimmer:'#64748b'}}>{l}</button>
              ))}
            </div>
          </div>

          {/* ── SCHEDULE SECTION ─────────────────────────────────────────── */}
          <div className="rounded-2xl border overflow-hidden" style={{borderColor:isDark?D.border:'#e2e8f0'}}>
            <div className="px-4 py-3 flex items-center justify-between"
              style={{backgroundColor:isDark?D.raised:'#f0f7ff',borderBottom:`1px solid ${isDark?D.border:'#dbeafe'}`}}>
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-blue-500"/>
                <span className="text-sm font-black" style={{color:isDark?D.text:'#1e293b'}}>Filing Schedule</span>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-600">
                  {frequency==='monthly'?'Monthly'
                  :frequency==='quarterly'?'Quarterly'
                  :frequency==='half_yearly'?'Half-Yearly'
                  :frequency==='annual'?'Annual':'One-Time'}
                </span>
              </div>
              {isRecurring&&(
                <div className="flex items-center gap-1 rounded-lg overflow-hidden border text-xs font-semibold"
                  style={{borderColor:isDark?D.border:'#e2e8f0'}}>
                  {[['specific','One-time'],['recurring','Recurring']].map(([v,l])=>(
                    <button key={v} onClick={()=>setDueType(v)} className="px-2.5 py-1 transition-all"
                      style={{backgroundColor:dueType===v?'#1F6FB2':'transparent',
                              color:dueType===v?'#fff':isDark?D.dimmer:'#64748b'}}>{l}</button>
                  ))}
                </div>
              )}
            </div>

            <div className="p-4 space-y-4">

              {/* ── MONTHLY ── */}
              {frequency==='monthly'&&dueType==='recurring'&&(
                <>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider mb-2.5" style={{color:isDark?D.muted:'#64748b'}}>
                      Applicable Months <span className="normal-case font-normal">(tap to select · blank = all months)</span>
                    </p>
                    <div className="grid grid-cols-4 gap-2">
                      {MONTH_PILLS.map(m=>{
                        const sel=applicablePeriods.includes(m.key);
                        return(
                          <button key={m.key} onClick={()=>togglePeriod(m.key)}
                            className={pillBase} style={sel?pillOn:pillOff}>{m.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex items-center gap-2">
                      <Repeat className="w-3.5 h-3.5 text-blue-500"/>
                      <span className="text-xs font-semibold" style={{color:isDark?D.muted:'#374151'}}>File in</span>
                    </div>
                    <select value={filingOffset} onChange={e=>setFilingOffset(e.target.value)}
                      className="px-3 py-1.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" style={inputStyle}>
                      <option value="0">Same month (e.g. advance tax)</option>
                      <option value="1">Next month (e.g. GST, TDS, PF)</option>
                      <option value="2">2 months after (e.g. TCS annual)</option>
                    </select>
                    <span className="text-xs font-semibold" style={{color:isDark?D.muted:'#374151'}}>· due on day</span>
                    <select value={recurDay} onChange={e=>setRecurDay(e.target.value)}
                      className="px-3 py-1.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" style={inputStyle}>
                      {RECURRING_DAYS.map(d=><option key={d.value} value={d.value}>{d.label}</option>)}
                    </select>
                  </div>
                </>
              )}

              {/* ── QUARTERLY ── */}
              {frequency==='quarterly'&&dueType==='recurring'&&(
                <>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider mb-2.5" style={{color:isDark?D.muted:'#64748b'}}>
                      Applicable Quarters <span className="normal-case font-normal">(tap to select · blank = all quarters)</span>
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      {QUARTER_PILLS.map(q=>{
                        const sel=applicablePeriods.includes(q.key);
                        return(
                          <button key={q.key} onClick={()=>togglePeriod(q.key)}
                            className="py-3 px-3 rounded-xl border transition-all hover:opacity-90 active:scale-95 text-left"
                            style={sel?{...pillOn,padding:'12px'}:{...pillOff,padding:'12px'}}>
                            <p className="text-xs font-black" style={{color:sel?'#fff':isDark?D.text:'#0f172a'}}>{q.label}</p>
                            <p className="text-[10px] mt-0.5" style={{color:sel?'rgba(255,255,255,0.75)':isDark?D.dimmer:'#94a3b8'}}>{q.sub}</p>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-semibold mb-1.5 block" style={{color:isDark?D.muted:'#374151'}}>Filing falls in</label>
                      <select value={recurMonth} onChange={e=>setRecurMonth(e.target.value)}
                        className="w-full px-3 py-1.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" style={inputStyle}>
                        {QUARTER_MONTHS.map(m=><option key={m.value} value={m.value}>{m.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-semibold mb-1.5 block" style={{color:isDark?D.muted:'#374151'}}>Due on day</label>
                      <select value={recurDay} onChange={e=>setRecurDay(e.target.value)}
                        className="w-full px-3 py-1.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" style={inputStyle}>
                        {RECURRING_DAYS.map(d=><option key={d.value} value={d.value}>{d.label}</option>)}
                      </select>
                    </div>
                  </div>
                </>
              )}

              {/* ── HALF-YEARLY ── */}
              {frequency==='half_yearly'&&dueType==='recurring'&&(
                <>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider mb-2.5" style={{color:isDark?D.muted:'#64748b'}}>
                      Applicable Halves <span className="normal-case font-normal">(e.g. MSME Form 1)</span>
                    </p>
                    <div className="grid grid-cols-1 gap-2">
                      {HALF_PILLS.map(h=>{
                        const sel=applicablePeriods.includes(h.key);
                        return(
                          <button key={h.key} onClick={()=>togglePeriod(h.key)}
                            className="py-3 px-4 rounded-xl border transition-all hover:opacity-90 active:scale-95 flex items-center justify-between"
                            style={sel?pillOn:pillOff}>
                            <div>
                              <p className="text-sm font-black text-left" style={{color:sel?'#fff':isDark?D.text:'#0f172a'}}>{h.label}</p>
                              <p className="text-[11px] mt-0.5 text-left" style={{color:sel?'rgba(255,255,255,0.75)':isDark?D.dimmer:'#94a3b8'}}>
                                {h.sub} · Due {h.filingLabel}
                              </p>
                            </div>
                            {sel&&<CheckCircle2 className="w-5 h-5 text-white opacity-90 flex-shrink-0"/>}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[11px] mt-2" style={{color:isDark?D.dimmer:'#94a3b8'}}>
                      Due dates follow MCA standard: H1 → Oct 31, H2 → Apr 30
                    </p>
                  </div>
                </>
              )}

              {/* ── ONE-TIME SPECIFIC DATE (all frequencies) ── */}
              {(dueType==='specific'||frequency==='annual'||frequency==='one_time')&&(
                <div>
                  {(frequency==='annual'||frequency==='one_time')&&(
                    <p className="text-xs font-bold uppercase tracking-wider mb-2.5" style={{color:isDark?D.muted:'#64748b'}}>
                      {frequency==='annual'?'Annual Filing Due Date':'One-Time Due Date'}
                    </p>
                  )}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={openNativeDatePicker}
                      className="w-full flex items-center gap-3 px-4 py-2.5 border rounded-xl text-sm font-semibold transition-all hover:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      style={{
                        backgroundColor:isDark?D.raised:'#fff',
                        borderColor:dueDate?'#1F6FB2':(isDark?D.border:'#d1d5db'),
                        color:dueDate?(isDark?D.text:'#0f172a'):(isDark?D.dimmer:'#94a3b8'),
                      }}>
                      <Calendar className="w-4 h-4 flex-shrink-0" style={{color:dueDate?'#1F6FB2':(isDark?D.dimmer:'#94a3b8')}}/>
                      <span className="flex-1 text-left">{fmtDisplayDate(dueDate)}</span>
                      <ChevronDown className="w-4 h-4 flex-shrink-0 opacity-50"/>
                    </button>
                    <input
                      ref={nativeDateInputRef}
                      type="date"
                      value={dueDate||''}
                      onChange={e=>setDueDate(e.target.value)}
                      className="absolute w-px h-px opacity-0 pointer-events-none"
                      tabIndex={-1}
                      aria-hidden="true"
                    />
                  </div>
                </div>
              )}

              {/* ── COMPUTED DATES PREVIEW ── */}
              {previewDates.length>0&&(
                <div className="rounded-xl p-3 space-y-2" style={{backgroundColor:isDark?'rgba(59,130,246,0.08)':'#eff6ff',border:'1px solid rgba(59,130,246,0.2)'}}>
                  <div className="flex items-center gap-1.5 mb-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-blue-500"/>
                    <p className="text-xs font-bold text-blue-600">Computed Filing Dates</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {previewDates.map((pd,i)=>(
                      <span key={i} className="text-[11px] font-semibold px-2.5 py-1 rounded-lg flex items-center gap-1"
                        style={{backgroundColor:isDark?'rgba(31,111,178,0.2)':'rgba(31,111,178,0.1)',color:'#1F6FB2'}}>
                        <span style={{color:isDark?'#93c5fd':'#1e40af'}}>{pd.label}</span>
                        <span style={{opacity:0.5}}>→</span>
                        <span>{pd.filing} · {new Date(pd.date).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}</span>
                      </span>
                    ))}
                  </div>
                  <p className="text-[10px]" style={{color:isDark?D.dimmer:'#94a3b8'}}>
                    First date will be saved as the next due date
                  </p>
                </div>
              )}

              {/* Clear periods */}
              {applicablePeriods.length>0&&(
                <button onClick={()=>setApplicablePeriods([])}
                  className="text-[11px] font-bold hover:opacity-70 transition-opacity flex items-center gap-1"
                  style={{color:isDark?D.dimmer:'#94a3b8'}}>
                  <X className="w-3 h-3"/>Clear selection
                </button>
              )}

            </div>
          </div>

          {/* Description */}
          <div>
            <label className="text-sm font-semibold mb-1.5 block" style={{color:isDark?D.muted:'#374151'}}>Description (optional)</label>
            <textarea value={desc} onChange={e=>setDesc(e.target.value)} rows={2}
              placeholder="Notes about this compliance type…"
              className={`${inputCls} resize-none`} style={inputStyle}/>
          </div>

        </div>

        {/* Footer */}
        <div className="px-6 py-4 flex justify-end gap-2 border-t flex-shrink-0"
          style={{borderColor:isDark?D.border:'#e2e8f0',backgroundColor:isDark?D.raised:'#f8fafc'}}>
          <Button variant="ghost" onClick={onClose} className="font-semibold rounded-xl"
            style={{color:isDark?D.muted:undefined}}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving||!name.trim()}
            className="font-semibold text-white rounded-xl px-5" style={{backgroundColor:'#1F6FB2'}}>
            {saving
              ?<><Loader2 className="w-4 h-4 mr-1.5 animate-spin"/>Saving…</>
              :<><CheckCircle2 className="w-4 h-4 mr-1.5"/>{existing?'Save Changes':'Create'}</>}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}


// ── Import Excel Modal ─────────────────────────────────────────────────────
function ImportExcelModal({complianceId,complianceName,onClose,onImported,isDark,allUsers=[],compliance}){
  const[step,setStep]=useState(1);
  const[file,setFile]=useState(null);
  const[aiFile,setAiFile]=useState(null);
  const[preview,setPreview]=useState(null);
  const[previewing,setPreviewing]=useState(false);
  const[clientCol,setClientCol]=useState('Client Name');
  const[statusCol,setStatusCol]=useState('');
  const[notesCol,setNotesCol]=useState('');
  const[assignedToCol,setAssignedToCol]=useState('');   // column in excel for assigned_to
  const[defaultAssignedTo,setDefaultAssignedTo]=useState(''); // fallback user id
  const[result,setResult]=useState(null);
  const fileRef=useRef(null);
  const inputStyle={backgroundColor:isDark?D.raised:'#fff',borderColor:isDark?D.border:'#d1d5db',color:isDark?D.text:'#1e293b'};

  // Auto-select a default user based on compliance category
  useEffect(()=>{
    if(allUsers.length&&compliance?.category){
      const cat=(compliance.category||'').toLowerCase();
      const match=allUsers.find(u=>(u.departments||[]).some(d=>d.toLowerCase().includes(cat)||cat.includes(d.toLowerCase())));
      if(match)setDefaultAssignedTo(match.id);
    }
  },[allUsers,compliance?.category]);

  const handleFileChange=async e=>{
    const f=e.target.files?.[0]; if(!f)return;
    setFile(f); setAiFile(f); setPreviewing(true);
    try{
      const fd=new FormData();fd.append('file',f);
      const res=await api.post(`/compliance/${complianceId}/preview-excel`,fd,{headers:{'Content-Type':'multipart/form-data'}});
      setPreview(res.data);
      const cols=res.data.columns||[];
      setClientCol(cols.find(c=>c.toLowerCase().includes('client')||c.toLowerCase().includes('company'))||cols[0]||'');
      setStatusCol(cols.find(c=>c.toLowerCase().includes('status'))||'');
      setNotesCol(cols.find(c=>c.toLowerCase().includes('note'))||'');
      setStep(2);
    }catch(err){toast.error(err?.response?.data?.detail||'Could not read file');}
    finally{setPreviewing(false);}
  };

  const handleImport=async()=>{
    setStep(3);
    try{
      const fd=new FormData();
      fd.append('file',file);fd.append('client_col',clientCol);
      fd.append('status_col',statusCol);fd.append('notes_col',notesCol);
      if(assignedToCol)fd.append('assigned_to_col',assignedToCol);
      if(defaultAssignedTo)fd.append('default_assigned_to',defaultAssignedTo);
      const res=await api.post(`/compliance/${complianceId}/import-excel`,fd,{headers:{'Content-Type':'multipart/form-data'}});
      setResult(res.data);setStep(4);onImported();
      toast.success(`Import complete — ${res.data.added} added, ${res.data.updated} updated`);
    }catch(err){toast.error(err?.response?.data?.detail||'Import failed');setStep(2);}
  };

  return(
    <motion.div className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{background:'rgba(6,78,59,0.8)',backdropFilter:'blur(8px)'}}
      initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onClick={onClose}>
      <motion.div className="w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col"
        style={{backgroundColor:isDark?D.card:'#fff',border:isDark?`1px solid ${D.border}`:'1px solid #e2e8f0'}}
        initial={{scale:0.92,y:24}} animate={{scale:1,y:0}} exit={{scale:0.92,y:24}}
        transition={{type:'spring',stiffness:220,damping:22}} onClick={e=>e.stopPropagation()}>
        <div className="px-6 py-5 text-white flex-shrink-0 flex items-center justify-between"
          style={{background:'linear-gradient(135deg,#0D3B66,#1F6FB2)'}}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center"><FileUp className="w-5 h-5 text-white"/></div>
            <div><h2 className="text-lg font-black">Import Excel / CSV</h2>
              <p className="text-green-200 text-xs truncate max-w-[280px]">{complianceName}</p></div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-xl bg-white/20 hover:bg-white/30 flex items-center justify-center"><X className="w-4 h-4 text-white"/></button>
        </div>
        <div className="flex items-center gap-2 px-6 py-3 border-b" style={{borderColor:isDark?D.border:'#f1f5f9'}}>
          {['Upload','Map Columns','Importing','Done'].map((label,i)=>{
            const num=i+1;const done=step>num;const active=step===num;
            return(<React.Fragment key={label}>
              <div className="flex items-center gap-1.5">
                <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black"
                  style={{backgroundColor:done?'#1FAF5A':active?'#1F6FB2':isDark?D.raised:'#e2e8f0',color:done||active?'#fff':isDark?D.muted:'#64748b'}}>
                  {done?'✓':num}</div>
                <span className="text-xs font-semibold hidden sm:block"
                  style={{color:active?(isDark?D.text:'#0f172a'):isDark?D.dimmer:'#94a3b8'}}>{label}</span>
              </div>
              {i<3&&<div className="flex-1 h-px" style={{backgroundColor:isDark?D.border:'#e2e8f0'}}/>}
            </React.Fragment>);
          })}
        </div>
        <div className="flex-1 overflow-y-auto p-6" style={{scrollbarWidth:'thin'}}>
          {step===1&&(
            <div>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleFileChange} className="hidden"/>
              <button onClick={()=>fileRef.current?.click()} disabled={previewing}
                className="flex flex-col items-center justify-center w-full py-14 rounded-2xl border-2 border-dashed transition-all hover:border-blue-400 gap-3"
                style={{borderColor:isDark?D.border:'#cbd5e1',backgroundColor:isDark?'rgba(255,255,255,0.02)':'#f8fafc'}}>
                {previewing?<><Loader2 className="w-8 h-8 text-blue-500 animate-spin"/><p className="text-sm font-semibold text-blue-500">Reading file…</p></>
                  :<><Upload className="w-8 h-8" style={{color:isDark?D.muted:'#64748b'}}/>
                    <p className="text-sm font-semibold" style={{color:isDark?D.text:'#1e293b'}}>Click to upload Excel or CSV</p>
                    <p className="text-xs" style={{color:isDark?D.dimmer:'#94a3b8'}}>Columns: Client Name, Status (optional), Notes (optional)</p></>}
              </button>
              <AIFileInsights file={aiFile} label="Compliance Data Insights" />
            </div>
          )}
          {step===2&&preview&&(
            <div className="space-y-4">
              <div className="p-3 rounded-xl border" style={{borderColor:isDark?'rgba(31,175,90,0.3)':'#bbf7d0',backgroundColor:isDark?'rgba(31,175,90,0.08)':'#f0fdf4'}}>
                <p className="text-sm font-semibold" style={{color:isDark?'#4ade80':'#15803d'}}>✓ {preview.total_rows} rows · {preview.columns.length} columns</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {[['Client Name *',clientCol,setClientCol,true],['Status',statusCol,setStatusCol,false],['Notes',notesCol,setNotesCol,false],['Assigned To (col)',assignedToCol,setAssignedToCol,false]].map(([label,val,set,req])=>(
                  <div key={label}>
                    <label className="text-xs font-semibold mb-1 block" style={{color:isDark?D.muted:'#374151'}}>{label}</label>
                    <select value={val} onChange={e=>set(e.target.value)}
                      className="w-full px-3 py-2 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" style={{backgroundColor:isDark?D.raised:'#fff',borderColor:isDark?D.border:'#d1d5db',color:isDark?D.text:'#1e293b'}}>
                      {!req&&<option value="">— Skip —</option>}
                      {(preview.columns||[]).map(c=><option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              {/* Default assigned-to user (used when no column selected or cell is empty) */}
              <div>
                <label className="text-xs font-semibold mb-1 block" style={{color:isDark?D.muted:'#374151'}}>
                  Default Assigned To <span className="font-normal opacity-60">(used when column is empty)</span>
                </label>
                <select value={defaultAssignedTo} onChange={e=>setDefaultAssignedTo(e.target.value)}
                  className="w-full px-3 py-2 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  style={{backgroundColor:isDark?D.raised:'#fff',borderColor:isDark?D.border:'#d1d5db',color:isDark?D.text:'#1e293b'}}>
                  <option value="">— Unassigned —</option>
                  {allUsers.map(u=>(
                    <option key={u.id} value={u.id}>{`${u.full_name}${(u.departments||[]).length?' ('+u.departments.join(', ')+')':''}`}</option>
                  ))}
                </select>
              </div>
              <div className="overflow-x-auto rounded-xl border" style={{borderColor:isDark?D.border:'#e2e8f0'}}>
                <table className="w-full text-xs">
                  <thead><tr style={{backgroundColor:isDark?D.raised:'#f8fafc'}}>
                    {(preview.columns||[]).slice(0,5).map(c=><th key={c} className="px-3 py-2 text-left font-bold uppercase tracking-wider" style={{color:isDark?D.dimmer:'#64748b'}}>{c}</th>)}
                  </tr></thead>
                  <tbody>{(preview.rows||[]).slice(0,5).map((row,i)=>(
                    <tr key={i} style={{borderTop:isDark?`1px solid ${D.border}`:'1px solid #f1f5f9'}}>
                      {(preview.columns||[]).slice(0,5).map(c=><td key={c} className="px-3 py-2 truncate max-w-[150px]" style={{color:isDark?D.muted:'#374151'}}>{row[c]!=null?String(row[c]):''}</td>)}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          )}
          {step===3&&<div className="flex flex-col items-center justify-center py-16 gap-4"><Loader2 className="w-10 h-10 text-blue-500 animate-spin"/><p className="text-sm font-semibold" style={{color:isDark?D.text:'#1e293b'}}>Importing…</p></div>}
          {step===4&&result&&(
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{backgroundColor:'rgba(31,175,90,0.15)'}}><CheckCircle2 className="w-8 h-8 text-emerald-500"/></div>
              <h3 className="text-lg font-black" style={{color:isDark?D.text:'#0f172a'}}>Import Complete!</h3>
              <div className="grid grid-cols-3 gap-4 w-full max-w-xs">
                {[['Added',result.added,'#1FAF5A'],['Updated',result.updated,'#3B82F6'],['Total',result.total_rows_in_file,isDark?D.muted:'#64748b']].map(([l,v,c])=>(
                  <div key={l} className="text-center p-3 rounded-xl border" style={{borderColor:isDark?D.border:'#e2e8f0',backgroundColor:isDark?D.raised:'#f8fafc'}}>
                    <p className="text-2xl font-black" style={{color:c}}>{v}</p>
                    <p className="text-[10px] font-bold uppercase tracking-wide" style={{color:isDark?D.dimmer:'#94a3b8'}}>{l}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="px-6 py-4 flex justify-end gap-2 border-t flex-shrink-0"
          style={{borderColor:isDark?D.border:'#e2e8f0',backgroundColor:isDark?D.raised:'#f8fafc'}}>
          {step===4?<Button onClick={onClose} className="font-semibold text-white rounded-xl px-5" style={{backgroundColor:'#1FAF5A'}}>Done</Button>
            :step===2?<><Button variant="ghost" onClick={()=>{setStep(1);setFile(null);setPreview(null);}} className="font-semibold rounded-xl" style={{color:isDark?D.muted:undefined}}>Back</Button>
              <Button onClick={handleImport} disabled={!clientCol} className="font-semibold text-white rounded-xl px-5" style={{backgroundColor:'#1F6FB2'}}><Upload className="w-4 h-4 mr-1.5"/>Import {preview?.total_rows} Rows</Button></>
            :<Button variant="ghost" onClick={onClose} className="font-semibold rounded-xl" style={{color:isDark?D.muted:undefined}}>Cancel</Button>}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Assign Clients Modal ───────────────────────────────────────────────────
function AssignClientsModal({compliance,onClose,onAssigned,isDark,allUsers=[]}){
  const[clients,setClients]=useState([]);
  const[search,setSearch]=useState('');
  const[selected,setSelected]=useState(new Set());
  const[loading,setLoading]=useState(true);
  const[assigning,setAssigning]=useState(false);
  const[typeFilter,setTypeFilter]=useState('all');
  const[assignedTo,setAssignedTo]=useState('');  // default assigned_to user

  // Pre-select user whose department matches compliance category
  useEffect(()=>{
    if(allUsers.length&&compliance.category){
      const cat=compliance.category.toLowerCase();
      const match=allUsers.find(u=>(u.departments||[]).some(d=>d.toLowerCase().includes(cat)||cat.includes(d.toLowerCase())));
      if(match)setAssignedTo(match.id);
    }
  },[allUsers,compliance.category]);

  // Fetch ALL clients via pagination (backend caps page_size at 500)
  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      try{
        const PAGE_SIZE=500;
        let page=1;
        const all=[];
        // Loop until we get a short page (last) or hit a safety cap
        while(page<=50){
          const r=await api.get('/clients',{params:{page,page_size:PAGE_SIZE}});
          const batch=Array.isArray(r.data)?r.data:(r.data?.clients||[]);
          all.push(...batch);
          if(batch.length<PAGE_SIZE)break;
          page+=1;
        }
        if(!cancelled)setClients(all);
      }catch(e){
        if(e?.response?.status===403) toast.error("You don't have permission to view clients.");
      }finally{ if(!cancelled)setLoading(false); }
    })();
    return()=>{cancelled=true;};
  },[]);
  const[clientScope,setClientScope]=useState('active');
  const activeClientsList=useMemo(()=>clients.filter(c=>!c.status||c.status==='active'),[clients]);
  const scopedClients=useMemo(()=>clientScope==='active'?activeClientsList:clients,[clientScope,activeClientsList,clients]);

  // Normalize raw client_type values to a canonical key so the filter
  // matches regardless of how the value was stored (pvt_ltd / "Private Limited" / etc.)
  const normalizeClientType=(v)=>{
    if(!v) return 'other';
    const s=String(v).toLowerCase().replace(/[\s_\-.]/g,'');
    if(['pvtltd','privatelimited','privateltd','pvt','privatelimitedcompany'].includes(s))return 'pvt_ltd';
    if(['publtd','publicltd','publiclimited','public','publiclimitedcompany'].includes(s))return 'pub_ltd';
    if(s==='llp'||s==='limitedliabilitypartnership')return 'llp';
    if(s==='opc'||s==='onepersoncompany')return 'opc';
    if(['partnership','partnershipfirm','firm'].includes(s))return 'partnership';
    if(['proprietorship','proprietor','prop','sole','soleproprietor','soleproprietorship'].includes(s))return 'proprietorship';
    if(['trust','ngo','trustngo','section8','section8company','sec8','sec8company'].includes(s))return 'trust';
    if(s==='huf'||s==='hinduundividedfamily')return 'huf';
    if(s==='individual')return 'individual';
    return 'other';
  };
  // Curated dropdown options matching the Clients page
  const TYPE_OPTIONS=[
    {value:'proprietorship',label:'Proprietor'},
    {value:'pvt_ltd',       label:'Private Limited'},
    {value:'llp',           label:'LLP'},
    {value:'pub_ltd',       label:'Public Limited'},
    {value:'trust',         label:'Section 8 / Trust / NGO'},
    {value:'partnership',   label:'Partnership'},
    {value:'huf',           label:'HUF'},
    {value:'individual',    label:'Individual'},
    {value:'opc',           label:'OPC'},
    {value:'other',         label:'Other'},
  ];
  const typeCounts=useMemo(()=>{
    const m={};
    scopedClients.forEach(c=>{const k=normalizeClientType(c.client_type);m[k]=(m[k]||0)+1;});
    return m;
  },[scopedClients]);
  const filtered=useMemo(()=>{
    let list=typeFilter!=='all'
      ? scopedClients.filter(c=>normalizeClientType(c.client_type)===typeFilter)
      : scopedClients;
    if(search)list=list.filter(c=>(c.company_name||'').toLowerCase().includes(search.toLowerCase()));
    return list;
  },[scopedClients,search,typeFilter]);

  const handleAssign=async()=>{
    if(!selected.size){toast.error('Select at least one client');return;}
    setAssigning(true);
    try{
      const payload={client_ids:[...selected]};
      if(assignedTo)payload.assigned_to=assignedTo;
      await api.post(`/compliance/${compliance.id}/assignments/bulk-assign`,payload);
      toast.success(`${selected.size} client${selected.size>1?'s':''} assigned`);onAssigned();
    }
    catch(err){toast.error(err?.response?.data?.detail||'Assignment failed');}
    finally{setAssigning(false);}
  };

  return(
    <motion.div className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{background:'rgba(6,78,59,0.75)',backdropFilter:'blur(8px)'}}
      initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onClick={onClose}>
      <motion.div className="w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden flex flex-col"
        style={{backgroundColor:isDark?D.card:'#fff',border:isDark?`1px solid ${D.border}`:'1px solid #e2e8f0',maxHeight:'88vh'}}
        initial={{scale:0.92,y:24}} animate={{scale:1,y:0}} exit={{scale:0.92,y:24}}
        transition={{type:'spring',stiffness:220,damping:22}} onClick={e=>e.stopPropagation()}>
        <div className="px-6 py-5 text-white flex items-center justify-between flex-shrink-0"
          style={{background:'linear-gradient(135deg,#0D3B66,#1F6FB2)'}}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center"><Users className="w-5 h-5 text-white"/></div>
            <div><h2 className="text-lg font-black">Assign Clients</h2>
              <p className="text-purple-200 text-xs truncate max-w-[250px]">{compliance.name}</p></div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-xl bg-white/20 hover:bg-white/30 flex items-center justify-center"><X className="w-4 h-4 text-white"/></button>
        </div>

        {/* Default Assigned To picker */}
        <div className="px-4 py-3 border-b flex-shrink-0 flex items-start gap-3"
          style={{borderColor:isDark?D.border:'#f1f5f9',backgroundColor:isDark?D.raised:'#fafafa'}}>
          <div className="flex-1 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold flex-shrink-0" style={{color:isDark?D.muted:'#374151'}}>Fallback assign to:</span>
              <select value={assignedTo} onChange={e=>setAssignedTo(e.target.value)}
                className="flex-1 px-3 py-1.5 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-400"
                style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#d1d5db',color:isDark?D.text:'#1e293b'}}>
                <option value="">— Unassigned —</option>
                {allUsers.map(u=>(
                  <option key={u.id} value={u.id}>{`${u.full_name}${(u.departments||[]).length?' ('+u.departments.join(', ')+')':''}`}</option>
                ))}
              </select>
            </div>
            <p className="text-[10px]" style={{color:isDark?D.dimmer:'#94a3b8'}}>
              ℹ️ Each client's service-specific user is auto-assigned first, then their default user, then this fallback.
            </p>
          </div>
        </div>

        <div className="p-3 border-b flex-shrink-0 flex flex-col gap-2" style={{borderColor:isDark?D.border:'#f1f5f9'}}>
          <div className="flex gap-1.5">
            <button onClick={()=>{setClientScope('active');setSelected(new Set());}}
              className={`flex-1 text-[11px] font-semibold px-2 py-1.5 rounded-lg border transition-all ${clientScope==='active'?'text-white border-transparent bg-blue-600':'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
              style={clientScope==='active'?{background:'linear-gradient(135deg,#0D3B66,#1F6FB2)'}:{}}>
              Active Clients <span className="opacity-70">({activeClientsList.length})</span>
            </button>
            <button onClick={()=>{setClientScope('all');setSelected(new Set());}}
              className={`flex-1 text-[11px] font-semibold px-2 py-1.5 rounded-lg border transition-all ${clientScope==='all'?'text-white border-transparent':'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
              style={clientScope==='all'?{background:'linear-gradient(135deg,#0D3B66,#1F6FB2)'}:{}}>
              All Clients <span className="opacity-70">({clients.length})</span>
            </button>
          </div>
          <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{color:isDark?D.dimmer:'#94a3b8'}}/>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search clients…"
              className="w-full pl-8 pr-3 py-2 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              style={{backgroundColor:isDark?D.raised:'#fff',borderColor:isDark?D.border:'#d1d5db',color:isDark?D.text:'#1e293b'}}/>
          </div>
          <select value={typeFilter} onChange={e=>setTypeFilter(e.target.value)}
            className="px-3 py-2 border rounded-xl text-sm focus:outline-none"
            style={{backgroundColor:isDark?D.raised:'#fff',borderColor:isDark?D.border:'#d1d5db',color:isDark?D.text:'#1e293b'}}>
            <option value="all">All Types ({scopedClients.length})</option>
            {TYPE_OPTIONS.filter(o=>(typeCounts[o.value]||0)>0).map(o=>(
              <option key={o.value} value={o.value}>{o.label} ({typeCounts[o.value]||0})</option>
            ))}
          </select>
          </div>
        </div>
        <div className="px-4 py-2 flex items-center justify-between border-b flex-shrink-0" style={{borderColor:isDark?D.border:'#f1f5f9'}}>
          <span className="text-xs font-semibold" style={{color:isDark?D.muted:'#64748b'}}>{selected.size} selected · {filtered.length} shown</span>
          <div className="flex gap-2">
            <button onClick={()=>setSelected(new Set(filtered.map(c=>c.id)))} className="text-xs font-semibold text-blue-500">All</button>
            <button onClick={()=>setSelected(new Set())} className="text-xs font-semibold" style={{color:isDark?D.dimmer:'#94a3b8'}}>Clear</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto" style={{scrollbarWidth:'thin'}}>
          {loading?<div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 text-blue-500 animate-spin"/></div>
            :filtered.map((client,idx)=>{
              const isSel=selected.has(client.id);
              return(
                <button key={client.id}
                  onClick={()=>setSelected(prev=>{const s=new Set(prev);isSel?s.delete(client.id):s.add(client.id);return s;})}
                  className="w-full flex items-center gap-3 px-4 py-2.5 border-b text-left transition-colors"
                  style={{borderColor:isDark?D.border:'#f1f5f9',backgroundColor:isSel?(isDark?'rgba(59,130,246,0.08)':'#eff6ff'):'transparent'}}>
                  <span className="text-[11px] font-bold w-7 text-right flex-shrink-0 tabular-nums" style={{color:isDark?D.dimmer:'#94a3b8'}}>{idx+1}</span>
                  <div className="w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0"
                    style={{borderColor:isSel?'#3B82F6':isDark?D.border:'#d1d5db',backgroundColor:isSel?'#3B82F6':'transparent'}}>
                    {isSel&&<span className="text-white text-[9px]">✓</span>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate" style={{color:isDark?D.text:'#0f172a'}}>{client.company_name}</p>
                    <div className="flex items-center gap-2 flex-wrap mt-0.5">
                      <span className="text-[11px]" style={{color:isDark?D.dimmer:'#94a3b8'}}>{client.client_type}</span>
                      {(()=>{
                        // Show auto-detected user: service-specific assignment first, then default
                        const cat=(compliance.category||'').toLowerCase();
                        const kwMap={roc:['roc','mca'],gst:['gst'],itr:['itr','income'],tds:['tds'],audit:['audit'],pf_esic:['pf','esic'],pt:['pt','professional']};
                        const kws=kwMap[cat]||[];
                        const svcAsgn=(client.assignments||[]).find(a=>(a.services||[]).some(s=>kws.some(k=>s.toLowerCase().includes(k))));
                        const assignedUserId=svcAsgn?.user_id||client.assigned_to;
                        const assignedUserName=allUsers.find(u=>u.id===assignedUserId)?.full_name;
                        if(assignedUserName)return(
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex items-center gap-1"
                            style={{backgroundColor:isDark?'rgba(139,92,246,0.12)':'#f5f3ff',color:'#8B5CF6'}}>
                            👤 {assignedUserName}{svcAsgn?' (service)':' (default)'}
                          </span>
                        );
                        if(assignedTo){
                          const fallbackName=allUsers.find(u=>u.id===assignedTo)?.full_name;
                          if(fallbackName)return(
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                              style={{backgroundColor:isDark?'rgba(100,116,139,0.12)':'#f8fafc',color:isDark?D.dimmer:'#94a3b8'}}>
                              👤 {fallbackName} (modal)
                            </span>
                          );
                        }
                        return null;
                      })()}
                    </div>
                  </div>
                </button>
              );
            })}
        </div>
        <div className="px-6 py-4 flex justify-end gap-2 border-t flex-shrink-0"
          style={{borderColor:isDark?D.border:'#e2e8f0',backgroundColor:isDark?D.raised:'#f8fafc'}}>
          <Button variant="ghost" onClick={onClose} className="font-semibold rounded-xl" style={{color:isDark?D.muted:undefined}}>Cancel</Button>
          <Button onClick={handleAssign} disabled={assigning||!selected.size} className="font-semibold text-white rounded-xl px-5" style={{backgroundColor:'#8B5CF6'}}>
            {assigning?<><Loader2 className="w-4 h-4 mr-1.5 animate-spin"/>Assigning…</>:<><Users className="w-4 h-4 mr-1.5"/>Assign {selected.size} Clients</>}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
// ── Full Page Detail View ──────────────────────────────────────────────────
function ComplianceDetailPage({compliance:initialCompliance,onBack,isDark,allUsers}){
  const{user}=useAuth();
  const[compliance,setCompliance]=useState(initialCompliance);
  const[items,setItems]=useState([]);
  const[total,setTotal]=useState(0);
  const[loading,setLoading]=useState(true);
  const[statusFilter,setStatusFilter]=useState('all');
  const[search,setSearch]=useState('');
  const[selectedIds,setSelectedIds]=useState(new Set());
  const[openDropdown,setOpenDropdown]=useState(null);
  const[bulkOpen,setBulkOpen]=useState(false);
  const[showImport,setShowImport]=useState(false);
  const[showAssign,setShowAssign]=useState(false);
  const[showDetailDupDialog,setShowDetailDupDialog]=useState(false);
  const[detailDupGroups,setDetailDupGroups]=useState([]);
  const[detectingDetailDups,setDetectingDetailDups]=useState(false);
  const[editingNote,setEditingNote]=useState(null);
  const[refreshKey,setRefreshKey]=useState(0);
  const[assignmentPage,setAssignmentPage]=useState(1);
  const[assignmentPageSize,setAssignmentPageSize]=useState(25);
  // New tabs
  const[activeTab,setActiveTab]=useState('clients'); // 'clients' | 'monthly' | 'comments'
  const[comments,setComments]=useState([]);
  const[commentsLoading,setCommentsLoading]=useState(false);
  const[commentText,setCommentText]=useState('');
  const[commentClient,setCommentClient]=useState('all'); // 'all' or client_id
  const[sendingComment,setSendingComment]=useState(false);
  const[monthlySummary,setMonthlySummary]=useState({months:[],total_clients:0});
  const[monthlyLoading,setMonthlyLoading]=useState(false);
  const[monthlyViewYear,setMonthlyViewYear]=useState(()=>new Date().getFullYear());
  const[monthlyAssignment,setMonthlyAssignment]=useState(null); // for per-client month editing
  // Inline comment popover
  const[commentPopup,setCommentPopup]=useState(null); // {assignmentId, clientId, clientName}
  const[popupComments,setPopupComments]=useState([]);
  const[popupCommentsLoading,setPopupCommentsLoading]=useState(false);
  const[popupCommentText,setPopupCommentText]=useState('');
  const[popupSending,setPopupSending]=useState(false);
  // Hover preview of comments on the Cmts column — lets you see comments
  // without opening the popup. Cached per client_id so repeat hovers on
  // the same row (or other rows for the same client) don't refetch.
  const[rowCommentsCache,setRowCommentsCache]=useState({}); // {client_id: comment[]}
  const[rowCommentsLoading,setRowCommentsLoading]=useState({}); // {client_id: bool}
  const[hoveredCommentRow,setHoveredCommentRow]=useState(null); // assignment id
  // Row detail modal
  const[detailRow,setDetailRow]=useState(null); // assignment object

  // Inline govt fee & SRN editing in tracker table
  const[editingFee,setEditingFee]=useState(null); // {id, amount, srn}
  const[savingFeeId,setSavingFeeId]=useState(null);
  const[editingReimb,setEditingReimb]=useState(null); // {id, amount}

  const userMap=useMemo(()=>{const m={};(allUsers||[]).forEach(u=>{m[u.id]=u.full_name;});return m;},[allUsers]);

  const openCommentPopup=useCallback(async(a)=>{
    setCommentPopup({assignmentId:a.id,clientId:a.client_id,clientName:a.client_name});
    setPopupCommentText('');
    setPopupComments([]);
    setPopupCommentsLoading(true);
    try{
      const res=await api.get(`/compliance/${compliance.id}/comments?client_id=${a.client_id}`);
      setPopupComments(Array.isArray(res.data)?res.data:[]);
    }catch{}
    finally{setPopupCommentsLoading(false);}
  },[compliance.id]);

  // Fetch (once, then cache) comments for a client so hovering the Cmts
  // icon can show a preview inline without opening the popup.
  const loadRowCommentsPreview=useCallback(async(a)=>{
    if(rowCommentsCache[a.client_id]!==undefined)return; // already cached
    setRowCommentsLoading(prev=>({...prev,[a.client_id]:true}));
    try{
      const res=await api.get(`/compliance/${compliance.id}/comments?client_id=${a.client_id}`);
      setRowCommentsCache(prev=>({...prev,[a.client_id]:Array.isArray(res.data)?res.data:[]}));
    }catch{
      setRowCommentsCache(prev=>({...prev,[a.client_id]:[]}));
    }finally{
      setRowCommentsLoading(prev=>({...prev,[a.client_id]:false}));
    }
  },[compliance.id,rowCommentsCache]);

  const submitPopupComment=useCallback(async()=>{
    if(!popupCommentText.trim()||!commentPopup)return;
    setPopupSending(true);
    try{
      const res=await api.post(`/compliance/${compliance.id}/comments`,{
        text:popupCommentText.trim(),
        client_id:commentPopup.clientId,
      });
      setPopupComments(prev=>[res.data,...prev]);
      // Keep the hover-preview cache in sync so it reflects the new comment
      // immediately, without needing a refetch on the next hover.
      setRowCommentsCache(prev=>({...prev,[commentPopup.clientId]:[res.data,...(prev[commentPopup.clientId]||[])]}));
      setPopupCommentText('');
      toast.success('Comment added');
    }catch{toast.error('Failed to add comment');}
    finally{setPopupSending(false);}
  },[compliance.id,commentPopup,popupCommentText]);

  const fetchItems=useCallback(async()=>{
    setLoading(true);
    try{
      const params=new URLSearchParams({page:String(assignmentPage),limit:String(assignmentPageSize)});
      if(statusFilter!=='all')params.set('status',statusFilter);
      if(search.trim())params.set('search',search.trim());
      const[asgn,cm]=await Promise.all([
        api.get(`/compliance/${compliance.id}/assignments?${params}`),
        api.get('/compliance').then(r=>(r.data||[]).find(c=>c.id===compliance.id)||compliance),
      ]);
      // Enrich assigned_to_name from allUsers if backend didn't resolve it
      const uMap={}; (allUsers||[]).forEach(u=>{uMap[u.id]=u.full_name;});
      const enriched=(asgn.data.items||[]).map(a=>({
        ...a,
        assigned_to_name: a.assigned_to_name || uMap[a.assigned_to] || '',
      }));
      setItems(enriched);setTotal(asgn.data.total||0);setCompliance(cm);
    }catch{toast.error('Failed to load');}
    finally{setLoading(false);}
  },[compliance.id,statusFilter,search,assignmentPage,assignmentPageSize,refreshKey]);

  useEffect(()=>{
    setAssignmentPage(1);
    setSelectedIds(new Set());
  },[statusFilter,search,assignmentPageSize]);

  const fetchComments=useCallback(async()=>{
    setCommentsLoading(true);
    try{
      const params=commentClient!=='all'?`?client_id=${commentClient}`:'';
      const res=await api.get(`/compliance/${compliance.id}/comments${params}`);
      setComments(Array.isArray(res.data)?res.data:[]);
    }catch{toast.error('Failed to load comments');}
    finally{setCommentsLoading(false);}
  },[compliance.id,commentClient]);

  const fetchMonthlySummary=useCallback(async()=>{
    setMonthlyLoading(true);
    try{
      const res=await api.get(`/compliance/${compliance.id}/monthly-summary`);
      setMonthlySummary(res.data||{months:[],total_clients:0});
    }catch{toast.error('Failed to load monthly data');}
    finally{setMonthlyLoading(false);}
  },[compliance.id]);

  useEffect(()=>{fetchItems();},[fetchItems]);
  useEffect(()=>{if(activeTab==='comments')fetchComments();},[activeTab,fetchComments]);
  useEffect(()=>{if(activeTab==='monthly')fetchMonthlySummary();},[activeTab,fetchMonthlySummary]);
  useEffect(()=>{
    if(!openDropdown&&!bulkOpen)return;
    const fn=()=>{setOpenDropdown(null);setBulkOpen(false);};
    document.addEventListener('mousedown',fn);return()=>document.removeEventListener('mousedown',fn);
  },[openDropdown,bulkOpen]);

  const updateStatus=async(id,newStatus)=>{
    setItems(prev=>prev.map(a=>a.id===id?{...a,status:newStatus,updated_at:new Date().toISOString()}:a));
    setOpenDropdown(null);
    try{await api.patch(`/compliance/${compliance.id}/assignments/${id}`,{status:newStatus});}
    catch{toast.error('Update failed');fetchItems();}
  };

  const saveNote=async(id,note)=>{
    setItems(prev=>prev.map(a=>a.id===id?{...a,notes:note}:a));setEditingNote(null);
    try{await api.patch(`/compliance/${compliance.id}/assignments/${id}`,{status:items.find(a=>a.id===id)?.status||'not_started',notes:note});}
    catch{toast.error('Note save failed');}
  };

  const bulkUpdate=async newStatus=>{
    if(!selectedIds.size){toast.error('Select rows first');return;}setBulkOpen(false);
    try{
      await api.patch(`/compliance/${compliance.id}/assignments/bulk-update`,{assignment_ids:[...selectedIds],status:newStatus});
      toast.success(`${selectedIds.size} records → ${STATUS_CFG[newStatus]?.label}`);
      setSelectedIds(new Set());setRefreshKey(k=>k+1);
    }catch{toast.error('Bulk update failed');}
  };

  const bulkDelete=async()=>{
    if(!selectedIds.size){toast.error('Select rows first');return;}
    if(!confirm(`Delete ${selectedIds.size} selected client${selectedIds.size!==1?'s':''} from this compliance? This cannot be undone.`))return;
    try{
      await Promise.all([...selectedIds].map(id=>api.delete(`/compliance/${compliance.id}/assignments/${id}`)));
      toast.success(`${selectedIds.size} client${selectedIds.size!==1?'s':''} deleted`);
      setSelectedIds(new Set());setRefreshKey(k=>k+1);
    }catch{toast.error('Bulk delete failed');}
  };

  const deleteAssignment=async id=>{
    if(!confirm('Remove this client?'))return;
    setItems(prev=>prev.filter(a=>a.id!==id));
    try{await api.delete(`/compliance/${compliance.id}/assignments/${id}`);}
    catch{fetchItems();}
  };

  const saveGovtFee=async(assignmentId,amount,srn)=>{
    setSavingFeeId(assignmentId);
    try{
      const amt = parseFloat(amount)||0;
      const srnVal = (srn||'').trim();
      const res = await api.patch(`/compliance/${compliance.id}/assignments/${assignmentId}/govt-fee`,{
        govt_fees_amount:amt,
        govt_fees_srn:srnVal,
      });
      // Merge full server response (includes fee_history) back into items
      const updated = res.data || {};
      const autoFiled = amt > 0 && !!srnVal;
      const today = new Date().toISOString().slice(0,10);
      setItems(prev=>prev.map(a=>a.id===assignmentId
        ? {
            ...a,
            ...updated,
            govt_fees_amount: amt,
            govt_fees_srn: srnVal,
            ...(autoFiled ? { status:'filed', payment_date: today, filed_at: new Date().toISOString() } : {}),
          }
        : a));
      // Also refresh detailRow if it's open for this assignment
      setDetailRow(prev=>prev&&prev.id===assignmentId ? {...prev,...updated,govt_fees_amount:amt,govt_fees_srn:srnVal,...(autoFiled?{status:'filed',payment_date:today,filed_at:new Date().toISOString()}:{})} : prev);
      setEditingFee(null);
      toast.success(autoFiled ? 'Saved · marked as Filed' : 'Saved');
      try { window.dispatchEvent(new CustomEvent('compliance:govt-fee-updated', { detail: { assignment_id: assignmentId } })); } catch {}
    }catch{toast.error('Save failed');}
    finally{setSavingFeeId(null);}
  };

  // Persist a reimbursement update (Yes/No + optional amount) for an assignment.
  const saveReimbursement=async(a,patch)=>{
    const prevReimbursed = !!a.reimbursed;
    const prevAmount = a.reimbursed_amount ?? null;
    setItems(prev=>prev.map(x=>x.id===a.id?{...x,...patch}:x));
    try{
      await api.patch(`/compliance/${compliance.id}/assignments/${a.id}/govt-fee`, patch);
      try { window.dispatchEvent(new CustomEvent('compliance:govt-fee-updated', { detail: { assignment_id: a.id } })); } catch {}
    }catch{
      setItems(prev=>prev.map(x=>x.id===a.id?{...x,reimbursed:prevReimbursed,reimbursed_amount:prevAmount}:x));
      toast.error('Update failed');
    }
  };


  const addComment=async()=>{
    if(!commentText.trim())return;
    setSendingComment(true);
    try{
      const payload={text:commentText.trim()};
      if(commentClient!=='all')payload.client_id=commentClient;
      const res=await api.post(`/compliance/${compliance.id}/comments`,payload);
      setComments(prev=>[res.data,...prev]);
      setCommentText('');
      toast.success('Comment added');
    }catch{toast.error('Failed to add comment');}
    finally{setSendingComment(false);}
  };

  const deleteComment=async(commentId)=>{
    try{
      await api.delete(`/compliance/${compliance.id}/comments/${commentId}`);
      setComments(prev=>prev.filter(c=>c.id!==commentId));
    }catch{toast.error('Failed to delete comment');}
  };

  const updateMonthlyStatus=async(assignmentId,month,status)=>{
    try{
      await api.patch(`/compliance/${compliance.id}/assignments/${assignmentId}/monthly`,{month,status});
      fetchMonthlySummary();
      toast.success(`${month} → ${STATUS_CFG[status]?.label}`);
    }catch{toast.error('Update failed');}
  };

  const catCfg=CATEGORY_CFG[compliance.category]||CATEGORY_CFG.OTHER;
  const stats=compliance._stats||{};
  const overdue=compliance.due_date&&isPast(safeDate(compliance.due_date))&&(stats.done||0)<(stats.total||0);
  const allSelected=items.length>0&&items.every(a=>selectedIds.has(a.id));
  const someSelected=items.some(a=>selectedIds.has(a.id));

  const STATUS_TABS=[
    {key:'all',         label:'All',         count:stats.total       ||0},
    {key:'not_started', label:'Not Started',  count:stats.not_started ||0},
    {key:'in_progress', label:'In Progress',  count:stats.in_progress ||0},
    {key:'completed',   label:'Completed',    count:stats.completed   ||0},
    {key:'filed',       label:'Filed',        count:stats.filed       ||0},
    {key:'na',          label:'N/A',          count:stats.na          ||0},
  ];

  // ── Period config based on compliance frequency ─────────────────────────
  const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const periodConfig=useMemo(()=>{
    const freq=compliance.frequency;
    const now=new Date();
    const curMonthKey=format(now,'yyyy-MM');
    const curQuarter=Math.floor((now.getMonth())/3)+1;
    const curHalf=now.getMonth()<6?1:2;

    if(freq==='monthly'||!freq){
      // 12 columns: Jan–Dec
      const periods=Array.from({length:12},(_,i)=>{
        const mk=`${monthlyViewYear}-${String(i+1).padStart(2,'0')}`;
        return{key:mk,label:MONTHS[i],isCurrent:mk===curMonthKey};
      });
      return{type:'monthly',label:'Monthly',periods,colLabel:'Month'};
    }
    if(freq==='quarterly'){
      // 4 columns: Q1–Q4
      const QUARTER_RANGES=[[1,2,3],[4,5,6],[7,8,9],[10,11,12]];
      const periods=QUARTER_RANGES.map((months,qi)=>{
        const mk=`${monthlyViewYear}-Q${qi+1}`;
        return{key:mk,label:`Q${qi+1}`,sublabel:`${MONTHS[months[0]-1]}–${MONTHS[months[2]-1]}`,isCurrent:monthlyViewYear===now.getFullYear()&&curQuarter===qi+1};
      });
      return{type:'quarterly',label:'Quarterly',periods,colLabel:'Quarter'};
    }
    if(freq==='half_yearly'){
      // 2 columns: H1, H2
      const periods=[
        {key:`${monthlyViewYear}-H1`,label:'H1',sublabel:'Apr – Sep',isCurrent:monthlyViewYear===now.getFullYear()&&curHalf===1},
        {key:`${monthlyViewYear}-H2`,label:'H2',sublabel:'Oct – Mar',isCurrent:monthlyViewYear===now.getFullYear()&&curHalf===2},
      ];
      return{type:'half_yearly',label:'Half-Yearly',periods,colLabel:'Half Year'};
    }
    if(freq==='annual'){
      // 1 column: the year itself
      const periods=[
        {key:`${monthlyViewYear}`,label:`FY ${monthlyViewYear}`,sublabel:'Full Year',isCurrent:monthlyViewYear===now.getFullYear()},
      ];
      return{type:'annual',label:'Annual',periods,colLabel:'Year'};
    }
    // one_time — single row
    const periods=[{key:`${monthlyViewYear}`,label:'One-Time',sublabel:'',isCurrent:monthlyViewYear===now.getFullYear()}];
    return{type:'one_time',label:'One-Time',periods,colLabel:'Period'};
  },[compliance.frequency,monthlyViewYear]);

  const monthlyRows=useMemo(()=>{
    const map={};
    (monthlySummary.months||[]).forEach(m=>{map[m.month]=m;});
    return periodConfig.periods.map(p=>({...p,data:map[p.key]||null}));
  },[monthlySummary,periodConfig]);

  return(
    <motion.div className="min-h-screen flex flex-col" style={{background:isDark?D.bg:'#f8fafc'}}
      variants={pageVariants} initial="hidden" animate="visible" exit="exit">

      {/* Sticky header */}
      <div className="sticky top-0 z-20 border-b" style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0',borderLeft:`4px solid ${catCfg.color}`}}>
        <div className="px-5 py-3 flex items-center gap-3 flex-wrap">
          <button onClick={onBack} className="flex items-center gap-1.5 text-sm font-semibold hover:opacity-70 flex-shrink-0" style={{color:isDark?D.muted:'#64748b'}}>
            <ArrowLeft className="w-4 h-4"/>Back
          </button>
          <div className="w-px h-5 flex-shrink-0" style={{backgroundColor:isDark?D.border:'#e2e8f0'}}/>
          <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
            <span className="text-[10px] font-black px-2 py-0.5 rounded-md uppercase tracking-wider flex-shrink-0"
              style={{backgroundColor:catCfg.bg,color:catCfg.color,border:`1px solid ${catCfg.border}`}}>{catCfg.label}</span>
            <h1 className="text-base font-black truncate" style={{color:isDark?D.text:'#0f172a'}}>{compliance.name}</h1>
            {compliance.fy_year&&<span className="text-[11px] font-semibold flex-shrink-0" style={{color:isDark?D.muted:'#64748b'}}>FY {compliance.fy_year}</span>}
            {compliance.due_date&&(
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-md flex-shrink-0"
                style={{backgroundColor:overdue?'rgba(239,68,68,0.12)':'rgba(245,158,11,0.1)',color:overdue?'#ef4444':'#d97706'}}>
                Due {fmtDate(compliance.due_date)}{overdue?' · OVERDUE':''}
              </span>
            )}
            {compliance.period_label&&!compliance.due_date&&<span className="text-[11px] flex-shrink-0" style={{color:isDark?D.muted:'#64748b'}}>{compliance.period_label}</span>}
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <div className="text-right">
              <p className="text-sm font-black tabular-nums" style={{color:catCfg.color}}>{stats.pct||0}%</p>
              <p className="text-[10px] font-semibold" style={{color:isDark?D.dimmer:'#94a3b8'}}>{stats.done||0}/{stats.total||0} done</p>
            </div>
            <div className="w-24"><ProgressBar pct={stats.pct||0} color={catCfg.color} height="h-2" isDark={isDark}/></div>
          </div>
        </div>
        <div className="px-5 py-2 flex items-center gap-4 border-t overflow-x-auto" style={{borderColor:isDark?D.border:'#f1f5f9',scrollbarWidth:'none'}}>
          {[{k:'total',l:'Total',c:isDark?D.text:'#0f172a'},{k:'not_started',l:'Not Started',c:STATUS_CFG.not_started.color},
            {k:'in_progress',l:'WIP',c:STATUS_CFG.in_progress.color},{k:'completed',l:'Completed',c:STATUS_CFG.completed.color},
            {k:'filed',l:'Filed',c:STATUS_CFG.filed.color}].map(({k,l,c})=>(
            <div key={k} className="flex items-center gap-1.5 flex-shrink-0">
              <span className="text-sm font-black tabular-nums" style={{color:c}}>{k==='total'?(stats.total||0):(stats[k]||0)}</span>
              <span className="text-[10px] font-semibold" style={{color:isDark?D.dimmer:'#94a3b8'}}>{l}</span>
              {k!=='filed'&&<span className="text-[10px]" style={{color:isDark?D.border:'#e2e8f0'}}>·</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Main Tab Bar */}
      <div className="flex border-b overflow-x-auto flex-shrink-0" style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0',scrollbarWidth:'none'}}>
        {[
          {key:'clients', label:'Clients', icon:Users,    count:stats.total||0},
          {key:'monthly', label:`${periodConfig?.label||'Period'} Tracker`, icon:BarChart3, count:null},
        ].map(({key,label,icon:Icon,count})=>(
          <button key={key} onClick={()=>setActiveTab(key)}
            className="flex-shrink-0 px-5 py-3 text-xs font-bold border-b-2 transition-all whitespace-nowrap flex items-center gap-2"
            style={{borderColor:activeTab===key?catCfg.color:'transparent',color:activeTab===key?catCfg.color:isDark?D.dimmer:'#64748b',backgroundColor:activeTab===key?(isDark?'rgba(255,255,255,0.03)':'rgba(0,0,0,0.01)'):'transparent'}}>
            <Icon className="w-3.5 h-3.5"/>
            {label}
            {count!=null&&count>0&&<span className="text-[10px] font-black px-1.5 py-0.5 rounded-full"
              style={{backgroundColor:activeTab===key?catCfg.bg:isDark?D.raised:'#f1f5f9',color:activeTab===key?catCfg.color:isDark?D.dimmer:'#94a3b8'}}>{count}</span>}
          </button>
        ))}
      </div>

      {/* ─── CLIENTS TAB ─────────────────────────────────────────────────── */}
      {activeTab==='clients'&&(<>
        {/* Toolbar */}
        <div className="px-5 py-3 border-b flex items-center gap-2 flex-wrap flex-shrink-0"
          style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0'}}>
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{color:isDark?D.dimmer:'#94a3b8'}}/>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search client…"
              className="w-full pl-8 pr-3 py-1.5 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              style={{backgroundColor:isDark?D.raised:'#f8fafc',borderColor:isDark?D.border:'#e2e8f0',color:isDark?D.text:'#1e293b'}}/>
          </div>
          {/* ── Status Filter Dropdown ── */}
          <div className="relative">
            <select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}
              className="appearance-none pl-8 pr-3 py-1.5 border rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
              style={{
                backgroundColor: statusFilter!=='all'?`${catCfg?.color||'#1F6FB2'}12`:(isDark?D.raised:'#f8fafc'),
                borderColor: statusFilter!=='all'?(catCfg?.color||'#1F6FB2'):(isDark?D.border:'#e2e8f0'),
                color: statusFilter!=='all'?(catCfg?.color||'#1F6FB2'):(isDark?D.muted:'#374151'),
                minWidth: 130,
              }}>
              <option value="all">All Status</option>
              {STATUSES.map(s=><option key={s} value={s}>{STATUS_CFG[s]?.label||s}</option>)}
            </select>
            <Filter className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
              style={{color:statusFilter!=='all'?(catCfg?.color||'#1F6FB2'):(isDark?D.dimmer:'#94a3b8')}}/>
          </div>
{/* placeholder — bulk bar is rendered as floating overlay below */}
          <button onClick={()=>setShowAssign(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-semibold border hover:opacity-80"
            style={{backgroundColor:isDark?D.raised:'#f8fafc',borderColor:isDark?D.border:'#e2e8f0',color:isDark?D.muted:'#374151'}}>
            <Plus className="w-3.5 h-3.5"/>Add Clients
          </button>
          <button onClick={()=>setShowImport(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-semibold border hover:opacity-80"
            style={{backgroundColor:isDark?D.raised:'#f8fafc',borderColor:isDark?D.border:'#e2e8f0',color:isDark?D.muted:'#374151'}}>
            <Upload className="w-3.5 h-3.5"/>Import Excel
          </button>
{/* delete in floating bar */}
          <button
            onClick={()=>{
              if(detectingDetailDups)return;
              setDetectingDetailDups(true);
              // Filter out completed and filed items
              const activeItems=items.filter(i=>i.status!=='completed'&&i.status!=='filed');
              if(activeItems.length===0){
                toast.info('No active (non-completed) clients to scan for duplicates.');
                setDetectingDetailDups(false);
                return;
              }
              const adapted=activeItems.map(i=>({...i,name:i.client_name||i.client_id||'Unknown',category:compliance.category,fy_year:compliance.fy_year,frequency:compliance.frequency}));
              // Try Grok API first, then Gemini, fallback to local engine
              const localFallback=()=>{
                try{
                  const groups=detectComplianceDuplicates(adapted);
                  setDetailDupGroups(groups);
                  setShowDetailDupDialog(true);
                  if(!groups.length)toast.success(`No duplicate entries found among ${activeItems.length} active clients ✓`);
                  else toast.info(`Found ${groups.length} duplicate group${groups.length!==1?'s':''}`);
                }catch(e){toast.error('Scan failed');}
                finally{setDetectingDetailDups(false);}
              };
              const tryAIDetect=async()=>{
                try{
                  const clientNames=adapted.map((i,idx)=>({idx,name:i.name,assigned:i.assigned_to_name||'',notes:i.notes||''}));
                  const { data } = await api.post('/compliance/detect-duplicates', { items: clientNames, context: 'client_entries' });
                  const mappedGroups = (data.groups || []).map(g => ({
                    item_ids: (g.item_ids || []).map(idx => String(adapted[idx]?.id || idx)),
                    confidence: g.confidence || 'medium',
                    reason: g.reason || 'AI detected similarity',
                    score: g.confidence === 'high' ? 90 : 70,
                    source: 'gemini',
                  })).filter(g => g.item_ids.length > 1);
                  setDetailDupGroups(mappedGroups);
                  setShowDetailDupDialog(true);
                  if(!mappedGroups.length)toast.success(`Gemini AI: No duplicates found among ${activeItems.length} active clients ✓`);
                  else toast.info(`Gemini AI found ${mappedGroups.length} duplicate group${mappedGroups.length!==1?'s':''}`);
                }catch(e){
                  console.warn('Gemini AI failed, using local engine', e);
                  localFallback();
                }finally{
                  setDetectingDetailDups(false);
                }
              };
              tryAIDetect().catch(()=>localFallback());
            }}
            disabled={detectingDetailDups||items.filter(i=>i.status!=='completed'&&i.status!=='filed').length===0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-semibold border hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{backgroundColor:isDark?D.raised:'#f8fafc',borderColor:isDark?D.border:'#e2e8f0',color:isDark?D.muted:'#374151'}}>
            {detectingDetailDups?<><Loader2 className="w-3.5 h-3.5 animate-spin"/>Scanning…</>:<><Sparkles className="w-3.5 h-3.5"/>AI Duplicates</>}
          </button>
          <button onClick={()=>setRefreshKey(k=>k+1)} className="p-1.5 rounded-lg hover:opacity-70" style={{color:isDark?D.dimmer:'#94a3b8'}}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading?'animate-spin':''}`}/>
          </button>
          <span className="ml-auto text-xs font-semibold" style={{color:isDark?D.dimmer:'#94a3b8'}}>{items.length} of {total} records</span>
        </div>

        {/* Status sub-tabs */}
        <div className="flex border-b overflow-x-auto flex-shrink-0" style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0',scrollbarWidth:'none'}}>
          {STATUS_TABS.map(({key,label,count})=>(
            <button key={key} onClick={()=>{setStatusFilter(key);setSelectedIds(new Set());}}
              className="flex-shrink-0 px-4 py-2.5 text-xs font-semibold border-b-2 transition-all whitespace-nowrap flex items-center gap-1.5"
              style={{borderColor:statusFilter===key?catCfg.color:'transparent',color:statusFilter===key?catCfg.color:isDark?D.dimmer:'#64748b'}}>
              {label}
              <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full"
                style={{backgroundColor:statusFilter===key?catCfg.bg:isDark?D.raised:'#f1f5f9',color:statusFilter===key?catCfg.color:isDark?D.dimmer:'#94a3b8'}}>
                {count}
              </span>
            </button>
          ))}
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto" style={{scrollbarWidth:'thin'}}>
          <div className="sticky top-0 z-10 grid px-4 py-2.5 gap-2 text-[10px] font-bold uppercase tracking-wider border-b whitespace-nowrap"
            style={{gridTemplateColumns:'36px 44px minmax(220px,1fr) 120px 110px 100px 100px 100px 100px 150px 44px 76px 36px',backgroundColor:isDark?D.raised:'#f8fafc',color:isDark?D.dimmer:'#94a3b8',borderColor:isDark?D.border:'#e2e8f0'}}>
            <div className="flex items-center justify-center">
              <button onClick={()=>allSelected?setSelectedIds(new Set()):setSelectedIds(new Set(items.map(a=>a.id)))}
                className="w-4 h-4 rounded border-2 flex items-center justify-center"
                style={{borderColor:someSelected?'#3B82F6':isDark?D.border:'#d1d5db',backgroundColor:allSelected?'#3B82F6':'transparent'}}>
                {allSelected?<span className="text-white text-[9px]">✓</span>:someSelected?<span style={{color:'#3B82F6',fontSize:8}}>—</span>:null}
              </button>
            </div>
            <div className="text-center">#</div>
            <div>Client Name</div>
            <div>Status</div>
            <div>Assigned To</div>
            <div>Date</div>
            <div>Govt Fee (₹)</div>
            <div>SRN</div>
            <div>Applicability</div>
            <div>Reimbursed</div>
            <div className="text-center">Cmts</div>
            <div>Updated</div>
            <div/>
          </div>

          {loading?(
            <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 text-blue-500 animate-spin"/></div>
          ):items.length===0?(
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <FolderOpen className="w-10 h-10" style={{color:isDark?D.border:'#d1d5db'}}/>
              <p className="text-sm font-semibold" style={{color:isDark?D.muted:'#64748b'}}>
                {search||statusFilter!=='all'?'No matching clients':'No clients assigned yet'}
              </p>
              {!search&&statusFilter==='all'&&(
                <button onClick={()=>setShowAssign(true)} className="text-sm font-semibold text-blue-500 hover:text-blue-400">+ Assign clients now</button>
              )}
            </div>
          ):(
            <div className="divide-y" style={{borderColor:isDark?D.border:'#f1f5f9'}}>
              {items.map((a,idx)=>{
                const isSel=selectedIds.has(a.id);
                const isEditNote=editingNote?.id===a.id;
                return(
                  <motion.div key={a.id}
                    className="group grid px-4 py-2.5 items-center gap-2 transition-colors"
                    style={{gridTemplateColumns:'36px 44px minmax(220px,1fr) 120px 110px 100px 100px 100px 100px 150px 44px 76px 36px',backgroundColor:isSel?(isDark?'rgba(59,130,246,0.06)':'#eff6ff'):a.status==='filed'?(isDark?'rgba(31,175,90,0.10)':'#f0fdf4'):'transparent',borderLeft:a.status==='filed'?'3px solid #1FAF5A':'3px solid transparent'}}
                    whileHover={{backgroundColor:a.status==='filed'?(isDark?'rgba(31,175,90,0.14)':'#dcfce7'):(isDark?'rgba(255,255,255,0.03)':'#fafafa')}}>
                    <div className="flex items-center justify-center">
                      <button onClick={()=>setSelectedIds(prev=>{const s=new Set(prev);isSel?s.delete(a.id):s.add(a.id);return s;})}
                        className="w-4 h-4 rounded border-2 flex items-center justify-center"
                        style={{borderColor:isSel?'#3B82F6':isDark?D.border:'#d1d5db',backgroundColor:isSel?'#3B82F6':'transparent'}}>
                        {isSel&&<span className="text-white text-[9px]">✓</span>}
                      </button>
                    </div>
                    <div className="text-center">
                      <span className="text-[11px] font-bold tabular-nums" style={{color:isDark?D.dimmer:'#94a3b8'}}>{(assignmentPage-1)*assignmentPageSize+idx+1}</span>
                    </div>
                    <div className="min-w-0">
                      <button onClick={()=>setDetailRow(a)} className="text-sm font-semibold truncate text-left w-full hover:underline transition-all" style={{color:isDark?D.text:'#0f172a'}}>{a.client_name || <span className="italic" style={{color:isDark?D.dimmer:'#94a3b8'}}>Unknown client</span>}</button>
                    </div>
                    <div className="relative flex-shrink-0" onClick={e=>e.stopPropagation()}>
                      <StatusPill status={a.status} size="xs" onClick={()=>setOpenDropdown(d=>d===a.id?null:a.id)}/>
                      <AnimatePresence>
                        {openDropdown===a.id&&(
                          <motion.div className="absolute left-0 top-full mt-1 z-50"
                            initial={{opacity:0,y:-6}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-6}}>
                            <StatusDropdown current={a.status} onSelect={s=>updateStatus(a.id,s)} isDark={isDark}/>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                    <div className="min-w-0 flex-shrink-0">
                      <p className="text-xs truncate" style={{color:isDark?D.muted:'#64748b'}}>{a.assigned_to_name||userMap[a.assigned_to]||'—'}</p>
                    </div>
                    <div className="min-w-0 flex-shrink-0">
                      {/* Auto-set by the backend the day both Govt Fee + SRN are
                          saved (see saveGovtFee / govt-fee endpoint) — no manual
                          entry needed, this just displays it. */}
                      <span className="text-xs tabular-nums flex items-center gap-1"
                        style={{color:a.payment_date?(isDark?D.muted:'#64748b'):(isDark?D.dimmer:'#cbd5e1')}}>
                        <CalendarClock className="w-3 h-3 flex-shrink-0 opacity-60"/>
                        {a.payment_date?fmtDate(a.payment_date):<span className="italic">—</span>}
                      </span>
                    </div>
                    {/* Govt Fee cell */}
                    <div className="min-w-0 flex-shrink-0" onClick={e=>e.stopPropagation()}>
                      {editingFee?.id===a.id?(
                        <div className="flex items-center gap-1">
                          <input autoFocus type="number" min="0" step="0.01"
                            value={editingFee.amount}
                            onChange={e=>setEditingFee(f=>({...f,amount:e.target.value}))}
                            onKeyDown={e=>{if(e.key==='Enter')saveGovtFee(a.id,editingFee.amount,editingFee.srn);if(e.key==='Escape')setEditingFee(null);}}
                            className="w-20 px-1.5 py-0.5 border rounded text-xs focus:outline-none focus:ring-1 focus:ring-green-500"
                            style={{backgroundColor:isDark?D.raised:'#fff',borderColor:isDark?D.border:'#d1d5db',color:isDark?D.text:'#1e293b'}}
                            placeholder="0.00"/>
                          <button onClick={()=>saveGovtFee(a.id,editingFee.amount,editingFee.srn)}
                            disabled={savingFeeId===a.id}
                            className="text-emerald-500 flex-shrink-0"><CheckCircle2 className="w-3.5 h-3.5"/></button>
                          <button onClick={()=>setEditingFee(null)} className="text-red-400 flex-shrink-0"><X className="w-3 h-3"/></button>
                        </div>
                      ):(
                        <button onClick={()=>setEditingFee({id:a.id,amount:a.govt_fees_amount||0,srn:a.govt_fees_srn||''})}
                          className="w-full text-left text-xs truncate hover:opacity-70 transition-opacity"
                          style={{color:a.govt_fees_amount?(isDark?'#4ade80':'#15803d'):(isDark?D.dimmer:'#cbd5e1')}}>
                          {a.govt_fees_amount?`₹${Number(a.govt_fees_amount).toLocaleString('en-IN')}`:
                            <span className="italic text-[10px]">add fee</span>}
                        </button>
                      )}
                    </div>
                    {/* SRN cell */}
                    <div className="min-w-0 flex-shrink-0" onClick={e=>e.stopPropagation()}>
                      {editingFee?.id===a.id?(
                        <div className="flex items-center gap-1">
                          <input
                            value={editingFee.srn}
                            onChange={e=>setEditingFee(f=>({...f,srn:e.target.value}))}
                            onKeyDown={e=>{if(e.key==='Enter')saveGovtFee(a.id,editingFee.amount,editingFee.srn);if(e.key==='Escape')setEditingFee(null);}}
                            className="w-full px-1.5 py-0.5 border rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                            style={{backgroundColor:isDark?D.raised:'#fff',borderColor:isDark?D.border:'#d1d5db',color:isDark?D.text:'#1e293b'}}
                            placeholder="SRN…"/>
                        </div>
                      ):(
                        <button onClick={()=>setEditingFee({id:a.id,amount:a.govt_fees_amount||0,srn:a.govt_fees_srn||''})}
                          className="w-full text-left text-xs truncate hover:opacity-70 transition-opacity font-mono"
                          style={{color:a.govt_fees_srn?(isDark?D.text:'#1e293b'):(isDark?D.dimmer:'#cbd5e1')}}>
                          {a.govt_fees_srn||<span className="italic font-sans text-[10px]">add SRN</span>}
                        </button>
                      )}
                    </div>
                    {/* Applicability cell: Yes/No segmented control */}
                    <div className="min-w-0 flex items-center flex-shrink-0" onClick={e=>e.stopPropagation()}>
                      <div className="flex rounded-md overflow-hidden border text-[10px] font-bold"
                        style={{borderColor:isDark?D.border:'#d1d5db'}}>
                        {[{v:true,l:'Yes'},{v:false,l:'No'}].map(opt=>{
                          const cur = a.applicability !== false; // default Yes
                          const isActive = cur === opt.v;
                          return(
                            <button key={String(opt.v)}
                              onClick={async()=>{
                                const newVal=opt.v;
                                setItems(prev=>prev.map(x=>x.id===a.id?{...x,applicability:newVal}:x));
                                try{
                                  await api.patch(`/compliance/${compliance.id}/assignments/${a.id}`,{status:a.status||'not_started',applicability:newVal});
                                  toast.success(newVal?'Marked applicable':'Marked not applicable');
                                }catch{toast.error('Update failed');fetchItems();}
                              }}
                              className="px-2 py-1 transition-colors"
                              style={{
                                backgroundColor:isActive?(opt.v?'#3B82F6':'#64748b'):'transparent',
                                color:isActive?'#fff':(isDark?D.dimmer:'#64748b'),
                              }}>
                              {opt.l}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    {/* Reimbursed cell: Yes/No segmented control + amount input */}
                    <div className="min-w-0 flex items-center gap-1.5" onClick={e=>e.stopPropagation()}>
                      <div className="flex rounded-md overflow-hidden border text-[10px] font-bold flex-shrink-0"
                        style={{borderColor:isDark?D.border:'#d1d5db'}}>
                        {[{v:true,l:'Yes'},{v:false,l:'No'}].map(opt=>{
                          const isActive = !!a.reimbursed === opt.v;
                          return(
                            <button key={String(opt.v)}
                              onClick={()=>{
                                const newVal=opt.v;
                                const patch = newVal
                                  ? { reimbursed:true, reimbursed_amount: a.reimbursed_amount ?? (a.govt_fees_amount||0) }
                                  : { reimbursed:false };
                                saveReimbursement(a, patch);
                                toast.success(newVal?'Marked as reimbursed':'Marked as not reimbursed');
                              }}
                              className="px-2 py-1 transition-colors"
                              style={{
                                backgroundColor:isActive?(opt.v?'#10b981':'#64748b'):'transparent',
                                color:isActive?'#fff':(isDark?D.dimmer:'#64748b'),
                              }}>
                              {opt.l}
                            </button>
                          );
                        })}
                      </div>
                      {/* Amount input — only when Reimbursed = Yes */}
                      {a.reimbursed && (
                        <div className="flex items-center gap-1 flex-1 min-w-0">
                          <span className="text-[10px] font-semibold" style={{color:isDark?D.dimmer:'#94a3b8'}}>₹</span>
                          <input
                            type="number" step="0.01" min="0"
                            defaultValue={a.reimbursed_amount ?? a.govt_fees_amount ?? ''}
                            placeholder="0.00"
                            onClick={e=>e.stopPropagation()}
                            onBlur={e=>{
                              const v = e.target.value === '' ? null : parseFloat(e.target.value)||0;
                              if ((a.reimbursed_amount ?? null) === v) return;
                              saveReimbursement(a, { reimbursed:true, reimbursed_amount: v });
                            }}
                            onKeyDown={e=>{ if(e.key==='Enter') e.currentTarget.blur(); }}
                            className="w-full min-w-0 px-1.5 py-0.5 border rounded text-[11px] tabular-nums focus:outline-none focus:ring-1 focus:ring-emerald-500"
                            style={{backgroundColor:isDark?D.raised:'#fff',borderColor:isDark?D.border:'#d1d5db',color:isDark?D.text:'#1e293b'}}
                          />
                        </div>
                      )}
                    </div>

                    <div className="flex-shrink-0 flex items-center justify-center relative"
                      onClick={e=>e.stopPropagation()}
                      onMouseEnter={()=>{setHoveredCommentRow(a.id);loadRowCommentsPreview(a);}}
                      onMouseLeave={()=>setHoveredCommentRow(null)}>
                      <button
                        onClick={e=>{e.stopPropagation();openCommentPopup(a);}}
                        title="Add / view comments"
                        className="w-7 h-7 rounded-lg flex items-center justify-center transition-all hover:opacity-80 relative"
                        style={{backgroundColor:isDark?'rgba(59,130,246,0.12)':'rgba(59,130,246,0.08)',color:'#3B82F6'}}>
                        <MessageSquare className="w-3.5 h-3.5"/>
                      </button>

                      {/* Hover preview — see comments without opening the popup */}
                      <AnimatePresence>
                        {hoveredCommentRow===a.id&&(
                          <motion.div
                            initial={{opacity:0,y:-4}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-4}}
                            transition={{duration:0.12}}
                            className="absolute right-0 top-full mt-1.5 z-50 w-64 rounded-xl shadow-xl border overflow-hidden text-left"
                            style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0'}}>
                            <div className="px-3 py-2 border-b" style={{borderColor:isDark?D.border:'#e2e8f0',backgroundColor:isDark?D.raised:'#f8fafc'}}>
                              <p className="text-[10px] font-black uppercase tracking-wider" style={{color:isDark?D.dimmer:'#94a3b8'}}>Comments</p>
                            </div>
                            <div className="max-h-52 overflow-y-auto p-2.5 space-y-2.5" style={{scrollbarWidth:'thin'}}>
                              {rowCommentsLoading[a.client_id]?(
                                <div className="flex justify-center py-3"><Loader2 className="w-4 h-4 animate-spin text-blue-500"/></div>
                              ):(rowCommentsCache[a.client_id]||[]).length===0?(
                                <p className="text-[11px] text-center py-3" style={{color:isDark?D.dimmer:'#94a3b8'}}>No comments yet</p>
                              ):(<>
                                {(rowCommentsCache[a.client_id]||[]).slice(0,4).map(c=>(
                                  <div key={c.id}>
                                    <div className="flex items-center gap-1.5 mb-0.5">
                                      <span className="text-[10px] font-bold" style={{color:isDark?D.text:'#0f172a'}}>{c.author_name}</span>
                                      <span className="text-[9px]" style={{color:isDark?D.dimmer:'#94a3b8'}}>{timeAgo(c.created_at)}</span>
                                    </div>
                                    <p className="text-[11px] leading-snug line-clamp-2" style={{color:isDark?D.muted:'#374151'}}>{c.text}</p>
                                  </div>
                                ))}
                                {(rowCommentsCache[a.client_id]||[]).length>4&&(
                                  <p className="text-[10px] text-center pt-0.5" style={{color:'#3B82F6'}}>
                                    +{(rowCommentsCache[a.client_id]||[]).length-4} more — click to view all
                                  </p>
                                )}
                              </>)}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                    <div className="flex-shrink-0">
                      <p className="text-[11px] tabular-nums" style={{color:isDark?D.dimmer:'#94a3b8'}}>{timeAgo(a.updated_at)}</p>
                    </div>
                    <div className="flex-shrink-0 flex items-center justify-end">
                      <button onClick={()=>deleteAssignment(a.id)}
                        className="opacity-0 group-hover:opacity-100 w-7 h-7 rounded-lg flex items-center justify-center transition-all hover:bg-red-100"
                        style={{color:'#ef4444'}}>
                        <X className="w-3.5 h-3.5"/>
                      </button>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer + pagination */}
        <div className="px-5 py-2.5 border-t flex items-center justify-between flex-wrap gap-2 flex-shrink-0"
          style={{borderColor:isDark?D.border:'#e2e8f0',backgroundColor:isDark?D.card:'#fff'}}>
          <p className="text-xs font-semibold" style={{color:isDark?D.dimmer:'#94a3b8'}}>
            {items.length} of {total} records{selectedIds.size>0?` · ${selectedIds.size} selected`:''}
          </p>
          <div className="flex items-center gap-4 flex-wrap">
            {['not_started','in_progress','completed','filed'].map(k=>(
              <div key={k} className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{backgroundColor:STATUS_CFG[k]?.dot}}/>
                <span className="text-[11px] font-bold tabular-nums" style={{color:STATUS_CFG[k]?.color}}>{stats[k]||0}</span>
                <span className="text-[10px]" style={{color:isDark?D.dimmer:'#94a3b8'}}>{STATUS_CFG[k]?.label}</span>
              </div>
            ))}
          </div>
        </div>
        <Pagination
          page={assignmentPage}
          pageSize={assignmentPageSize}
          total={total}
          onPageChange={p=>{setAssignmentPage(p);setSelectedIds(new Set());}}
          onPageSizeChange={size=>{setAssignmentPageSize(size);setAssignmentPage(1);setSelectedIds(new Set());}}
          isDark={isDark}
          label="clients"
        />
      </>)}

      {/* ─── MONTHLY TRACKER TAB ─────────────────────────────────────────── */}
      {activeTab==='monthly'&&(
        <div className="flex-1 overflow-auto p-4 sm:p-6 space-y-4" style={{scrollbarWidth:'thin'}}>
          {/* Header */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h2 className="text-base font-black" style={{color:isDark?D.text:'#0f172a'}}>
                {periodConfig.label} Compliance Tracker
              </h2>
              <p className="text-xs mt-0.5" style={{color:isDark?D.muted:'#64748b'}}>
                {monthlySummary.total_clients||0} clients · status auto-synced from Clients tab
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={()=>setMonthlyViewYear(y=>y-1)} className="w-8 h-8 rounded-xl border flex items-center justify-center hover:opacity-70"
                style={{borderColor:isDark?D.border:'#e2e8f0',backgroundColor:isDark?D.card:'#fff',color:isDark?D.muted:'#64748b'}}>
                <ChevronLeft className="w-4 h-4"/>
              </button>
              <span className="text-sm font-black px-3 py-1.5 rounded-xl border"
                style={{borderColor:isDark?D.border:'#e2e8f0',backgroundColor:isDark?D.card:'#fff',color:isDark?D.text:'#0f172a'}}>{monthlyViewYear}</span>
              <button onClick={()=>setMonthlyViewYear(y=>y+1)} className="w-8 h-8 rounded-xl border flex items-center justify-center hover:opacity-70"
                style={{borderColor:isDark?D.border:'#e2e8f0',backgroundColor:isDark?D.card:'#fff',color:isDark?D.muted:'#64748b'}}>
                <ChevronRight className="w-4 h-4"/>
              </button>
              <button onClick={fetchMonthlySummary} className="p-2 rounded-xl border hover:opacity-70"
                style={{borderColor:isDark?D.border:'#e2e8f0',backgroundColor:isDark?D.card:'#fff',color:isDark?D.muted:'#64748b'}}>
                <RefreshCw className={`w-3.5 h-3.5 ${monthlyLoading?'animate-spin':''}`}/>
              </button>
            </div>
          </div>

          {monthlyLoading?(
            <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 text-blue-500 animate-spin"/></div>
          ):(
            <>
              {/* Period summary cards — grid adapts to frequency */}
              <div className={`grid gap-3 ${
                periodConfig.type==='annual'||periodConfig.type==='one_time'?'grid-cols-1 max-w-xs':
                periodConfig.type==='half_yearly'?'grid-cols-2 max-w-md':
                periodConfig.type==='quarterly'?'grid-cols-2 sm:grid-cols-4':
                'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6'
              }`}>
                {monthlyRows.map(({key,label,sublabel,isCurrent,data})=>{
                  const total=data?.total||0;
                  const done=(data?.completed||0)+(data?.filed||0);
                  const pct=total?Math.round(done/total*100):0;
                  return(
                    <div key={key} className="rounded-2xl border p-4 transition-all hover:shadow-md"
                      style={{
                        backgroundColor:isDark?D.card:'#fff',
                        borderColor:isCurrent?catCfg.color:(isDark?D.border:'#e2e8f0'),
                        borderWidth:isCurrent?2:1,
                      }}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-black" style={{color:isDark?D.text:'#0f172a'}}>{label}</span>
                        {isCurrent&&<span className="text-[9px] font-black px-1.5 py-0.5 rounded-full" style={{backgroundColor:catCfg.bg,color:catCfg.color}}>NOW</span>}
                      </div>
                      {sublabel&&<p className="text-[10px] mb-2" style={{color:isDark?D.dimmer:'#94a3b8'}}>{sublabel}</p>}
                      {total>0?(
                        <>
                          <ProgressBar pct={pct} color={catCfg.color} isDark={isDark}/>
                          <div className="flex justify-between items-center mt-1.5">
                            <span className="text-xs font-black" style={{color:catCfg.color}}>{pct}%</span>
                            <span className="text-[10px]" style={{color:isDark?D.dimmer:'#94a3b8'}}>{done}/{total}</span>
                          </div>
                          <div className="flex flex-wrap gap-1 mt-2">
                            {[['completed','C'],['filed','F'],['in_progress','WIP'],['not_started','NS']].map(([k,abbr])=>
                              (data?.[k]||0)>0?<span key={k} className="text-[9px] font-bold px-1 py-0.5 rounded"
                                style={{backgroundColor:STATUS_CFG[k]?.bg,color:STATUS_CFG[k]?.color}}>{data[k]} {abbr}</span>:null
                            )}
                          </div>
                        </>
                      ):(
                        <div className="text-center py-3">
                          <span className="text-[10px]" style={{color:isDark?D.border:'#c8d3e0'}}>No data yet</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Per-client period table */}
              {items.length>0&&(
                <div className="rounded-2xl border overflow-hidden" style={{borderColor:isDark?D.border:'#e2e8f0'}}>
                  <div className="px-4 py-3 border-b flex items-center justify-between"
                    style={{backgroundColor:isDark?D.raised:'#f8fafc',borderColor:isDark?D.border:'#e2e8f0'}}>
                    <p className="text-xs font-black uppercase tracking-wider" style={{color:isDark?D.muted:'#64748b'}}>
                      Per-Client {periodConfig.label} Status — {monthlyViewYear}
                    </p>
                    <span className="text-xs flex items-center gap-1" style={{color:isDark?D.dimmer:'#94a3b8'}}>
                      <Info className="w-3 h-3 flex-shrink-0"/>Status reflects Clients tab (update status there)
                    </span>
                  </div>
                  <div className="overflow-x-auto" style={{scrollbarWidth:'thin'}}>
                    <table className="w-full text-xs border-collapse"
                      style={{minWidth:periodConfig.type==='monthly'?900:periodConfig.type==='quarterly'?500:periodConfig.type==='half_yearly'?400:300}}>
                      <thead>
                        <tr style={{backgroundColor:isDark?D.raised:'#f8fafc',borderBottom:`1px solid ${isDark?D.border:'#e2e8f0'}`}}>
                          <th className="px-4 py-2 text-left font-bold sticky left-0 z-10"
                            style={{color:isDark?D.dimmer:'#94a3b8',backgroundColor:isDark?D.raised:'#f8fafc',minWidth:180}}>Client</th>
                          {periodConfig.periods.map(p=>(
                            <th key={p.key} className="px-2 py-2 text-center font-bold"
                              style={{color:p.isCurrent?catCfg.color:(isDark?D.dimmer:'#94a3b8'),
                                minWidth:periodConfig.type==='monthly'?56:80}}>
                              {p.label}
                              {p.sublabel&&<div className="text-[9px] font-normal opacity-70">{p.sublabel}</div>}
                              {p.isCurrent&&<span className="ml-0.5 text-[8px]" style={{color:catCfg.color}}>●</span>}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {items.slice(0,50).map((a,ri)=>(
                          <tr key={a.id} style={{borderBottom:`1px solid ${isDark?'rgba(255,255,255,0.04)':'#f1f5f9'}`,
                            backgroundColor:ri%2===0?'transparent':(isDark?'rgba(255,255,255,0.01)':'rgba(0,0,0,0.01)')}}>
                            <td className="px-4 py-2 font-semibold sticky left-0 z-10 truncate max-w-[180px]"
                              style={{color:isDark?D.text:'#0f172a',backgroundColor:isDark?D.card:'#fff'}}>{a.client_name}</td>
                            {periodConfig.periods.map(p=>{
                              // For the current period, always reflect the main assignment status from Clients tab
                              const st=p.isCurrent ? (a.status||'not_started') : ((a.monthly_statuses||{})[p.key]||'not_started');
                              const cfg=STATUS_CFG[st]||STATUS_CFG.not_started;
                              return(
                                <td key={p.key} className="px-1 py-1 text-center">
                                  <span
                                    className="inline-block w-full py-1 px-1 rounded-lg text-[10px] font-bold cursor-default select-none"
                                    style={{backgroundColor:cfg.bg,color:cfg.color,border:`1px solid ${cfg.border}`}}
                                    title={`${a.client_name} · ${p.label} · ${cfg.label}${p.isCurrent?' (update from Clients tab)':''}`}>
                                    {st==='not_started'?'—':st==='in_progress'?'WIP':st==='completed'?'✓':st==='filed'?'F':'N/A'}
                                  </span>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {items.length>50&&<p className="text-center text-xs py-2" style={{color:isDark?D.dimmer:'#94a3b8'}}>Showing first 50 clients</p>}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}


      <AnimatePresence>
        {/* ─── INLINE COMMENT POPUP ───────────────────────────────────────── */}
        <AnimatePresence>
        {commentPopup&&(
          <motion.div className="fixed inset-0 z-[9998] flex items-end sm:items-center justify-center p-4"
            style={{background:'rgba(6,78,59,0.55)',backdropFilter:'blur(6px)'}}
            initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
            onClick={()=>setCommentPopup(null)}>
            <motion.div className="w-full max-w-md rounded-2xl shadow-2xl overflow-hidden flex flex-col"
              style={{backgroundColor:isDark?D.card:'#fff',border:isDark?`1px solid ${D.border}`:'1px solid #e2e8f0',maxHeight:'75vh'}}
              initial={{scale:0.94,y:20}} animate={{scale:1,y:0}} exit={{scale:0.94,y:20}}
              transition={{type:'spring',stiffness:260,damping:24}}
              onClick={e=>e.stopPropagation()}>
              {/* Header */}
              <PopupHeader icon={MessageSquare} eyebrow="Comments" title={commentPopup.clientName} onClose={()=>setCommentPopup(null)}/>
              {/* Comments list */}
              <div className="flex-1 overflow-auto p-4 space-y-3" style={{scrollbarWidth:'thin'}}>
                {popupCommentsLoading?(<div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-blue-500"/></div>
                ):popupComments.length===0?(<p className="text-center text-sm py-8" style={{color:isDark?D.dimmer:'#94a3b8'}}>No comments yet</p>
                ):popupComments.map(c=>(
                  <div key={c.id} className="flex items-start gap-2.5">
                    <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-white text-[10px] font-black" style={{backgroundColor:catCfg.color}}>{(c.author_name||'U')[0].toUpperCase()}</div>
                    <div className="flex-1 rounded-xl p-2.5 border" style={{backgroundColor:isDark?D.raised:'#f8fafc',borderColor:isDark?D.border:'#e2e8f0'}}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-bold" style={{color:isDark?D.text:'#0f172a'}}>{c.author_name}</span>
                        <span className="text-[10px]" style={{color:isDark?D.dimmer:'#94a3b8'}}>{timeAgo(c.created_at)}</span>
                      </div>
                      <p className="text-xs leading-relaxed whitespace-pre-wrap" style={{color:isDark?D.muted:'#374151'}}>{c.text}</p>
                    </div>
                  </div>
                ))}
              </div>
              {/* Add comment input */}
              <div className="px-4 py-3 border-t flex-shrink-0" style={{borderColor:isDark?D.border:'#e2e8f0',backgroundColor:isDark?D.card:'#fff'}}>
                <div className="flex items-end gap-2">
                  <textarea value={popupCommentText} onChange={e=>setPopupCommentText(e.target.value)}
                    onKeyDown={e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey))submitPopupComment();}}
                    placeholder="Write a comment… (Ctrl+Enter to post)"
                    rows={2}
                    className="flex-1 px-3 py-2 border rounded-xl text-xs resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                    style={{backgroundColor:isDark?D.raised:'#f8fafc',borderColor:isDark?D.border:'#e2e8f0',color:isDark?D.text:'#1e293b'}}/>
                  <button onClick={submitPopupComment} disabled={popupSending||!popupCommentText.trim()}
                    className="flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-bold text-white transition-all hover:opacity-90 disabled:opacity-50 flex-shrink-0"
                    style={{backgroundColor:catCfg.color}}>
                    {popupSending?<Loader2 className="w-3.5 h-3.5 animate-spin"/>:<Send className="w-3.5 h-3.5"/>}
                    Post
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
        </AnimatePresence>

        {/* ─── ROW DETAIL MODAL ─────────────────────────────────────────────── */}
        <AnimatePresence>
        {detailRow&&(
          <motion.div className="fixed inset-0 z-[9997] flex items-center justify-center p-4"
            style={{background:'rgba(6,78,59,0.6)',backdropFilter:'blur(8px)'}}
            initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
            onClick={()=>setDetailRow(null)}>
            <motion.div className="w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden"
              style={{backgroundColor:isDark?D.card:'#fff',border:isDark?`1px solid ${D.border}`:'1px solid #e2e8f0',maxHeight:'85vh'}}
              initial={{scale:0.93,y:20}} animate={{scale:1,y:0}} exit={{scale:0.93,y:20}}
              transition={{type:'spring',stiffness:240,damping:24}}
              onClick={e=>e.stopPropagation()}>
              {/* Header */}
              <div className="px-5 py-4 flex items-center justify-between text-white flex-shrink-0"
                style={{background:'linear-gradient(135deg,#0D3B66,#1F6FB2)'}}>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-bold uppercase tracking-widest opacity-70 mb-0.5">{compliance.name}</p>
                  <h3 className="text-xl font-bold break-words">{detailRow.client_name}</h3>
                </div>
                <button onClick={()=>setDetailRow(null)} className="w-8 h-8 rounded-xl bg-white/20 hover:bg-white/30 flex items-center justify-center flex-shrink-0 ml-3"><X className="w-4 h-4 text-white"/></button>
              </div>
              {/* Content */}
              <div className="overflow-auto p-5 space-y-4" style={{maxHeight:'calc(85vh - 80px)',scrollbarWidth:'thin'}}>
                {/* Status + Priority row */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl p-3 border" style={{backgroundColor:isDark?D.raised:'#f8fafc',borderColor:isDark?D.border:'#e2e8f0'}}>
                    <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{color:isDark?D.dimmer:'#94a3b8'}}>Status</p>
                    <StatusPill status={detailRow.status}/>
                  </div>
                  <div className="rounded-xl p-3 border" style={{backgroundColor:isDark?D.raised:'#f8fafc',borderColor:isDark?D.border:'#e2e8f0'}}>
                    <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{color:isDark?D.dimmer:'#94a3b8'}}>Assigned To</p>
                    <p className="text-sm font-semibold" style={{color:isDark?D.text:'#0f172a'}}>{detailRow.assigned_to_name||userMap[detailRow.assigned_to]||'—'}</p>
                  </div>
                </div>
                {/* Dates */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl p-3 border" style={{backgroundColor:isDark?D.raised:'#f8fafc',borderColor:isDark?D.border:'#e2e8f0'}}>
                    <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{color:isDark?D.dimmer:'#94a3b8'}}>Last Updated</p>
                    <p className="text-sm font-semibold" style={{color:isDark?D.text:'#0f172a'}}>{fmtDate(detailRow.updated_at,'dd MMM yyyy · HH:mm')}</p>
                  </div>
                  {detailRow.completed_at&&(
                    <div className="rounded-xl p-3 border" style={{backgroundColor:isDark?'rgba(31,175,90,0.08)':'#f0fdf4',borderColor:isDark?'rgba(31,175,90,0.3)':'#bbf7d0'}}>
                      <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{color:'#1FAF5A'}}>Completed</p>
                      <p className="text-sm font-semibold" style={{color:isDark?D.text:'#0f172a'}}>{fmtDate(detailRow.completed_at,'dd MMM yyyy')}</p>
                    </div>
                  )}
                  {detailRow.filed_at&&(
                    <div className="rounded-xl p-3 border" style={{backgroundColor:isDark?'rgba(139,92,246,0.08)':'#faf5ff',borderColor:isDark?'rgba(139,92,246,0.3)':'#e9d5ff'}}>
                      <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{color:'#8B5CF6'}}>Filed</p>
                      <p className="text-sm font-semibold" style={{color:isDark?D.text:'#0f172a'}}>{fmtDate(detailRow.filed_at,'dd MMM yyyy')}</p>
                    </div>
                  )}
                </div>
                {/* Fee Amount + SRN */}
                {(detailRow.govt_fees_amount>0||detailRow.govt_fees_srn)&&(
                  <div className="grid grid-cols-2 gap-3">
                    {detailRow.govt_fees_amount>0&&(
                      <div className="rounded-xl p-3 border" style={{backgroundColor:isDark?'rgba(245,158,11,0.08)':'#fffbeb',borderColor:isDark?'rgba(245,158,11,0.3)':'#fde68a'}}>
                        <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{color:'#D97706'}}>Fee Paid</p>
                        <p className="text-sm font-black" style={{color:isDark?D.text:'#0f172a'}}>₹{Number(detailRow.govt_fees_amount).toLocaleString('en-IN')}</p>
                        {detailRow.payment_date&&<p className="text-[10px] mt-0.5" style={{color:isDark?D.dimmer:'#94a3b8'}}>{fmtDate(detailRow.payment_date,'dd MMM yyyy')}</p>}
                      </div>
                    )}
                    {detailRow.govt_fees_srn&&(
                      <div className="rounded-xl p-3 border" style={{backgroundColor:isDark?'rgba(16,185,129,0.08)':'#f0fdf4',borderColor:isDark?'rgba(16,185,129,0.3)':'#a7f3d0'}}>
                        <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{color:'#059669'}}>SRN</p>
                        <p className="text-sm font-black font-mono break-all" style={{color:isDark?D.text:'#0f172a'}}>{detailRow.govt_fees_srn}</p>
                      </div>
                    )}
                  </div>
                )}
                {/* Fee / SRN Change History — always visible when fee data exists */}
                {(detailRow.govt_fees_amount>0||detailRow.govt_fees_srn)&&(()=>{
                  // Build display list: real history + synthetic current-state entry if no history yet
                  const hist = Array.isArray(detailRow.fee_history) ? [...detailRow.fee_history] : [];
                  const hasCurrent = hist.length>0 && (
                    ('amount' in hist[hist.length-1] && hist[hist.length-1].amount===detailRow.govt_fees_amount) ||
                    ('srn' in hist[hist.length-1] && hist[hist.length-1].srn===detailRow.govt_fees_srn)
                  );
                  const displayList = hist.length===0 ? [{
                    ts: detailRow.updated_at,
                    user_name: detailRow.assigned_to_name||'—',
                    ...(detailRow.govt_fees_amount>0 ? {amount:detailRow.govt_fees_amount,prev_amount:0} : {}),
                    ...(detailRow.govt_fees_srn ? {srn:detailRow.govt_fees_srn,prev_srn:''} : {}),
                    _synthetic: true,
                  }] : [...hist].reverse();
                  return (
                  <div className="rounded-xl border overflow-hidden" style={{borderColor:isDark?D.border:'#e2e8f0'}}>
                    <div className="px-3 py-2 flex items-center justify-between" style={{backgroundColor:isDark?D.raised:'#f8fafc',borderBottom:`1px solid ${isDark?D.border:'#e2e8f0'}`}}>
                      <span className="text-[10px] font-black uppercase tracking-wider" style={{color:isDark?D.dimmer:'#94a3b8'}}>Fee / SRN Update Log</span>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{backgroundColor:isDark?'rgba(31,111,178,0.15)':'#dbeafe',color:'#1F6FB2'}}>{displayList.length} {displayList.length===1?'entry':'entries'}</span>
                    </div>
                    <div style={{borderColor:isDark?D.border:'#f1f5f9'}}>
                      {displayList.map((h,i)=>(
                        <div key={i} className="px-3 py-2.5 flex items-start gap-3" style={{borderTop:i>0?`1px solid ${isDark?D.border:'#f1f5f9'}`:'none'}}>
                          <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 text-[10px] font-black"
                            style={{backgroundColor:h._synthetic?(isDark?'rgba(148,163,184,0.2)':'#f1f5f9'):isDark?'rgba(31,111,178,0.2)':'#dbeafe',color:h._synthetic?(isDark?D.dimmer:'#94a3b8'):'#1F6FB2'}}>
                            {h._synthetic?'·':(h.user_name||'?').charAt(0).toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2 mb-0.5">
                              <span className="text-xs font-bold truncate" style={{color:h._synthetic?(isDark?D.muted:'#64748b'):isDark?D.text:'#0f172a'}}>
                                {h._synthetic?'Recorded (no edit history)':h.user_name||'Unknown'}
                              </span>
                              <span className="text-[10px] flex-shrink-0" style={{color:isDark?D.dimmer:'#94a3b8'}}>{fmtDate(h.ts,'dd MMM yy · HH:mm')}</span>
                            </div>
                            <div className="flex flex-wrap gap-1.5 mt-1">
                              {'amount' in h&&(
                                <span className="text-[10px] px-2 py-0.5 rounded-md font-semibold"
                                  style={{backgroundColor:isDark?'rgba(245,158,11,0.15)':'#fef3c7',color:'#D97706'}}>
                                  {h.prev_amount>0?`₹${Number(h.prev_amount).toLocaleString('en-IN')} → `:''}₹{Number(h.amount||0).toLocaleString('en-IN')}
                                </span>
                              )}
                              {'srn' in h&&(
                                <span className="text-[10px] px-2 py-0.5 rounded-md font-mono font-semibold"
                                  style={{backgroundColor:isDark?'rgba(16,185,129,0.15)':'#d1fae5',color:'#059669'}}>
                                  {h.prev_srn?`${h.prev_srn} → `:''}SRN: {h.srn||'—'}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  );
                })()}
                {/* Notes */}
                <div className="rounded-xl p-3.5 border" style={{backgroundColor:isDark?D.raised:'#f8fafc',borderColor:isDark?D.border:'#e2e8f0'}}>
                  <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{color:isDark?D.dimmer:'#94a3b8'}}>Notes</p>
                  <p className="text-sm leading-relaxed" style={{color:detailRow.notes?(isDark?D.muted:'#374151'):(isDark?D.dimmer:'#cbd5e1'),fontStyle:detailRow.notes?'normal':'italic'}}>{detailRow.notes||'No notes added'}</p>
                </div>
                {/* Actions */}
                <div className="flex gap-2 pt-1">
                  <button onClick={()=>{setDetailRow(null);openCommentPopup(detailRow);}}
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold border transition-all hover:opacity-80"
                    style={{backgroundColor:isDark?'rgba(59,130,246,0.1)':'rgba(59,130,246,0.08)',borderColor:isDark?'rgba(59,130,246,0.3)':'rgba(59,130,246,0.3)',color:'#3B82F6'}}>
                    <MessageSquare className="w-4 h-4"/> View Comments
                  </button>
                  <button onClick={()=>{setDetailRow(null);setEditingNote({id:detailRow.id,value:detailRow.notes||''}); }}
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold border transition-all hover:opacity-80"
                    style={{backgroundColor:isDark?'rgba(31,175,90,0.1)':'rgba(31,175,90,0.08)',borderColor:isDark?'rgba(31,175,90,0.3)':'rgba(31,175,90,0.3)',color:'#1FAF5A'}}>
                    <StickyNote className="w-4 h-4"/> Edit Note
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
        </AnimatePresence>

        {showImport&&<ImportExcelModal complianceId={compliance.id} complianceName={compliance.name} compliance={compliance} allUsers={allUsers} isDark={isDark} onClose={()=>setShowImport(false)} onImported={()=>{setRefreshKey(k=>k+1);setShowImport(false);}}/>}
      </AnimatePresence>
      <AnimatePresence>
        {showAssign&&<AssignClientsModal compliance={compliance} isDark={isDark} allUsers={allUsers} onClose={()=>setShowAssign(false)} onAssigned={()=>{setRefreshKey(k=>k+1);setShowAssign(false);}}/>}
      </AnimatePresence>

      {/* AI Duplicate Detection for client assignments in this compliance */}
      <AIDuplicateDialog
        open={showDetailDupDialog}
        onClose={()=>setShowDetailDupDialog(false)}
        groups={detailDupGroups}
        items={items.map(i=>({...i,name:i.client_name||i.client_id||'Unknown'}))}
        entityLabel="Client Entry"
        accentColor={CATEGORY_CFG[compliance.category]?.color||'#1F6FB2'}
        isDark={isDark}
        canDelete={user?.role==='admin'}
        canEdit={false}
        getTitle={(i)=>i.client_name||i.client_id||'Unknown Client'}
        getSubtitle={(i)=>i.assigned_to_name?`Assigned: ${i.assigned_to_name}`:null}
        getMeta={(i)=>[
          i.status?STATUS_CFG[i.status]?.label||i.status:null,
        ].filter(Boolean)}
        compareFields={(a,b)=>[
          {label:'Client',      a:a.client_name,       b:b.client_name},
          {label:'Status',      a:STATUS_CFG[a.status]?.label||a.status, b:STATUS_CFG[b.status]?.label||b.status},
          {label:'Assigned To', a:a.assigned_to_name,  b:b.assigned_to_name},
          {label:'Notes',       a:(a.notes||'—').slice(0,60), b:(b.notes||'—').slice(0,60)},
        ]}
        onDelete={user?.role==='admin'?async(i)=>{
          if(!window.confirm(`Remove "${i.client_name}" from this compliance?`))return;
          try{
            await api.delete(`/compliance/${compliance.id}/assignments/${i.id}`);
            setItems(prev=>prev.filter(x=>x.id!==i.id));
            toast.success('Entry removed');
          }catch{toast.error('Failed to remove entry');}
        }:undefined}
      />

      {/* ── FLOATING BULK ACTION BAR ── */}
      <AnimatePresence>
        {selectedIds.size>0&&(
          <motion.div
            className="fixed bottom-6 left-1/2 z-[9998] flex items-center gap-2 px-4 py-3 rounded-2xl shadow-2xl border"
            style={{
              transform:'translateX(-50%)',
              backgroundColor:isDark?'#1e293b':'#fff',
              borderColor:catCfg.color,
              borderWidth:1.5,
              boxShadow:`0 8px 40px rgba(0,0,0,0.28), 0 0 0 1px ${catCfg.color}22`,
              minWidth:420,
              backdropFilter:'blur(12px)',
            }}
            initial={{opacity:0,y:32,scale:0.95}}
            animate={{opacity:1,y:0,scale:1}}
            exit={{opacity:0,y:24,scale:0.95}}
            transition={{type:'spring',stiffness:280,damping:24}}>

            {/* Selection badge */}
            <div className="flex items-center gap-2 pr-3 border-r flex-shrink-0" style={{borderColor:isDark?'#334155':'#e2e8f0'}}>
              <div className="w-6 h-6 rounded-lg flex items-center justify-center text-white text-xs font-black flex-shrink-0"
                style={{backgroundColor:catCfg.color}}>
                {selectedIds.size}
              </div>
              <span className="text-xs font-bold whitespace-nowrap" style={{color:isDark?'#94a3b8':'#64748b'}}>
                client{selectedIds.size!==1?'s':''} selected
              </span>
            </div>

            {/* Status update buttons */}
            <div className="flex items-center gap-1.5 flex-wrap flex-1">
              <span className="text-[10px] font-bold uppercase tracking-wider flex-shrink-0 mr-0.5" style={{color:isDark?'#475569':'#94a3b8'}}>Set to:</span>
              {STATUSES.map(s=>{
                const cfg=STATUS_CFG[s];
                return(
                  <button key={s} onClick={()=>bulkUpdate(s)}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11px] font-bold transition-all hover:scale-105 active:scale-95 flex-shrink-0"
                    style={{color:cfg.color,backgroundColor:cfg.bg,borderColor:cfg.border}}>
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{backgroundColor:cfg.dot}}/>
                    {cfg.label}
                  </button>
                );
              })}
            </div>

            {/* Divider */}
            <div className="w-px h-6 flex-shrink-0" style={{backgroundColor:isDark?'#334155':'#e2e8f0'}}/>

            {/* Delete */}
            <button onClick={bulkDelete}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all hover:scale-105 active:scale-95 flex-shrink-0"
              style={{backgroundColor:'rgba(239,68,68,0.1)',color:'#ef4444',border:'1px solid rgba(239,68,68,0.3)'}}>
              <Trash2 className="w-3.5 h-3.5"/>Delete
            </button>

            {/* Deselect */}
            <button onClick={()=>setSelectedIds(new Set())}
              className="w-7 h-7 rounded-lg flex items-center justify-center transition-all hover:opacity-70 flex-shrink-0"
              style={{backgroundColor:isDark?'#334155':'#f1f5f9',color:isDark?'#94a3b8':'#64748b'}}>
              <X className="w-3.5 h-3.5"/>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

    </motion.div>
  );
}

function ComplianceCard({item,onClick,onEdit,onDelete,onClose,isDark,viewMode='board'}){
  const cfg=CATEGORY_CFG[item.category]||CATEGORY_CFG.OTHER;
  const stats=item._stats||{};
  const freqLabel=FREQUENCIES.find(f=>f.value===item.frequency)?.label||item.frequency;
  const overdue=item.due_date&&isPast(safeDate(item.due_date))&&(stats.done||0)<(stats.total||0);
  const dueLabel=item.period_label||(item.due_date?`Due ${fmtDate(item.due_date)}`:null);
  const isClosed=!!item.is_closed;

  // ── LIST ROW ──────────────────────────────────────────────────────────────
  if(viewMode==='list'){
    return(
      <motion.div variants={itemVariants}
        className="grid items-center px-4 py-3 gap-3 cursor-pointer border-b group transition-colors"
        style={{
          gridTemplateColumns:'4px 1fr 110px 100px 130px 100px 80px 72px',
          backgroundColor:'transparent',
          borderColor:isDark?D.border:'#f1f5f9',
        }}
        whileHover={{backgroundColor:isDark?'rgba(255,255,255,0.025)':'#f8fafc'}}
        onClick={onClick}>
        {/* category stripe */}
        <div className="h-8 rounded-full" style={{backgroundColor:cfg.color,width:4,minWidth:4}}/>
        {/* Name */}
        <div className="min-w-0">
          <p className="text-sm font-bold truncate" style={{color:isDark?D.text:'#0f172a'}}>{item.name}</p>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <span className="text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-widest"
              style={{backgroundColor:cfg.bg,color:cfg.color,border:`1px solid ${cfg.border}`}}>{cfg.label}</span>
            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
              style={{backgroundColor:isDark?D.raised:'#f1f5f9',color:isDark?D.dimmer:'#64748b'}}>{freqLabel}</span>
          </div>
        </div>
        {/* FY */}
        <div className="flex-shrink-0">
          {item.fy_year?<span className="text-xs font-semibold" style={{color:'#1F6FB2'}}>FY {item.fy_year}</span>:<span style={{color:isDark?D.border:'#e2e8f0'}}>—</span>}
        </div>
        {/* Due date */}
        <div className="flex-shrink-0">
          {dueLabel
            ?<span className={`text-xs font-semibold ${overdue?'text-red-500':''}`}
               style={{color:overdue?'#ef4444':isDark?D.muted:'#64748b'}}>{dueLabel}</span>
            :<span style={{color:isDark?D.border:'#e2e8f0'}}>—</span>}
        </div>
        {/* Progress */}
        <div className="flex-shrink-0">
          <ProgressBar pct={stats.pct||0} color={cfg.color} isDark={isDark}/>
          <p className="text-[10px] mt-0.5 text-right font-semibold" style={{color:isDark?D.dimmer:'#94a3b8'}}>{stats.done||0}/{stats.total||0}</p>
        </div>
        {/* Pct */}
        <div className="flex-shrink-0">
          <span className="text-sm font-black tabular-nums" style={{color:cfg.color}}>{stats.pct||0}%</span>
        </div>
        {/* Clients */}
        <div className="flex-shrink-0">
          <span className="text-xs font-semibold" style={{color:isDark?D.muted:'#64748b'}}>{stats.total||0} clients</span>
        </div>
        {/* Actions */}
        <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e=>e.stopPropagation()}>
          {onClose&&(
            <button onClick={()=>onClose(item)} title={isClosed?'Re-open':'Close (hide from dashboard)'}
              className="w-7 h-7 rounded-lg flex items-center justify-center hover:opacity-100 opacity-60"
              style={{backgroundColor:isClosed?'rgba(31,175,90,0.12)':isDark?D.raised:'#f1f5f9'}}>
              {isClosed?<CheckCircle2 className="w-3.5 h-3.5 text-green-500"/>:<X className="w-3.5 h-3.5" style={{color:'#64748b'}}/>}
            </button>
          )}
          <button onClick={onEdit} className="w-7 h-7 rounded-lg flex items-center justify-center hover:opacity-100 opacity-60"
            style={{backgroundColor:isDark?D.raised:'#f1f5f9'}}><Edit2 className="w-3.5 h-3.5" style={{color:isDark?D.muted:'#64748b'}}/></button>
          <button onClick={onDelete} className="w-7 h-7 rounded-lg flex items-center justify-center hover:opacity-100 opacity-60"
            style={{backgroundColor:isDark?D.raised:'#f1f5f9'}}><Trash2 className="w-3.5 h-3.5 text-red-400"/></button>
        </div>
      </motion.div>
    );
  }

  // ── BOARD CARD (uniform height via flex-col) ─────────────────────────────
  return(
    <motion.div variants={itemVariants} whileHover={{y:-3,transition:{duration:0.18}}} whileTap={{scale:0.985}} className="group h-full">
      <div className="rounded-2xl border overflow-hidden cursor-pointer transition-all hover:shadow-lg h-full flex flex-col"
        style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0',borderLeft:`4px solid ${cfg.color}`}} onClick={onClick}>
        <div className="p-4 flex-1 flex flex-col">
          {/* Tags row */}
          <div className="flex items-start justify-between gap-2 mb-3">
            <div className="flex flex-wrap gap-1.5 flex-1 min-w-0">
              <span className="text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-widest flex-shrink-0"
                style={{backgroundColor:cfg.bg,color:cfg.color,border:`1px solid ${cfg.border}`}}>{cfg.label}</span>
              <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0"
                style={{backgroundColor:isDark?D.raised:'#f1f5f9',color:isDark?D.dimmer:'#64748b'}}>{freqLabel}</span>
              {item.fy_year&&<span className="text-[9px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0"
                style={{backgroundColor:isDark?'rgba(31,111,178,0.12)':'#eff6ff',color:'#1F6FB2'}}>FY {item.fy_year}</span>}
              {overdue&&<span className="text-[9px] font-black px-1.5 py-0.5 rounded text-red-500 flex-shrink-0"
                style={{backgroundColor:'rgba(239,68,68,0.12)'}}>OVERDUE</span>}
              {isClosed&&<span className="text-[9px] font-black px-1.5 py-0.5 rounded flex-shrink-0"
                style={{backgroundColor:'rgba(100,116,139,0.12)',color:'#64748b'}}>CLOSED</span>}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e=>e.stopPropagation()}>
              <button onClick={onEdit} className="w-6 h-6 rounded-lg flex items-center justify-center hover:opacity-100 opacity-60"
                style={{backgroundColor:isDark?D.raised:'#f8fafc'}}><Edit2 className="w-3 h-3" style={{color:isDark?D.muted:'#64748b'}}/></button>
              <button onClick={onDelete} className="w-6 h-6 rounded-lg flex items-center justify-center hover:opacity-100 opacity-60"
                style={{backgroundColor:isDark?D.raised:'#f8fafc'}}><Trash2 className="w-3 h-3 text-red-400"/></button>
            </div>
          </div>

          <h3 className="text-sm font-bold leading-snug mb-0.5" style={{color:isDark?D.text:'#0f172a'}}>{item.name}</h3>
          {/* Fixed height due date line to keep all cards aligned */}
          <div className="h-5 mb-3">
            {dueLabel&&<p className="text-[11px] flex items-center gap-1" style={{color:overdue?'#ef4444':isDark?D.dimmer:'#94a3b8'}}>
              <Calendar className="w-3 h-3 flex-shrink-0"/>{dueLabel}</p>}
          </div>

          {/* Push stats to bottom */}
          <div className="mt-auto">
            <div className="mb-1.5"><ProgressBar pct={stats.pct||0} color={cfg.color} isDark={isDark}/></div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-black" style={{color:cfg.color}}>{stats.pct||0}%</span>
              <span className="text-[11px]" style={{color:isDark?D.dimmer:'#94a3b8'}}>{stats.done||0} / {stats.total||0}</span>
            </div>

            {/* Status bar */}
            <div className="flex h-1 rounded-full overflow-hidden gap-px mb-3">
              {[['filed'],['completed'],['in_progress'],['not_started']].map(([k])=>
                (stats[k]||0)>0?<div key={k} style={{width:`${(stats[k]||0)/(stats.total||1)*100}%`,backgroundColor:STATUS_CFG[k]?.dot,opacity:0.8}}/>:null
              )}
            </div>

            <div className="flex flex-wrap gap-1.5">
              {[['not_started','pending'],['in_progress','WIP'],['completed','done'],['filed','filed']].map(([k,abbr])=>
                (stats[k]||0)>0?<span key={k} className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md"
                  style={{backgroundColor:STATUS_CFG[k]?.bg,color:STATUS_CFG[k]?.color}}>{stats[k]} {abbr}</span>:null
              )}
            </div>
          </div>
        </div>

        <div className="px-4 py-2 border-t flex items-center justify-between flex-shrink-0"
          style={{borderColor:isDark?D.border:'#f9fafb',backgroundColor:isDark?'rgba(255,255,255,0.02)':'#fafafa'}}>
          <span className="text-[10px] font-semibold" style={{color:isDark?D.dimmer:'#94a3b8'}}>{stats.total||0} clients</span>
          <div className="flex items-center gap-2">
            {onClose&&(
              <button
                onClick={e=>{e.stopPropagation();onClose(item);}}
                title={isClosed?'Re-open compliance':'Close compliance (hide from dashboard)'}
                className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md border transition-colors"
                style={{
                  color:isClosed?'#1FAF5A':'#64748b',
                  borderColor:isClosed?'#1FAF5A':'#cbd5e1',
                  backgroundColor:isClosed?'rgba(31,175,90,0.08)':'transparent',
                }}>
                {isClosed?<><CheckCircle2 className="w-3 h-3"/>Re-open</>:<><X className="w-3 h-3"/>Close</>}
              </button>
            )}
            <div className="flex items-center gap-1 text-[10px] font-bold" style={{color:cfg.color}}>Open<ChevronRight className="w-3 h-3"/></div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ── Compliance Calendar Panel (embedded in Tracker) ─────────────────────────
const CAL_STATUS_STYLES = {
  pending:   { bg:'bg-amber-50 dark:bg-amber-900/20',   text:'text-amber-700',   border:'border-amber-200',   dot:'bg-amber-400',   label:'Pending'   },
  completed: { bg:'bg-emerald-50 dark:bg-emerald-900/20',text:'text-emerald-700',border:'border-emerald-200',dot:'bg-emerald-400',label:'Completed' },
  overdue:   { bg:'bg-red-50 dark:bg-red-900/20',        text:'text-red-700',     border:'border-red-200',     dot:'bg-red-400',     label:'Overdue'   },
  upcoming:  { bg:'bg-blue-50 dark:bg-blue-900/20',      text:'text-blue-700',    border:'border-blue-200',    dot:'bg-blue-400',    label:'Upcoming'  },
};

function ComplianceCalendarPanel({ isDark, showAddCal, setShowAddCal }) {
  const { user } = useAuth();
  const [dueDates, setDueDates]     = useState([]);
  const [calLoading, setCalLoading] = useState(false);
  const [collapsed, setCollapsed]   = useState(false);
  const [calFilter, setCalFilter]   = useState('all');
  const [calSearch, setCalSearch]   = useState('');
  const [calForm, setCalForm]       = useState({ title:'', due_date:'', category:'Other', department:'OTHER', status:'pending', description:'' });
  const [savingCal, setSavingCal]   = useState(false);
  // Quick-add from calendar cell click
  const [clickedDate, setClickedDate] = useState(null); // 'YYYY-MM-DD' string
  const [quickForm, setQuickForm]   = useState({ title:'', category:'Other', description:'' });
  const [savingQuick, setSavingQuick] = useState(false);
  // Calendar navigation
  const [viewYear,  setViewYear]    = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth]   = useState(() => new Date().getMonth()); // 0-indexed

  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DAY_NAMES   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  const getCalStatus = useCallback((dd) => {
    if (dd.status === 'completed') return 'completed';
    const d = differenceInDays(new Date(dd.due_date), new Date());
    return d < 0 ? 'overdue' : d <= 7 ? 'upcoming' : 'pending';
  }, []);

  const fetchCal = useCallback(async () => {
    setCalLoading(true);
    try { const r = await api.get('/duedates'); setDueDates(Array.isArray(r.data) ? r.data : []); }
    catch {}
    finally { setCalLoading(false); }
  }, []);

  useEffect(() => { fetchCal(); }, [fetchCal]);

  const calStats = useMemo(() => ({
    total:     dueDates.length,
    upcoming:  dueDates.filter(d => { const x = differenceInDays(new Date(d.due_date), new Date()); return d.status !== 'completed' && x >= 0 && x <= 7; }).length,
    pending:   dueDates.filter(d => { const x = differenceInDays(new Date(d.due_date), new Date()); return d.status !== 'completed' && x > 7; }).length,
    overdue:   dueDates.filter(d => { const x = differenceInDays(new Date(d.due_date), new Date()); return d.status !== 'completed' && x < 0; }).length,
    completed: dueDates.filter(d => d.status === 'completed').length,
  }), [dueDates]);

  // Group due dates by "YYYY-MM-DD" key for fast calendar lookup
  const dateMap = useMemo(() => {
    const m = {};
    dueDates.forEach(dd => {
      const key = dd.due_date ? String(dd.due_date).slice(0, 10) : null;
      if (!key) return;
      if (!m[key]) m[key] = [];
      m[key].push(dd);
    });
    return m;
  }, [dueDates]);

  // Filtered list for the sidebar (search + status filter)
  const filteredCal = useMemo(() => dueDates.filter(dd => {
    const mq  = !calSearch || dd.title.toLowerCase().includes(calSearch.toLowerCase());
    const mst = calFilter === 'all' || getCalStatus(dd) === calFilter;
    return mq && mst;
  }), [dueDates, calSearch, calFilter, getCalStatus]);

  // Due dates for current viewed month (for sidebar when no filter active)
  const monthDueDates = useMemo(() => {
    return dueDates.filter(dd => {
      if (!dd.due_date) return false;
      const d = new Date(dd.due_date);
      return d.getFullYear() === viewYear && d.getMonth() === viewMonth;
    }).sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  }, [dueDates, viewYear, viewMonth]);

  const displayList = clickedDate
    ? (dateMap[clickedDate] || [])
    : calSearch || calFilter !== 'all' ? filteredCal : monthDueDates;

  const handleSaveCal = async () => {
    if (!calForm.title || !calForm.due_date) { toast.error('Title and due date are required'); return; }
    setSavingCal(true);
    try {
      await api.post('/duedates', { ...calForm, due_date: new Date(calForm.due_date).toISOString(), reminder_days: 30 });
      toast.success('Due date added!');
      setShowAddCal(false);
      setCalForm({ title:'', due_date:'', category:'Other', department:'OTHER', status:'pending', description:'' });
      fetchCal();
    } catch { toast.error('Failed to save due date'); }
    finally { setSavingCal(false); }
  };

  const handleMarkDone = async (dd) => {
    try {
      await api.put(`/duedates/${dd.id}`, { ...dd, status: 'completed', due_date: new Date(dd.due_date).toISOString() });
      fetchCal();
      toast.success('Marked as completed');
    } catch { toast.error('Failed to update'); }
  };

  const handleSaveQuick = async () => {
    if (!quickForm.title || !clickedDate) { toast.error('Title is required'); return; }
    setSavingQuick(true);
    try {
      await api.post('/duedates', {
        title: quickForm.title,
        due_date: new Date(clickedDate).toISOString(),
        category: quickForm.category,
        department: 'OTHER',
        status: 'pending',
        description: quickForm.description || '',
        reminder_days: 30,
      });
      toast.success('Due date added!');
      setClickedDate(null);
      setQuickForm({ title:'', category:'Other', description:'' });
      fetchCal();
    } catch { toast.error('Failed to save due date'); }
    finally { setSavingQuick(false); }
  };

  // Build calendar grid cells
  const firstDayOfMonth = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth     = new Date(viewYear, viewMonth + 1, 0).getDate();
  const today           = new Date();
  const cells = [];
  for (let i = 0; i < firstDayOfMonth; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const prevMonth = () => { if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); } else setViewMonth(m => m - 1); };
  const nextMonth = () => { if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); } else setViewMonth(m => m + 1); };
  const goToday   = () => { setViewYear(today.getFullYear()); setViewMonth(today.getMonth()); };

  const STATUS_DOT_COLOR = { overdue: '#EF4444', upcoming: '#F59E0B', pending: '#94a3b8', completed: '#1FAF5A' };

  return (
    <motion.div variants={itemVariants} className="rounded-2xl border overflow-hidden"
      style={{ backgroundColor: isDark ? D.card : '#fff', borderColor: isDark ? D.border : '#e2e8f0' }}>

      {/* Panel Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b cursor-pointer select-none"
        style={{ backgroundColor: isDark ? D.raised : '#f8fafc', borderColor: isDark ? D.border : '#e2e8f0' }}
        onClick={() => setCollapsed(c => !c)}>
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-lg" style={{ backgroundColor: isDark ? 'rgba(31,111,178,0.2)' : '#dbeafe' }}>
            <Calendar className="w-4 h-4" style={{ color: '#1F6FB2' }} />
          </div>
          <div>
            <h3 className="font-bold text-sm" style={{ color: isDark ? D.text : '#0f172a' }}>Compliance Calendar</h3>
            <p className="text-[11px]" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>
              {calStats.total} deadlines · {calStats.overdue > 0
                ? <span style={{ color: '#EF4444' }}>{calStats.overdue} overdue</span>
                : 'none overdue'} · {calStats.upcoming} due soon
            </p>
          </div>
          {calStats.overdue > 0 && (
            <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full bg-red-500 text-white">{calStats.overdue}</span>
          )}
        </div>
        <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
          <button onClick={fetchCal} className="p-1.5 rounded-lg hover:opacity-70" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>
            <RefreshCw className={`w-3.5 h-3.5 ${calLoading ? 'animate-spin' : ''}`} />
          </button>
          <ChevronDown className={`w-4 h-4 transition-transform ${collapsed ? '-rotate-90' : ''}`}
            style={{ color: isDark ? D.dimmer : '#94a3b8' }} />
        </div>
      </div>

      <AnimatePresence>
        {!collapsed && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}>

            {/* Stats row */}
            <div className="grid grid-cols-5 border-b" style={{ borderColor: isDark ? D.border : '#f1f5f9' }}>
              {[
                { label: 'Total',     val: calStats.total,     color: '#1F6FB2', status: 'all'       },
                { label: 'Upcoming',  val: calStats.upcoming,  color: '#3B82F6', status: 'upcoming'  },
                { label: 'Pending',   val: calStats.pending,   color: '#F59E0B', status: 'pending'   },
                { label: 'Overdue',   val: calStats.overdue,   color: '#EF4444', status: 'overdue'   },
                { label: 'Completed', val: calStats.completed, color: '#1FAF5A', status: 'completed' },
              ].map((s, i) => (
                <button key={s.status} onClick={() => setCalFilter(f => f === s.status ? 'all' : s.status)}
                  className="flex flex-col items-center py-2.5 transition-all hover:opacity-80"
                  style={{
                    backgroundColor: calFilter === s.status ? `${s.color}12` : 'transparent',
                    borderRight: i < 4 ? `1px solid ${isDark ? D.border : '#f1f5f9'}` : 'none',
                  }}>
                  <span className="text-lg font-black tabular-nums" style={{ color: s.color }}>{s.val}</span>
                  <span className="text-[10px] font-semibold" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>{s.label}</span>
                </button>
              ))}
            </div>

            {/* ── CALENDAR GRID + SIDEBAR ── */}
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px]" style={{ minHeight: 340 }}>

              {/* LEFT: Calendar Grid */}
              <div className="border-r" style={{ borderColor: isDark ? D.border : '#f1f5f9' }}>

                {/* Month navigation */}
                <div className="flex items-center justify-between px-4 py-2.5 border-b"
                  style={{ borderColor: isDark ? D.border : '#f1f5f9', backgroundColor: isDark ? D.raised : '#fafafa' }}>
                  <button onClick={prevMonth}
                    className="w-7 h-7 rounded-lg flex items-center justify-center hover:opacity-70 transition-opacity border"
                    style={{ backgroundColor: isDark ? D.card : '#fff', borderColor: isDark ? D.border : '#e2e8f0', color: isDark ? D.muted : '#64748b' }}>
                    <ChevronLeft className="w-4 h-4" />
                  </button>

                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm" style={{ color: isDark ? D.text : '#0f172a' }}>
                      {MONTH_NAMES[viewMonth]} {viewYear}
                    </span>
                    <button onClick={goToday}
                      className="px-2 py-0.5 rounded-md text-[10px] font-bold border transition-all hover:opacity-80"
                      style={{ backgroundColor: isDark ? 'rgba(31,111,178,0.15)' : '#eff6ff', borderColor: '#1F6FB230', color: '#1F6FB2' }}>
                      Today
                    </button>
                  </div>

                  <button onClick={nextMonth}
                    className="w-7 h-7 rounded-lg flex items-center justify-center hover:opacity-70 transition-opacity border"
                    style={{ backgroundColor: isDark ? D.card : '#fff', borderColor: isDark ? D.border : '#e2e8f0', color: isDark ? D.muted : '#64748b' }}>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>

                {/* Day headers */}
                <div className="grid grid-cols-7 border-b" style={{ borderColor: isDark ? D.border : '#f1f5f9' }}>
                  {DAY_NAMES.map(d => (
                    <div key={d} className="text-center py-1.5 text-[10px] font-black uppercase tracking-wider"
                      style={{ color: isDark ? D.dimmer : '#94a3b8' }}>{d}</div>
                  ))}
                </div>

                {/* Calendar cells */}
                <div className="grid grid-cols-7">
                  {cells.map((day, idx) => {
                    if (!day) return (
                      <div key={`empty-${idx}`} className="min-h-[60px] border-b border-r"
                        style={{ borderColor: isDark ? D.border + '60' : '#f1f5f9' }} />
                    );

                    const mm  = String(viewMonth + 1).padStart(2, '0');
                    const dd  = String(day).padStart(2, '0');
                    const key = `${viewYear}-${mm}-${dd}`;
                    const events = dateMap[key] || [];
                    const isToday = today.getFullYear() === viewYear && today.getMonth() === viewMonth && today.getDate() === day;
                    const isWeekend = (idx % 7 === 0) || (idx % 7 === 6);
                    const isClickedDate = clickedDate === key;

                    return (
                      <div key={key}
                        className="min-h-[60px] border-b border-r p-1 flex flex-col gap-0.5 transition-all cursor-pointer group/cell"
                        title={`Click to add compliance on ${key}`}
                        onClick={() => {
                          setClickedDate(key);
                          setQuickForm({ title:'', category:'Other', description:'' });
                        }}
                        style={{
                          borderColor: isDark ? D.border + '60' : '#f1f5f9',
                          backgroundColor: isClickedDate
                            ? isDark ? 'rgba(31,111,178,0.22)' : '#dbeafe'
                            : isToday
                            ? isDark ? 'rgba(31,111,178,0.12)' : '#eff6ff'
                            : isWeekend
                            ? isDark ? 'rgba(255,255,255,0.01)' : '#fafafa'
                            : 'transparent',
                          outline: isClickedDate ? '2px solid #1F6FB2' : 'none',
                          outlineOffset: '-1px',
                        }}>
                        {/* Day number row */}
                        <div className="flex items-center justify-between">
                          <span className={`text-[11px] font-bold w-5 h-5 flex items-center justify-center rounded-full ${
                            isToday ? 'bg-blue-600 text-white' : ''
                          }`}
                            style={{ color: isToday ? '#fff' : isWeekend ? (isDark ? '#64748b' : '#94a3b8') : (isDark ? D.muted : '#475569') }}>
                            {day}
                          </span>
                          {/* + button on hover */}
                          <span
                            className="opacity-0 group-hover/cell:opacity-100 transition-opacity w-4 h-4 rounded flex items-center justify-center text-[10px] font-black"
                            style={{ backgroundColor: '#1F6FB220', color: '#1F6FB2' }}>
                            +
                          </span>
                        </div>

                        {/* Event chips */}
                        <div className="flex flex-col gap-0.5 overflow-hidden">
                          {events.slice(0, 2).map(ev => {
                            const evStatus = getCalStatus(ev);
                            const chipColor = evStatus === 'overdue' ? '#EF4444' : evStatus === 'upcoming' ? '#F59E0B' : evStatus === 'completed' ? '#1FAF5A' : '#1F6FB2';
                            return (
                              <div key={ev.id}
                                title={ev.title}
                                className="truncate text-[9px] font-bold px-1 py-0.5 rounded"
                                style={{ backgroundColor: `${chipColor}18`, color: chipColor, lineHeight: '1.2' }}>
                                {ev.title}
                              </div>
                            );
                          })}
                          {events.length > 2 && (
                            <div className="text-[9px] font-bold px-1" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>
                              +{events.length - 2} more
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Legend + hint */}
                <div className="flex items-center justify-between px-4 py-2 border-t" style={{ borderColor: isDark ? D.border : '#f1f5f9' }}>
                  <div className="flex items-center gap-4">
                  {[
                    { color: '#EF4444', label: 'Overdue'   },
                    { color: '#F59E0B', label: 'Due soon'  },
                    { color: '#1F6FB2', label: 'Pending'   },
                    { color: '#1FAF5A', label: 'Completed' },
                  ].map(l => (
                    <div key={l.label} className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: `${l.color}80` }} />
                      <span className="text-[10px] font-semibold" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>{l.label}</span>
                    </div>
                  ))}
                  </div>
                  <span className="text-[10px] font-semibold flex items-center gap-1" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>
                    <Plus className="w-3 h-3" /> Click any date to add
                  </span>
                </div>
              </div>

              {/* RIGHT: Sidebar — due dates for current month (or filtered) */}
              <div className="flex flex-col">
                {/* Sidebar search + filter */}
                <div className="px-3 py-2 border-b space-y-1.5" style={{ borderColor: isDark ? D.border : '#f1f5f9' }}>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3" style={{ color: isDark ? D.dimmer : '#94a3b8' }} />
                    <input value={calSearch} onChange={e => setCalSearch(e.target.value)} placeholder="Search…"
                      className="w-full pl-7 pr-3 py-1.5 border rounded-lg text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-500"
                      style={{ backgroundColor: isDark ? D.raised : '#fff', borderColor: isDark ? D.border : '#e2e8f0', color: isDark ? D.text : '#1e293b' }} />
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {['all','upcoming','overdue','pending','completed'].map(s => (
                      <button key={s} onClick={() => setCalFilter(f => f === s ? 'all' : s)}
                        className="px-2 py-0.5 rounded text-[10px] font-bold border capitalize transition-all"
                        style={{
                          backgroundColor: calFilter === s ? '#1F6FB215' : 'transparent',
                          borderColor:     calFilter === s ? '#1F6FB2' : (isDark ? D.border : '#e2e8f0'),
                          color:           calFilter === s ? '#1F6FB2' : (isDark ? D.dimmer : '#64748b'),
                        }}>
                        {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Sidebar heading */}
                <div className="px-3 py-1.5 border-b flex items-center justify-between" style={{ borderColor: isDark ? D.border : '#f1f5f9', backgroundColor: isDark ? D.raised + '80' : '#fafafa' }}>
                  <p className="text-[10px] font-black uppercase tracking-wider" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>
                    {clickedDate
                      ? (() => { try { const [y,m,d]=clickedDate.split('-'); return new Date(Number(y),Number(m)-1,Number(d)).toLocaleDateString('en-IN',{day:'numeric',month:'short'}); } catch { return clickedDate; } })() + ` — ${(dateMap[clickedDate]||[]).length} event${(dateMap[clickedDate]||[]).length!==1?'s':''}`
                      : calSearch || calFilter !== 'all'
                      ? `${filteredCal.length} matching`
                      : `${MONTH_NAMES[viewMonth]} — ${monthDueDates.length} deadline${monthDueDates.length !== 1 ? 's' : ''}`}
                  </p>
                  {clickedDate && (
                    <button onClick={() => setClickedDate(null)} className="text-[10px] font-bold hover:opacity-70 flex items-center gap-0.5" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>
                      <X className="w-2.5 h-2.5" /> Clear
                    </button>
                  )}
                </div>

                {/* Sidebar list */}
                <div className="flex-1 overflow-y-auto" style={{ maxHeight: 340, scrollbarWidth: 'thin' }}>
                  {calLoading && dueDates.length === 0 ? (
                    <div className="flex items-center justify-center py-10">
                      <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
                    </div>
                  ) : displayList.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 gap-2">
                      <Calendar className="w-6 h-6" style={{ color: isDark ? D.border : '#d1d5db' }} />
                      <p className="text-[11px] font-semibold text-center px-3" style={{ color: isDark ? D.muted : '#94a3b8' }}>
                        {clickedDate ? 'No events on this date' : calSearch || calFilter !== 'all' ? 'No matching due dates' : `No deadlines in ${MONTH_NAMES[viewMonth]}`}
                      </p>
                      {clickedDate && (
                        <button
                          onClick={() => { /* already open via state */ }}
                          className="flex items-center gap-1 text-[11px] font-bold px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
                          style={{ backgroundColor: '#1F6FB215', color: '#1F6FB2', border: '1px solid #1F6FB230' }}>
                          <Plus className="w-3 h-3" /> Add compliance for this date
                        </button>
                      )}
                    </div>
                  ) : displayList.map(dd => {
                    const ds = getCalStatus(dd);
                    const dLeft = differenceInDays(new Date(dd.due_date), new Date());
                    const dotColor = STATUS_DOT_COLOR[ds];
                    const sty = CAL_STATUS_STYLES[ds];
                    return (
                      <div key={dd.id}
                        className="flex items-start gap-2.5 px-3 py-2.5 border-b hover:opacity-90 transition-opacity"
                        style={{ borderColor: isDark ? D.border + '60' : '#f1f5f9' }}>
                        <div className="flex-shrink-0 mt-1 w-1.5 h-1.5 rounded-full" style={{ backgroundColor: dotColor }} />
                        <div className="flex-1 min-w-0">
                          <p className={`text-[11px] font-semibold truncate ${isDark ? 'text-slate-200' : 'text-slate-800'} ${ds === 'completed' ? 'line-through opacity-50' : ''}`}>
                            {dd.title}
                          </p>
                          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                            <span className="text-[10px]" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>
                              {format(new Date(dd.due_date), 'dd MMM')}
                            </span>
                            <span className={`inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${sty.bg} ${sty.text} ${sty.border}`}>
                              <span className={`w-1 h-1 rounded-full ${sty.dot}`} />{sty.label}
                            </span>
                            {dd.category && (
                              <span className="text-[9px] font-bold px-1 py-0.5 rounded" style={{ background: '#1F6FB215', color: '#1F6FB2' }}>{dd.category}</span>
                            )}
                          </div>
                        </div>
                        <div className="flex-shrink-0 flex flex-col items-end gap-1">
                          <span className={`text-[10px] font-bold tabular-nums ${dLeft < 0 ? 'text-red-500' : dLeft <= 7 ? 'text-amber-500' : (isDark ? 'text-slate-500' : 'text-slate-400')}`}>
                            {dd.status === 'completed' ? '✓' : dLeft < 0 ? `${Math.abs(dLeft)}d over` : `${dLeft}d`}
                          </span>
                          {dd.status !== 'completed' && (user?.role === 'admin' || user?.role === 'manager') && (
                            <button onClick={() => handleMarkDone(dd)}
                              className="p-0.5 rounded hover:bg-emerald-50 text-slate-300 hover:text-emerald-600 transition-colors" title="Mark done">
                              <CheckCircle2 className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Sidebar footer */}
                <div className="px-3 py-2 border-t flex items-center justify-between"
                  style={{ borderColor: isDark ? D.border : '#f1f5f9', backgroundColor: isDark ? D.raised + '80' : '#fafafa' }}>
                  <span className="text-[10px]" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>
                    {dueDates.length} total
                  </span>
                  <div className="flex items-center gap-2">
                    {clickedDate && (
                      <button
                        onClick={() => { /* Quick add modal already open */ }}
                        className="flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-lg transition-all hover:opacity-80"
                        style={{ backgroundColor: '#1F6FB215', color: '#1F6FB2', border: '1px solid #1F6FB230' }}>
                        <Plus className="w-3 h-3" /> Add for this date
                      </button>
                    )}
                    {(calFilter !== 'all' || calSearch) && (
                      <button onClick={() => { setCalFilter('all'); setCalSearch(''); }}
                        className="flex items-center gap-0.5 text-[10px] font-semibold text-red-500 hover:text-red-700">
                        <X className="w-2.5 h-2.5" /> Clear
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

          </motion.div>
        )}
      </AnimatePresence>

      {/* Add Due Date Modal — triggered from banner button */}
      <AnimatePresence>
        {showAddCal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ backgroundColor: 'rgba(6,78,59,0.4)' }}
            onClick={() => setShowAddCal(false)}>
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-md max-h-[92vh] overflow-y-auto overflow-x-hidden rounded-2xl border shadow-2xl p-6 space-y-4"
              style={{ backgroundColor: isDark ? D.card : '#fff', borderColor: isDark ? D.border : '#e2e8f0' }}
              onClick={e => e.stopPropagation()}>
              <PopupHeader className="-mx-6 -mt-6" icon={Calendar} eyebrow="Compliance calendar" title="Add New Due Date" titleAs="h3" onClose={() => setShowAddCal(false)} />
              <div className="space-y-3">
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wider block mb-1" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>Title *</label>
                  <input value={calForm.title} onChange={e => setCalForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g. GST Return Q4"
                    className="w-full px-3 py-2 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    style={{ backgroundColor: isDark ? D.raised : '#fff', borderColor: isDark ? D.border : '#e2e8f0', color: isDark ? D.text : '#1e293b' }} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wider block mb-1" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>Due Date *</label>
                    <input type="date" value={calForm.due_date} onChange={e => setCalForm(f => ({ ...f, due_date: e.target.value }))}
                      className="w-full px-3 py-2 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      style={{ backgroundColor: isDark ? D.raised : '#fff', borderColor: isDark ? D.border : '#e2e8f0', color: isDark ? D.text : '#1e293b' }} />
                  </div>
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wider block mb-1" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>Category</label>
                    <select value={calForm.category} onChange={e => setCalForm(f => ({ ...f, category: e.target.value }))}
                      className="w-full px-3 py-2 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      style={{ backgroundColor: isDark ? D.raised : '#fff', borderColor: isDark ? D.border : '#e2e8f0', color: isDark ? D.text : '#1e293b' }}>
                      {['GST','Income Tax','TDS','ROC','Audit','Trademark','RERA','FEMA','Other'].map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wider block mb-1" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>Description</label>
                  <textarea value={calForm.description} onChange={e => setCalForm(f => ({ ...f, description: e.target.value }))} rows={2} placeholder="Optional notes…"
                    className="w-full px-3 py-2 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                    style={{ backgroundColor: isDark ? D.raised : '#fff', borderColor: isDark ? D.border : '#e2e8f0', color: isDark ? D.text : '#1e293b' }} />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setShowAddCal(false)} className="px-4 py-2 rounded-xl text-sm font-semibold border"
                  style={{ borderColor: isDark ? D.border : '#e2e8f0', color: isDark ? D.muted : '#64748b' }}>Cancel</button>
                <button onClick={handleSaveCal} disabled={savingCal || !calForm.title || !calForm.due_date}
                  className="px-5 py-2 rounded-xl text-sm font-bold text-white disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg,#0D3B66,#1F6FB2)' }}>
                  {savingCal ? 'Saving…' : 'Add Due Date'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Quick-Add modal: triggered by clicking a calendar date ── */}
      <AnimatePresence>
        {clickedDate && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center p-4"
            style={{ backgroundColor: 'rgba(6,78,59,0.5)', backdropFilter: 'blur(4px)' }}
            onClick={() => setClickedDate(null)}>
            <motion.div
              initial={{ scale: 0.93, y: 16, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.93, y: 16, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 260, damping: 22 }}
              className="w-full max-w-sm rounded-2xl border shadow-2xl overflow-hidden"
              style={{ backgroundColor: isDark ? D.card : '#fff', borderColor: isDark ? D.border : '#e2e8f0' }}
              onClick={e => e.stopPropagation()}>
              {/* Header */}
              <div className="px-5 py-4 text-white flex items-center justify-between"
                style={{ background: 'linear-gradient(135deg,#0D3B66,#1F6FB2)' }}>
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 bg-white/20 rounded-xl flex items-center justify-center flex-shrink-0">
                    <Calendar className="w-4 h-4 text-white" />
                  </div>
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-blue-200 mb-0.5">Add Compliance</p>
                    <h3 className="text-base font-black">
                      {(() => {
                        try {
                          const [y, m, d] = clickedDate.split('-');
                          return new Date(Number(y), Number(m)-1, Number(d)).toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });
                        } catch { return clickedDate; }
                      })()}
                    </h3>
                  </div>
                </div>
                <button onClick={() => setClickedDate(null)} className="w-8 h-8 rounded-xl bg-white/20 hover:bg-white/30 flex items-center justify-center">
                  <X className="w-4 h-4 text-white" />
                </button>
              </div>

              {/* Body */}
              <div className="p-5 space-y-4">
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wider block mb-1.5" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>Title *</label>
                  <input
                    autoFocus
                    value={quickForm.title}
                    onChange={e => setQuickForm(f => ({ ...f, title: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter' && quickForm.title) handleSaveQuick(); }}
                    placeholder="e.g. GST Return Q4, FORM 11…"
                    className="w-full px-3.5 py-2.5 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                    style={{ backgroundColor: isDark ? D.raised : '#fff', borderColor: isDark ? D.border : '#d1d5db', color: isDark ? D.text : '#1e293b' }} />
                </div>
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wider block mb-1.5" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>Category</label>
                  <select value={quickForm.category} onChange={e => setQuickForm(f => ({ ...f, category: e.target.value }))}
                    className="w-full px-3.5 py-2.5 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                    style={{ backgroundColor: isDark ? D.raised : '#fff', borderColor: isDark ? D.border : '#d1d5db', color: isDark ? D.text : '#1e293b' }}>
                    {['GST','Income Tax','TDS','ROC','Audit','Trademark','RERA','FEMA','Other'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wider block mb-1.5" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>Notes (optional)</label>
                  <textarea value={quickForm.description} onChange={e => setQuickForm(f => ({ ...f, description: e.target.value }))}
                    rows={2} placeholder="Any notes…"
                    className="w-full px-3.5 py-2.5 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none transition-all"
                    style={{ backgroundColor: isDark ? D.raised : '#fff', borderColor: isDark ? D.border : '#d1d5db', color: isDark ? D.text : '#1e293b' }} />
                </div>
              </div>

              {/* Footer */}
              <div className="px-5 py-4 border-t flex items-center justify-between"
                style={{ borderColor: isDark ? D.border : '#f1f5f9', backgroundColor: isDark ? D.raised : '#f8fafc' }}>
                <button onClick={() => setClickedDate(null)}
                  className="px-4 py-2 rounded-xl text-sm font-semibold border transition-all hover:opacity-80"
                  style={{ borderColor: isDark ? D.border : '#e2e8f0', color: isDark ? D.muted : '#64748b', backgroundColor: 'transparent' }}>
                  Cancel
                </button>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setShowAddCal(true);
                      setCalForm(f => ({ ...f, due_date: clickedDate, title: quickForm.title, category: quickForm.category, description: quickForm.description }));
                      setClickedDate(null);
                    }}
                    className="px-4 py-2 rounded-xl text-sm font-semibold border transition-all hover:opacity-80"
                    style={{ borderColor: isDark ? 'rgba(31,111,178,0.4)' : '#bfdbfe', color: '#1F6FB2', backgroundColor: isDark ? 'rgba(31,111,178,0.1)' : '#eff6ff' }}>
                    More Options
                  </button>
                  <button onClick={handleSaveQuick} disabled={savingQuick || !quickForm.title}
                    className="px-5 py-2 rounded-xl text-sm font-bold text-white disabled:opacity-50 flex items-center gap-2 transition-all hover:shadow-md"
                    style={{ background: 'linear-gradient(135deg,#0D3B66,#1F6FB2)' }}>
                    {savingQuick ? <><Loader2 className="w-4 h-4 animate-spin" />Saving…</> : <><CheckCircle2 className="w-4 h-4" />Add</>}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────
const COMPLIANCE_SECTIONS = ['banner', 'stats', 'filters', 'content'];
const COMPLIANCE_LABELS   = {
  banner:  { name: 'Header Banner',    icon: '🏷️', desc: 'Title, back button and status' },
  stats:   { name: 'Stats Cards',      icon: '📊', desc: 'Total / overdue / completed counts' },
  filters: { name: 'Filters & Search', icon: '🔍', desc: 'Search box and category filters' },
  content: { name: 'Compliance Grid',  icon: '📋', desc: 'Client list and compliance calendar' },
};

export default function CompliancePage(){
  const isDark=useDark();
  const{user,hasPermission}=useAuth();
  const isAdmin = user?.role === 'admin';
  const canManage = isAdmin || hasPermission('can_manage_compliance');
  const { order: cpOrder, moveSection: cpMove, resetOrder: cpReset } = usePageLayout('compliance', COMPLIANCE_SECTIONS);
  const [showLayoutCustomizer, setShowLayoutCustomizer] = useState(false);
  // Categories this user is allowed to see (null = all, for admin)
  const [allowedCategories, setAllowedCategories] = useState(null); // populated from dashboard response

  const[compliance,setCompliance]=useState([]);
  const[dashboard,setDashboard]=useState(null);
  const[loading,setLoading]=useState(true);
  const[allUsers,setAllUsers]=useState([]);
  const[catFilter,setCatFilter]=useState('all');
  const[fyFilter,setFyFilter]=useState('all');
  const[searchQ,setSearchQ]=useState('');
  const[showAddModal,setShowAddModal]=useState(false);
  const[editingItem,setEditingItem]=useState(null);
  const[detailItem,setDetailItem]=useState(null);
  const[refreshKey,setRefreshKey]=useState(0);
  const[viewMode,setViewMode]=useState('board'); // 'board' | 'list'
  const[compliancePage,setCompliancePage]=useState(1);
  const[compliancePageSize,setCompliancePageSize]=useState(25);
  // AI Duplicate Detection
  const [showDupDialog,  setShowDupDialog]  = useState(false);
  const [dupGroups,      setDupGroups]      = useState([]);
  const [detectingDups,  setDetectingDups]  = useState(false);
  // Calendar "Add Due Date" modal — lifted from panel so banner button can trigger it
  const [showAddCal,     setShowAddCal]     = useState(false);

  // ── Top-level page view: compliance types vs standalone Govt Fees ──
  const [pageView,        setPageView]        = useState('compliance'); // 'compliance' | 'govtfees'
  const [adhocFees,       setAdhocFees]       = useState([]);
  const [adhocFeesLoading,setAdhocFeesLoading]= useState(false);
  const [showAdhocDialog, setShowAdhocDialog] = useState(false);
  const [editingAdhoc,    setEditingAdhoc]    = useState(null);
  const [editingLinkedFee, setEditingLinkedFee] = useState(null); // linked fee row being edited
  const [savingLinkedFee, setSavingLinkedFee] = useState(false);
  const [adhocClients,    setAdhocClients]    = useState([]);
  const [adhocSearch,     setAdhocSearch]     = useState('');
  // ── Govt Fees sub-tab: 'direct' (standalone only) | 'all' (standalone + compliance-linked) ──
  const [govtFeesSubTab,  setGovtFeesSubTab]  = useState('direct'); // 'direct' | 'all'
  // ── Govt Fees advanced filters ──
  const [gfFormFilter,    setGfFormFilter]    = useState('all');    // category/form filter
  const [gfEntityFilter,  setGfEntityFilter]  = useState('all');    // entity type filter
  const [gfDateMode,      setGfDateMode]      = useState('all');    // 'all'|'month'|'year'|'custom'
  const [gfMonth,         setGfMonth]         = useState('');       // "YYYY-MM"
  const [gfYear,          setGfYear]          = useState('');       // "YYYY"
  const [gfDateFrom,      setGfDateFrom]      = useState('');       // "YYYY-MM-DD"
  const [gfDateTo,        setGfDateTo]        = useState('');       // "YYYY-MM-DD"
  // ── Compliance-linked fees for "All Payments" sub-tab ──
  const [linkedFees,      setLinkedFees]      = useState([]);
  const [linkedFeesLoading,setLinkedFeesLoading] = useState(false);

  const fetchAdhocFees = useCallback(async () => {
    // Guard: never call API without auth token
    const token = localStorage.getItem('token') || sessionStorage.getItem('token');
    if (!token) return;
    setAdhocFeesLoading(true);
    try {
      const r = await api.get('/compliance/standalone-govt-fees');
      const data = r?.data;
      // Be defensive about response shape — sometimes backend returns
      // {items:[...]}, sometimes a bare array. Either way we keep data on screen.
      const items = Array.isArray(data)
        ? data
        : (data?.items || data?.fees || data?.results || []);
      setAdhocFees(items);
    } catch (e) {
      console.error('Failed to load govt fees:', e);
      // Do NOT clear adhocFees — keep stale data on screen
    } finally {
      setAdhocFeesLoading(false);
    }
  }, []);

  // Fetch compliance-linked govt fee payments (assignments that have govt_fees_amount > 0)
  const fetchLinkedFees = useCallback(async () => {
    // Guard: never call API without auth token
    const token = localStorage.getItem('token') || sessionStorage.getItem('token');
    if (!token) return;
    setLinkedFeesLoading(true);
    try {
      // Pull all compliance masters (flagged as govt_fees=true)
      const mastersRes = await api.get('/compliance', { params: { page_size: 5000 } });
      const masters = Array.isArray(mastersRes.data) ? mastersRes.data : [];
      const govtFeesMasters = masters.filter(m => m.govt_fees);
      if (!govtFeesMasters.length) { setLinkedFees([]); setLinkedFeesLoading(false); return; }

      // For each govt-fee master, fetch its assignments in parallel
      const allItems = [];
      await Promise.all(govtFeesMasters.map(async master => {
        try {
          const r = await api.get(`/compliance/${master.id}/assignments`, { params: { limit: 1000 } });
          // Response shape: {total, page, limit, items:[...]} or bare array
          const asgns = Array.isArray(r.data) ? r.data : (r.data?.items || []);
          asgns.forEach(a => {
            const feeAmt = parseFloat(a.govt_fees_amount || 0);
            if (feeAmt > 0) {
              allItems.push({
                id: `linked-${a.id}`,           // unique key (avoid collisions with standalone)
                assignment_id: a.id,
                compliance_id: master.id,
                title: master.name,
                client_id: a.client_id,
                client_name: a.client_name || '',  // stored at assignment creation time
                category: master.category,
                entity_type: a.entity_type || '',
                fy_year: a.fy_year || master.fy_year || '',
                period_label: master.period_label || '',
                due_date: a.due_date || master.due_date || null,
                status: a.status || 'not_started',
                amount: feeAmt,
                srn: a.govt_fees_srn || '',
                notes: a.govt_fees_notes || '',
                payment_date: a.payment_date || a.paid_on || null,
                _source: 'linked',
              });
            }
          });
        } catch (err) {
          // Silently skip masters we can't fetch (permission-scoped users)
          console.warn(`Could not fetch assignments for compliance ${master.id}:`, err?.response?.status);
        }
      }));
      setLinkedFees(allItems);
    } catch (e) {
      console.error('Failed to load linked fees:', e);
    } finally {
      setLinkedFeesLoading(false);
    }
  }, []);

  // Pre-fetch standalone fees whenever user is authenticated and on the govtfees tab.
  // NO mount-only effect — that fires before the auth token is set → 401 errors.
  // The user?.id dep ensures re-fetch when auth session is restored after page load.
  useEffect(() => {
    if (!user) return; // wait for auth to resolve before any API call
    if (pageView !== 'govtfees') return;
    fetchAdhocFees();
    fetchLinkedFees();
    if (!adhocClients.length) {
      // Backend caps page_size at 500 (server.py: le=500) — requesting 2000
      // in one call gets a silent 422 rejection. Page through in chunks of
      // 500 instead to reliably fetch the full client list.
      (async () => {
        const PAGE_SIZE = 500;
        let page = 1;
        let all = [];
        try {
          while (true) {
            const r = await api.get('/clients', { params: { page, page_size: PAGE_SIZE } });
            const batch = r.data?.clients || r.data || [];
            all = all.concat(batch);
            if (batch.length < PAGE_SIZE) break; // last page
            page += 1;
          }
          setAdhocClients(all.map(c => ({ id: c.id, name: c.company_name || c.name })));
        } catch (err) {
          console.error('Failed to load clients for Govt Fee dialog:', err?.response?.status, err?.response?.data);
          toast.error('Could not load client list — please refresh and try again');
          setAdhocClients([]);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageView, refreshKey, user?.id]);

  const handleDeleteAdhoc = async (fee) => {
    if (!window.confirm(`Delete "${fee.title}"?`)) return;
    try {
      await api.delete(`/compliance/standalone-govt-fees/${fee.id}`);
      toast.success('Government fee deleted');
      setAdhocFees(prev => prev.filter(f => f.id !== fee.id));
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Delete failed');
    }
  };

  // Entity types commonly used in Indian CA practice
  const ENTITY_TYPES = [
    { value: 'pvt_ltd',    label: 'Private Ltd (Pvt Ltd)' },
    { value: 'pub_ltd',    label: 'Public Ltd' },
    { value: 'llp',        label: 'LLP' },
    { value: 'opc',        label: 'OPC' },
    { value: 'partnership',label: 'Partnership' },
    { value: 'proprietorship', label: 'Proprietorship' },
    { value: 'trust',      label: 'Trust / NGO' },
    { value: 'huf',        label: 'HUF' },
    { value: 'individual', label: 'Individual' },
    { value: 'other',      label: 'Other' },
  ];

  // Shared date-range filter helper
  const applyDateFilter = (fee) => {
    const dateStr = fee.payment_date || fee.paid_on || fee.paid_at || fee.due_date;
    if (!dateStr) return gfDateMode === 'all';
    const d = safeDate(String(dateStr).slice(0, 10));
    if (!d) return gfDateMode === 'all';
    if (gfDateMode === 'month' && gfMonth) {
      const [y, m] = gfMonth.split('-');
      return d.getFullYear() === Number(y) && d.getMonth() + 1 === Number(m);
    }
    if (gfDateMode === 'year' && gfYear) {
      return d.getFullYear() === Number(gfYear);
    }
    if (gfDateMode === 'custom') {
      const from = gfDateFrom ? safeDate(gfDateFrom) : null;
      const to   = gfDateTo   ? safeDate(gfDateTo)   : null;
      if (from && d < from) return false;
      if (to   && d > to  ) return false;
      return true;
    }
    return true;
  };

  // Shared field-filter helper (form + entity)
  const applyFieldFilters = (fee) => {
    if (gfFormFilter !== 'all' && fee.category !== gfFormFilter) return false;
    if (gfEntityFilter !== 'all' && (fee.entity_type || '') !== gfEntityFilter) return false;
    return true;
  };

  // Robust, multi-token search across every meaningful field.
  // Each whitespace-separated token must match somewhere — order-independent.
  const filteredAdhoc = useMemo(() => {
    const list = adhocFees || [];
    const q = adhocSearch.trim().toLowerCase();
    const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
    return list.filter(f => {
      if (!applyFieldFilters(f)) return false;
      if (!applyDateFilter(f)) return false;
      if (!tokens.length) return true;
      const hay = [
        f.title, f.client_name, f.srn, f.category,
        CATEGORY_CFG[f.category]?.label, f.status, f.notes,
        f.fy_year, f.period_label,
        f.amount != null ? String(f.amount) : '',
        f.due_date ? String(f.due_date).slice(0, 10) : '',
        f.entity_type || '',
      ].filter(Boolean).join(' ').toLowerCase();
      return tokens.every(t => hay.includes(t));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adhocFees, adhocSearch, gfFormFilter, gfEntityFilter, gfDateMode, gfMonth, gfYear, gfDateFrom, gfDateTo]);

  // Combined list for "All Payments" sub-tab (standalone + compliance-linked)
  const filteredAllFees = useMemo(() => {
    const standaloneWithTag = (adhocFees || []).map(f => ({ ...f, _source: 'direct' }));
    const linkedWithTag     = (linkedFees || []).map(f => ({ ...f, _source: 'linked' }));
    const combined = [...standaloneWithTag, ...linkedWithTag];
    const q = adhocSearch.trim().toLowerCase();
    const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
    return combined.filter(f => {
      if (!applyFieldFilters(f)) return false;
      if (!applyDateFilter(f)) return false;
      if (!tokens.length) return true;
      const hay = [
        f.title, f.client_name, f.srn, f.category,
        CATEGORY_CFG[f.category]?.label, f.status, f.notes,
        f.fy_year, f.period_label,
        f.amount != null ? String(f.amount) : '',
        f.entity_type || '',
        f._source === 'linked' ? 'compliance linked' : 'direct',
      ].filter(Boolean).join(' ').toLowerCase();
      return tokens.every(t => hay.includes(t));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adhocFees, linkedFees, adhocSearch, gfFormFilter, gfEntityFilter, gfDateMode, gfMonth, gfYear, gfDateFrom, gfDateTo]);

  // Active list based on sub-tab
  const activeGovtFeesList = govtFeesSubTab === 'direct' ? filteredAdhoc : filteredAllFees;

  const exportGovtFees = useCallback(async (kind) => {
    if (!activeGovtFeesList.length) { toast.error('No government fee payments to export'); return; }
    const dateText = (d) => d ? format(parseISO(String(d).slice(0, 10)), 'MMM d, yyyy') : '—';
    const statusText = (s) => String(s || '').toLowerCase() === 'paid' ? 'Paid' : 'Unpaid';
    const headers = ['#', 'Client', 'Title', 'Category', 'FY Year', 'Due Date', 'Status', 'Payment Date', 'Amount (₹)', 'SRN', 'Type', 'Details'];
    const rows = activeGovtFeesList.map((fee, i) => [
      i + 1,
      fee.client_name || '',
      fee.title || '',
      CATEGORY_CFG[fee.category]?.label || fee.category || 'OTHER',
      fee.fy_year || '',
      dateText(fee.due_date),
      statusText(fee.status),
      dateText(fee.payment_date || fee.paid_on || fee.paid_at),
      Number(fee.amount || 0),
      fee.srn || '',
      fee._source === 'linked' ? 'Compliance-Linked' : 'Direct',
      fee.notes || '',
    ]);
    const fileName = `govt_fees_full_list_${format(new Date(), 'dd-MMM-yyyy')}`;
    if (kind === 'excel') {
      const XLSX = await getXLSX();
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      ws['!cols'] = [{wch:5},{wch:30},{wch:28},{wch:16},{wch:12},{wch:14},{wch:12},{wch:14},{wch:14},{wch:18},{wch:32}];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Govt Fees');
      XLSX.writeFile(wb, `${fileName}.xlsx`);
      toast.success('Government fees Excel exported');
      return;
    }
    const jsPDF = await getJsPDF();
    const autoTable = await getAutoTable();
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    doc.setFontSize(15);
    doc.text('Government Fees Full Payment List', 14, 14);
    doc.setFontSize(9);
    doc.text(format(new Date(), 'dd MMM yyyy'), 14, 20);
    autoTable(doc, {
      startY: 26,
      head: [headers],
      body: rows,
      styles: { fontSize: 7, cellPadding: 2 },
      headStyles: { fillColor: [13, 59, 102] },
      columnStyles: { 0: { cellWidth: 8 }, 8: { halign: 'right' } },
    });
    doc.save(`${fileName}.pdf`);
    toast.success('Government fees PDF exported');
  }, [activeGovtFeesList]); // eslint-disable-line react-hooks/exhaustive-deps


  const fetchAll=useCallback(async()=>{
    setLoading(true);
    try{
      const params=new URLSearchParams();
      if(catFilter!=='all')params.set('category',catFilter);
      if(fyFilter!=='all')params.set('fy_year',fyFilter);
      const[listRes,dashRes,usersRes]=await Promise.all([
        // FastAPI deployments may expose collection routes with a trailing
        // slash. Request the canonical slash form so older deployments do
        // not return a collection-level 404.
        api.get(`/compliance/${params.toString() ? `?${params}` : ''}`),
        api.get('/compliance/dashboard/summary'),
        api.get('/users').catch(()=>({data:[]})),
      ]);
      setCompliance(Array.isArray(listRes.data)?listRes.data:[]);
      const dash=dashRes.data||null;
      setDashboard(dash);
      // Store allowed_categories returned by the backend (null = admin sees all)
      if(dash&&Array.isArray(dash.allowed_categories)){
        setAllowedCategories(dash.allowed_categories);
      } else if(isAdmin){
        setAllowedCategories(null);
      }
      setAllUsers(Array.isArray(usersRes.data)?usersRes.data:[]);
    }catch(err){
      const status=err?.response?.status;
      const noResponse=!err?.response;
      let msg='Failed to load compliance data';
      if(noResponse){
        msg='Failed to load compliance data: cannot reach the server (network/CORS error or the API URL is misconfigured)';
      } else if(status===404){
        msg='Failed to load compliance data: API endpoint not found (404) — the backend URL this app is pointing to may be wrong or down';
      } else if(status===401||status===403){
        msg='Failed to load compliance data: not authorized — please log in again';
      } else if(status){
        msg=`Failed to load compliance data (HTTP ${status})`;
      }
      // eslint-disable-next-line no-console
      console.error('[CompliancePage] fetchAll failed:',err);
      toast.error(msg);
    }
    finally{setLoading(false);}
  },[catFilter,fyFilter,refreshKey]);

  useEffect(()=>{fetchAll();},[fetchAll]);

  const handleDelete=async(id,name)=>{
    if(!confirm(`Delete "${name}" and all assignments?`))return;
    try{await api.delete(`/compliance/${id}`);toast.success('Deleted');setRefreshKey(k=>k+1);}
    catch(e){toast.error(e?.response?.data?.detail||'Delete failed');}
  };

  const handleClose=async(item)=>{
    const isClosed=!!item.is_closed;
    const action=isClosed?'Re-open':'Close';
    if(!confirm(`${action} "${item.name}"? ${isClosed?'It will reappear on the dashboard.':'It will be hidden from the dashboard overdue/upcoming counters but remain visible here.'}`))return;
    try{
      const updated=await api.patch(`/compliance/${item.id}/close`);
      // Clear the dashboard session cache so the next dashboard visit re-fetches
      // fresh due_dates data and the item disappears / reappears immediately.
      try{ sessionStorage.removeItem('dashboard_cache_v1'); }catch{}
      toast.success(`"${item.name}" ${updated.data?.is_closed?'closed — hidden from dashboard':'re-opened'}`);
      setRefreshKey(k=>k+1);
    }catch(e){toast.error(e?.response?.data?.detail||`${action} failed`);}
  };

  // AI Duplicate handler — uses Grok → Gemini → local fallback; excludes completed/filed items
  const handleDetectDuplicates = () => {
    if (detectingDups) return;
    setDetectingDups(true);

    const localFallback = () => {
      try {
        const groups = detectComplianceDuplicates(compliance);
        setDupGroups(groups);
        setShowDupDialog(true);
        if (!groups.length) toast.success(`Scanned ${compliance.length} compliance items — no duplicates found ✓`);
        else toast.info(`Found ${groups.length} duplicate group${groups.length !== 1 ? 's' : ''}`);
      } catch (e) {
        toast.error('Duplicate scan failed. Please try again.');
        console.error('Compliance duplicate detection error:', e);
      } finally {
        setDetectingDups(false);
      }
    };

    const tryAIDetect = async () => {
      try {
        const complianceNames = compliance.map((c, idx) => ({ idx, name: c.name, category: c.category, fy_year: c.fy_year, frequency: c.frequency }));
        const { data } = await api.post('/compliance/detect-duplicates', { items: complianceNames, context: 'compliance_items' });
        const mappedGroups = (data.groups || []).map(g => ({
          item_ids: (g.item_ids || []).map(idx => String(compliance[idx]?.id || idx)),
          confidence: g.confidence || 'medium',
          reason: g.reason || 'AI detected similarity',
          score: g.confidence === 'high' ? 90 : 70,
          source: 'gemini',
        })).filter(g => g.item_ids.length > 1);
        setDupGroups(mappedGroups);
        setShowDupDialog(true);
        if (!mappedGroups.length) toast.success(`Gemini AI: No duplicates found in ${compliance.length} items ✓`);
        else toast.info(`Gemini AI found ${mappedGroups.length} duplicate group${mappedGroups.length !== 1 ? 's' : ''}`);
      } catch (e) {
        console.warn('Gemini AI failed, using local engine', e);
        localFallback();
      } finally {
        setDetectingDups(false);
      }
    };

    tryAIDetect().catch(() => localFallback());
  };

  // Only show category tabs the user can access
  const visibleCategories = useMemo(()=>{
    if(!allowedCategories) return CATEGORIES; // admin sees all
    return CATEGORIES.filter(c=>allowedCategories.includes(c));
  },[allowedCategories]);

  const filtered=useMemo(()=>{
    let list=compliance;
    if(!searchQ.trim())return list;
    const q=searchQ.toLowerCase();
    return list.filter(c=>c.name.toLowerCase().includes(q)||(CATEGORY_CFG[c.category]?.label||'').toLowerCase().includes(q));
  },[compliance,searchQ]);

  const fyYears=useMemo(()=>[...new Set(compliance.map(c=>c.fy_year).filter(Boolean))],[compliance]);

  useEffect(()=>{
    setCompliancePage(1);
  },[searchQ,catFilter,fyFilter,compliancePageSize]);

  const pagedCompliance=useMemo(()=>{
    const start=(compliancePage-1)*compliancePageSize;
    return filtered.slice(start,start+compliancePageSize);
  },[filtered,compliancePage,compliancePageSize]);

  // Full page detail view
  if(detailItem){
    return(
      <AnimatePresence mode="wait">
        <ComplianceDetailPage key={detailItem.id} compliance={detailItem} isDark={isDark} allUsers={allUsers}
          canManage={canManage}
          onBack={()=>{setDetailItem(null);setRefreshKey(k=>k+1);}}/>
      </AnimatePresence>
    );
  }

  return(
    <>
      <LayoutCustomizer
        isOpen={showLayoutCustomizer}
        onClose={() => setShowLayoutCustomizer(false)}
        order={cpOrder}
        sectionLabels={COMPLIANCE_LABELS}
        onDragEnd={cpMove}
        onReset={cpReset}
        isDark={isDark}
      />
    <div className="min-h-screen p-3 sm:p-4 md:p-6 lg:p-8" style={{background:isDark?D.bg:'#f8fafc'}}>
      <motion.div className="max-w-[1600px] mx-auto space-y-6" variants={containerVariants} initial="hidden" animate="visible">

        {cpOrder.map((sectionId) => {

          /* ── BANNER ── */
          if (sectionId === 'banner') return (
            <React.Fragment key="banner">
            <motion.div variants={itemVariants}>
              <div className="relative overflow-hidden rounded-2xl px-6 py-5"
                style={{background:'linear-gradient(135deg,#0D3B66 0%,#1F6FB2 100%)',boxShadow:'0 8px 32px rgba(13,59,102,0.25)'}}>
                <div className="absolute right-0 top-0 w-64 h-64 rounded-full -mr-20 -mt-20 opacity-10" style={{background:'radial-gradient(circle,white 0%,transparent 70%)'}}/>
                <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <p className="text-white/60 text-xs font-semibold uppercase tracking-widest mb-1">Compliance Management</p>
                    <h1 className="text-2xl font-bold text-white tracking-tight">Compliance Tracker</h1>
                    <p className="text-white/60 text-sm mt-1">
                      {isAdmin
                        ? 'Track ROC, GST, ITR, TDS filings across all clients in real time'
                        : `Viewing compliance for: ${(user?.departments||[]).join(', ')||'your department'}`
                      }
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap self-start md:self-auto">
                    {canManage&&(
                      <button onClick={()=>setShowAddModal(true)}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white border border-white/30 hover:bg-white/15 transition-all">
                        <Plus className="w-4 h-4"/>Add Compliance
                      </button>
                    )}
                    <button onClick={()=>setShowAddCal(true)}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white border border-white/30 hover:bg-white/15 transition-all">
                      <Calendar className="w-4 h-4"/>Add Due Date
                    </button>
                    <button
                      onClick={handleDetectDuplicates}
                      disabled={detectingDups || compliance.length === 0}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white border border-white/30 hover:bg-white/15 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
                      {detectingDups
                        ? <><Loader2 className="w-4 h-4 animate-spin"/>Scanning…</>
                        : <><Sparkles className="w-4 h-4"/>AI Duplicates</>}
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
            <motion.div variants={itemVariants} className="flex justify-end">
              <button
                onClick={() => setShowLayoutCustomizer(true)}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all active:scale-95"
                style={{
                  background:  isDark ? 'rgba(31,111,178,0.15)' : 'rgba(31,111,178,0.07)',
                  borderColor: isDark ? 'rgba(31,111,178,0.4)'  : 'rgba(31,111,178,0.22)',
                  color:       isDark ? '#60a5fa'                : '#1F6FB2',
                }}
              >
                <Settings2 size={13} /> Customize Layout
              </button>
            </motion.div>
            </React.Fragment>
          );

          /* ── STATS ── */
          if (sectionId === 'stats') return (
            <React.Fragment key="stats">
              {/* Dept-scope info banner for non-admins */}
              {!isAdmin&&allowedCategories&&allowedCategories.length>0&&(
                <motion.div variants={itemVariants}
                  className="flex items-center gap-2.5 px-4 py-3 rounded-xl border text-sm font-medium"
                  style={{backgroundColor:isDark?'rgba(31,111,178,0.12)':'#eff6ff',borderColor:isDark?'rgba(31,111,178,0.3)':'#bfdbfe',color:isDark?'#93c5fd':'#1d4ed8'}}>
                  <ShieldCheck className="w-4 h-4 flex-shrink-0"/>
                  <span>
                    You are viewing compliance items for your department
                    {' '}({allowedCategories.map(c=>CATEGORY_CFG[c]?.label||c).join(', ')}).
                    {!canManage&&' Contact your admin to create or delete compliance types.'}
                  </span>
                </motion.div>
              )}
              {dashboard&&(
                <motion.div variants={itemVariants} className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    {icon:BookOpen,     label:'Compliance Types',   value:dashboard.total_compliance_types, unit:'defined',color:'#1F6FB2'},
                    {icon:Users,        label:'Client Assignments', value:dashboard.total_assignments,      unit:'total records',color:'#8B5CF6'},
                    {icon:CheckCircle2, label:'Completed / Filed',  value:dashboard.completed_or_filed,     unit:`${dashboard.overall_pct}% done`,color:'#1FAF5A'},
                    {icon:AlertTriangle,label:'Pending',            value:dashboard.pending,unit:`${dashboard.overdue>0?dashboard.overdue+' overdue':'none overdue'}`,color:dashboard.overdue>0?'#EF4444':'#F59E0B'},
                  ].map(({icon:Icon,label,value,unit,color})=>(
                    <div key={label} className="rounded-2xl border p-4 hover:shadow-md transition-all"
                      style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0'}}>
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <p className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{color:isDark?D.dimmer:'#94a3b8'}}>{label}</p>
                          <p className="text-2xl font-black" style={{color}}>{value??'—'}</p>
                          <p className="text-[11px] mt-0.5" style={{color:isDark?D.dimmer:'#94a3b8'}}>{unit}</p>
                        </div>
                        <div className="p-2 rounded-xl" style={{backgroundColor:`${color}15`}}><Icon className="w-4 h-4" style={{color}}/></div>
                      </div>
                    </div>
                  ))}
                </motion.div>
              )}
            </React.Fragment>
          );

          /* ── FILTERS ── */
          if (sectionId === 'filters') return (
            <motion.div key="filters" variants={itemVariants} className="space-y-3">

              {/* ── Top-level: Govt Fees | Compliance Types ── */}
              <div className="flex items-center gap-2 border-b pb-2"
                style={{borderColor:isDark?D.border:'#e2e8f0'}}>
                <button onClick={()=>setPageView('govtfees')}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm font-bold rounded-t-lg border-b-2 transition-all"
                  style={{
                    borderColor: pageView==='govtfees' ? '#1F6FB2' : 'transparent',
                    color: pageView==='govtfees' ? '#1F6FB2' : (isDark?D.dimmer:'#64748b'),
                  }}>
                  <IndianRupee className="w-4 h-4" /> Govt Fees
                </button>
                <button onClick={()=>setPageView('compliance')}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm font-bold rounded-t-lg border-b-2 transition-all"
                  style={{
                    borderColor: pageView==='compliance' ? '#1F6FB2' : 'transparent',
                    color: pageView==='compliance' ? '#1F6FB2' : (isDark?D.dimmer:'#64748b'),
                  }}>
                  <BookOpen className="w-4 h-4" /> Compliance Types
                </button>
              </div>

              {pageView==='govtfees' ? (
                <div className="space-y-3">
                  {/* ── Sub-tabs: Direct Payments | All Payments ── */}
                  <div className="flex items-center gap-1 p-1 rounded-xl w-fit"
                    style={{backgroundColor:isDark?D.raised:'#f1f5f9'}}>
                    {[
                      {key:'direct', label:'Direct Payments', title:'Payments not linked to any compliance'},
                      {key:'all',    label:'All Payments',    title:'Direct payments + compliance-linked payments'},
                    ].map(tab => (
                      <button key={tab.key} onClick={()=>setGovtFeesSubTab(tab.key)} title={tab.title}
                        className="px-4 py-1.5 rounded-lg text-xs font-bold transition-all"
                        style={{
                          backgroundColor: govtFeesSubTab===tab.key ? (isDark?D.card:'#fff') : 'transparent',
                          color: govtFeesSubTab===tab.key ? '#1F6FB2' : (isDark?D.dimmer:'#64748b'),
                          boxShadow: govtFeesSubTab===tab.key ? '0 1px 4px rgba(0,0,0,0.1)' : 'none',
                        }}>
                        {tab.label}
                        {govtFeesSubTab===tab.key && (
                          <span className="ml-1.5 px-1.5 py-0.5 text-[9px] rounded-full font-black"
                            style={{backgroundColor:'#1F6FB215',color:'#1F6FB2'}}>
                            {tab.key==='direct' ? filteredAdhoc.length : filteredAllFees.length}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>

                  {/* ── Filter Row 1: Search + Form (Category) + Entity Type ── */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="relative flex-1 min-w-[200px] max-w-sm">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{color:isDark?D.dimmer:'#94a3b8'}}/>
                      <input value={adhocSearch} onChange={e=>setAdhocSearch(e.target.value)} placeholder="Search title, client, SRN, FY, notes…"
                        className="w-full pl-9 pr-9 py-2 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0',color:isDark?D.text:'#1e293b'}}/>
                      {adhocSearch && (
                        <button onClick={()=>setAdhocSearch('')} title="Clear"
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-slate-100"
                          style={{color:isDark?D.dimmer:'#94a3b8'}}>
                          <X className="w-3.5 h-3.5"/>
                        </button>
                      )}
                    </div>

                    {/* Form / Category filter */}
                    <select value={gfFormFilter} onChange={e=>setGfFormFilter(e.target.value)}
                      className="h-9 px-3 border rounded-xl text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500"
                      style={{backgroundColor:isDark?D.card:'#fff',borderColor:gfFormFilter!=='all'?'#1F6FB2':(isDark?D.border:'#e2e8f0'),color:gfFormFilter!=='all'?'#1F6FB2':(isDark?D.text:'#1e293b'),minWidth:130}}>
                      <option value="all">All Forms</option>
                      {CATEGORIES.map(cat => (
                        <option key={cat} value={cat}>{CATEGORY_CFG[cat]?.label || cat}</option>
                      ))}
                    </select>

                    {/* Entity Type filter */}
                    <select value={gfEntityFilter} onChange={e=>setGfEntityFilter(e.target.value)}
                      className="h-9 px-3 border rounded-xl text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500"
                      style={{backgroundColor:isDark?D.card:'#fff',borderColor:gfEntityFilter!=='all'?'#1F6FB2':(isDark?D.border:'#e2e8f0'),color:gfEntityFilter!=='all'?'#1F6FB2':(isDark?D.text:'#1e293b'),minWidth:160}}>
                      <option value="all">All Entity Types</option>
                      {ENTITY_TYPES.map(et => (
                        <option key={et.value} value={et.value}>{et.label}</option>
                      ))}
                    </select>

                    {/* Result count */}
                    <span className="text-[11px] font-semibold px-2 py-1 rounded-md"
                      style={{backgroundColor:isDark?D.raised:'#f1f5f9',color:isDark?D.muted:'#64748b'}}>
                      {activeGovtFeesList.length} records
                    </span>

                    {/* Export + Refresh + Add */}
                    <div className="flex items-center gap-1.5 ml-auto">
                      <div className="inline-flex rounded-lg border overflow-hidden"
                        style={{borderColor:isDark?D.border:'#cbd5e1'}}>
                        <button onClick={()=>exportGovtFees('excel')} disabled={!activeGovtFeesList.length}
                          className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-bold disabled:opacity-40 hover:opacity-90"
                          style={{ backgroundColor:isDark?D.card:'#fff', color:isDark?D.text:'#0f172a' }}>
                          <FileSpreadsheet className="w-3.5 h-3.5"/> Excel
                        </button>
                        <div style={{width:1, backgroundColor:isDark?D.border:'#e2e8f0'}}/>
                        <button onClick={()=>exportGovtFees('pdf')} disabled={!activeGovtFeesList.length}
                          className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-bold disabled:opacity-40 hover:opacity-90"
                          style={{ backgroundColor:isDark?D.card:'#fff', color:isDark?D.text:'#0f172a' }}>
                          <Download className="w-3.5 h-3.5"/> PDF
                        </button>
                      </div>
                      <button onClick={()=>setRefreshKey(k=>k+1)} title="Refresh"
                        className="p-2 h-9 w-9 inline-flex items-center justify-center rounded-lg border hover:opacity-80"
                        style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0',color:isDark?D.muted:'#64748b'}}>
                        <RefreshCw className={`w-4 h-4 ${(adhocFeesLoading||linkedFeesLoading)?'animate-spin':''}`}/>
                      </button>
                      {govtFeesSubTab==='direct' && (
                        <button onClick={()=>{ setEditingAdhoc(null); setShowAdhocDialog(true); }}
                          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-xs font-bold text-white shadow-sm hover:shadow-md transition-shadow"
                          style={{ background:'linear-gradient(135deg,#0D3B66,#1F6FB2)' }}>
                          <Plus className="w-3.5 h-3.5"/> Add Government Fee
                        </button>
                      )}
                    </div>
                  </div>

                  {/* ── Filter Row 2: Date Filters ── */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-bold uppercase tracking-wider" style={{color:isDark?D.dimmer:'#94a3b8'}}>
                      <Calendar className="inline w-3 h-3 mr-1"/>Date Filter:
                    </span>
                    {[
                      {key:'all',    label:'All Time'},
                      {key:'month',  label:'By Month'},
                      {key:'year',   label:'By Year'},
                      {key:'custom', label:'Custom Range'},
                    ].map(opt => (
                      <button key={opt.key} onClick={()=>setGfDateMode(opt.key)}
                        className="px-3 py-1 rounded-lg text-[11px] font-semibold border transition-all"
                        style={{
                          backgroundColor: gfDateMode===opt.key ? '#1F6FB215' : (isDark?D.card:'#fff'),
                          borderColor: gfDateMode===opt.key ? '#1F6FB2' : (isDark?D.border:'#e2e8f0'),
                          color: gfDateMode===opt.key ? '#1F6FB2' : (isDark?D.muted:'#64748b'),
                        }}>
                        {opt.label}
                      </button>
                    ))}

                    {/* Month picker */}
                    {gfDateMode==='month' && (
                      <input type="month" value={gfMonth} onChange={e=>setGfMonth(e.target.value)}
                        className="h-8 px-2 border rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                        style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0',color:isDark?D.text:'#1e293b'}}/>
                    )}

                    {/* Year picker */}
                    {gfDateMode==='year' && (
                      <select value={gfYear} onChange={e=>setGfYear(e.target.value)}
                        className="h-8 px-2 border rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                        style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0',color:isDark?D.text:'#1e293b'}}>
                        <option value="">Select Year</option>
                        {Array.from({length:15},(_,i)=>new Date().getFullYear()-i).map(y=>(
                          <option key={y} value={String(y)}>{y}</option>
                        ))}
                      </select>
                    )}

                    {/* Custom date range */}
                    {gfDateMode==='custom' && (
                      <div className="flex items-center gap-1.5">
                        <input type="date" value={gfDateFrom} onChange={e=>setGfDateFrom(e.target.value)}
                          className="h-8 px-2 border rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                          style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0',color:isDark?D.text:'#1e293b'}}/>
                        <span className="text-[10px]" style={{color:isDark?D.dimmer:'#94a3b8'}}>to</span>
                        <input type="date" value={gfDateTo} onChange={e=>setGfDateTo(e.target.value)}
                          className="h-8 px-2 border rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                          style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0',color:isDark?D.text:'#1e293b'}}/>
                      </div>
                    )}

                    {/* Reset all filters button */}
                    {(gfFormFilter!=='all'||gfEntityFilter!=='all'||gfDateMode!=='all'||adhocSearch) && (
                      <button onClick={()=>{setGfFormFilter('all');setGfEntityFilter('all');setGfDateMode('all');setGfMonth('');setGfYear('');setGfDateFrom('');setGfDateTo('');setAdhocSearch('');}}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-all"
                        style={{borderColor:'#EF4444',color:'#EF4444',backgroundColor:isDark?'rgba(239,68,68,0.08)':'#fef2f2'}}>
                        <X className="w-3 h-3"/> Reset Filters
                      </button>
                    )}
                  </div>
                </div>
              ) : (
              <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 min-w-[180px] max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{color:isDark?D.dimmer:'#94a3b8'}}/>
                <input value={searchQ} onChange={e=>setSearchQ(e.target.value)} placeholder="Search compliance…"
                  className="w-full pl-9 pr-3 py-2 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0',color:isDark?D.text:'#1e293b'}}/>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {(visibleCategories.length>1||isAdmin)&&(
                  <button key="all" onClick={()=>setCatFilter('all')}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all"
                    style={{backgroundColor:catFilter==='all'?(isDark?D.raised:'#f1f5f9'):(isDark?D.card:'#fff'),
                      borderColor:catFilter==='all'?'#1F6FB2':(isDark?D.border:'#e2e8f0'),
                      color:catFilter==='all'?'#1F6FB2':(isDark?D.muted:'#64748b')}}>
                    All
                  </button>
                )}
                {visibleCategories.map(cat=>{
                  const cfg=CATEGORY_CFG[cat];const active=catFilter===cat;
                  return(<button key={cat} onClick={()=>setCatFilter(cat)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all"
                    style={{backgroundColor:active?(cfg?.bg||(isDark?D.raised:'#f1f5f9')):(isDark?D.card:'#fff'),borderColor:active?(cfg?.color||'#1F6FB2'):(isDark?D.border:'#e2e8f0'),color:active?(cfg?.color||'#1F6FB2'):(isDark?D.muted:'#64748b')}}>
                    {cfg?.label||cat}
                  </button>);
                })}
              </div>
              {fyYears.length>0&&(
                <select value={fyFilter} onChange={e=>setFyFilter(e.target.value)}
                  className="px-3 py-2 border rounded-xl text-sm focus:outline-none"
                  style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0',color:isDark?D.text:'#1e293b'}}>
                  <option value="all">All FY</option>
                  {fyYears.map(y=><option key={y} value={y}>FY {y}</option>)}
                </select>
              )}
              <button onClick={()=>setRefreshKey(k=>k+1)} className="p-2 rounded-xl border hover:opacity-80"
                style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0',color:isDark?D.muted:'#64748b'}}>
                <RefreshCw className={`w-4 h-4 ${loading?'animate-spin':''}`}/>
              </button>
              <div className="flex items-center border rounded-xl overflow-hidden flex-shrink-0"
                style={{borderColor:isDark?D.border:'#e2e8f0',backgroundColor:isDark?D.card:'#fff'}}>
                <button onClick={()=>setViewMode('board')} title="Board View"
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold transition-all"
                  style={{backgroundColor:viewMode==='board'?(isDark?D.raised:'#f1f5f9'):'transparent',
                    color:viewMode==='board'?'#1F6FB2':(isDark?D.dimmer:'#94a3b8')}}>
                  <LayoutGrid className="w-3.5 h-3.5"/><span className="hidden sm:inline">Board</span>
                </button>
                <button onClick={()=>setViewMode('list')} title="List View"
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold transition-all"
                  style={{backgroundColor:viewMode==='list'?(isDark?D.raised:'#f1f5f9'):'transparent',
                    color:viewMode==='list'?'#1F6FB2':(isDark?D.dimmer:'#94a3b8')}}>
                  <List className="w-3.5 h-3.5"/><span className="hidden sm:inline">List</span>
                </button>
              </div>
              {filtered.length>0&&<span className="text-xs font-semibold" style={{color:isDark?D.dimmer:'#94a3b8'}}>{filtered.length} types</span>}
              </div>
              )}
            </motion.div>
          );

          /* ── CONTENT ── */
           if (sectionId === 'content') return (
            <React.Fragment key="content">
              {/* ── Compliance Calendar embedded panel ── */}
              {pageView === 'compliance' && (
                <ComplianceCalendarPanel isDark={isDark} showAddCal={showAddCal} setShowAddCal={setShowAddCal} />
              )}
              {pageView === 'govtfees' ? (
                <motion.div variants={itemVariants} className="relative rounded-2xl border overflow-hidden"
                  style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0'}}>
                  {/*
                    Show full-screen loader ONLY on first load (no data yet for this sub-tab).
                    On refreshes keep existing rows visible — avoids "blank tab" flash.
                  */}
                  {(adhocFeesLoading || linkedFeesLoading) && activeGovtFeesList.length === 0 ? (
                    <div className="flex items-center justify-center py-20">
                      <Loader2 className="w-7 h-7 text-blue-500 animate-spin"/>
                    </div>
                  ) : activeGovtFeesList.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 gap-3">
                      <IndianRupee className="w-10 h-10" style={{color:isDark?D.dimmer:'#cbd5e1'}}/>
                      <p className="text-sm font-bold" style={{color:isDark?D.text:'#0f172a'}}>
                        {(adhocSearch||gfFormFilter!=='all'||gfEntityFilter!=='all'||gfDateMode!=='all')
                          ? 'No matching govt fees'
                          : govtFeesSubTab==='all'
                            ? 'No government fee payments found'
                            : 'No direct government fees yet'}
                      </p>
                      <p className="text-xs text-center max-w-sm" style={{color:isDark?D.muted:'#64748b'}}>
                        {(adhocSearch||gfFormFilter!=='all'||gfEntityFilter!=='all'||gfDateMode!=='all')
                          ? 'Try adjusting your search or filters.'
                          : govtFeesSubTab==='all'
                            ? 'Direct payments and compliance-linked fee payments will appear here once recorded.'
                            : <>Use <strong>Add Government Fee</strong> above to record payments not linked to a compliance.</>}
                      </p>
                      {govtFeesSubTab==='direct' && !adhocSearch && gfFormFilter==='all' && gfEntityFilter==='all' && gfDateMode==='all' && (
                        <button onClick={()=>{ setEditingAdhoc(null); setShowAdhocDialog(true); }}
                          className="mt-1 inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-xs font-bold text-white"
                          style={{ background:'linear-gradient(135deg,#0D3B66,#1F6FB2)' }}>
                          <Plus className="w-3.5 h-3.5"/> Add Government Fee
                        </button>
                      )}
                    </div>
                  ) : (
                    <>
                      {/* Subtle inline reload indicator */}
                      {(adhocFeesLoading || linkedFeesLoading) && (
                        <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold"
                          style={{backgroundColor:isDark?D.raised:'#eff6ff',color:'#1F6FB2'}}>
                          <Loader2 className="w-3 h-3 animate-spin"/> Refreshing
                        </div>
                      )}
                      {/* Header row — extra "Type" col for All Payments tab */}
                      <div className="grid px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider border-b"
                        style={{
                          gridTemplateColumns: govtFeesSubTab==='all'
                            ? 'minmax(180px,1.6fr) minmax(140px,1.3fr) 96px 70px 110px 96px minmax(130px,1fr) 80px 92px'
                            : 'minmax(200px,1.8fr) minmax(160px,1.4fr) 96px 70px 110px 96px minmax(150px,1.1fr) 92px',
                          backgroundColor:isDark?D.raised:'#f8fafc',color:isDark?D.dimmer:'#94a3b8',borderColor:isDark?D.border:'#e2e8f0'}}>
                        <div>Title</div><div>Client</div><div>Category</div>
                        <div>FY</div><div>Due Date</div><div>Status</div>
                        <div>Amount / SRN</div>
                        {govtFeesSubTab==='all' && <div>Type</div>}
                        <div className="text-right pr-1">Actions</div>
                      </div>
                      {activeGovtFeesList.map((fee, idx) => (
                        <GovtFeeRow
                          key={fee.id || `fee-row-${idx}`}
                          fee={fee}
                          idx={idx}
                          govtFeesSubTab={govtFeesSubTab}
                          isDark={isDark}
                          canManage={canManage}
                          onEdit={(f) => {
                            if (f._source === 'linked') {
                              setEditingLinkedFee({
                                ...f,
                                amount: f.amount || 0,
                                srn: f.srn || '',
                              });
                            } else {
                              setEditingAdhoc(f); setShowAdhocDialog(true);
                            }
                          }}
                          onDelete={handleDeleteAdhoc}
                        />
                      ))}
                      {/* Footer totals */}
                      <div className="flex items-center justify-between px-4 py-3"
                        style={{backgroundColor:isDark?D.raised:'#f8fafc'}}>
                        {govtFeesSubTab==='all' ? (
                          <div className="flex items-center gap-4 text-xs" style={{color:isDark?D.dimmer:'#64748b'}}>
                            <span>
                              <span className="inline-block w-2 h-2 rounded-sm bg-sky-400 mr-1"/>
                              Direct: <strong style={{color:isDark?D.text:'#0f172a'}}>
                                ₹ {activeGovtFeesList.filter(f=>f._source!=='linked').reduce((s,f)=>s+(f.amount||0),0).toLocaleString('en-IN',{minimumFractionDigits:2})}
                              </strong>
                            </span>
                            <span>
                              <span className="inline-block w-2 h-2 rounded-sm bg-purple-400 mr-1"/>
                              Compliance-linked: <strong style={{color:isDark?D.text:'#0f172a'}}>
                                ₹ {activeGovtFeesList.filter(f=>f._source==='linked').reduce((s,f)=>s+(f.amount||0),0).toLocaleString('en-IN',{minimumFractionDigits:2})}
                              </strong>
                            </span>
                          </div>
                        ) : <div/>}
                        <p className="text-sm">
                          <span style={{color:isDark?D.dimmer:'#64748b'}} className="mr-2">Total:</span>
                          <span className="font-bold" style={{color:isDark?D.text:'#0f172a'}}>
                            ₹ {activeGovtFeesList.reduce((s,f)=>s+(f.amount||0),0).toLocaleString('en-IN',{minimumFractionDigits:2})}
                          </span>
                        </p>
                      </div>
                    </>
                  )}
                </motion.div>
              ) : loading?(
                <div className="flex items-center justify-center py-20"><Loader2 className="w-7 h-7 text-blue-500 animate-spin"/></div>
              ):filtered.length===0?(
                <motion.div variants={itemVariants} className="flex flex-col items-center justify-center py-20 gap-4 rounded-2xl border"
                  style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0'}}>
                  <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{backgroundColor:isDark?D.raised:'#f1f5f9'}}>
                    <ShieldCheck className="w-8 h-8" style={{color:isDark?D.dimmer:'#cbd5e1'}}/>
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-bold" style={{color:isDark?D.text:'#0f172a'}}>{searchQ||catFilter!=='all'?'No matching compliance':'No compliance defined yet'}</p>
                    <p className="text-sm mt-1" style={{color:isDark?D.muted:'#64748b'}}>{searchQ||catFilter!=='all'?'Adjust filters':canManage?'Add a compliance type to start tracking':'No compliance items found for your department'}</p>
                  </div>
                  {!searchQ&&catFilter==='all'&&canManage&&(
                    <button onClick={()=>setShowAddModal(true)} className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white" style={{backgroundColor:'#1F6FB2'}}>
                      <Plus className="w-4 h-4"/>Add First Compliance
                    </button>
                  )}
                </motion.div>
              ):viewMode==='list'?(
                <motion.div className="rounded-2xl border overflow-hidden" variants={containerVariants}
                  style={{backgroundColor:isDark?D.card:'#fff',borderColor:isDark?D.border:'#e2e8f0'}}>
                  <div className="grid px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider border-b"
                    style={{gridTemplateColumns:'4px 1fr 110px 100px 130px 100px 80px 72px',
                      backgroundColor:isDark?D.raised:'#f8fafc',color:isDark?D.dimmer:'#94a3b8',borderColor:isDark?D.border:'#e2e8f0'}}>
                    <div/><div>Compliance Name</div><div>FY Year</div><div>Due Date</div>
                    <div>Progress</div><div>% Done</div><div>Clients</div>
                    {canManage&&<div>Actions</div>}
                  </div>
                  {pagedCompliance.map(item=>(
                    <ComplianceCard key={item.id} item={item} isDark={isDark} viewMode="list"
                      canManage={canManage}
                      onClick={()=>setDetailItem(item)}
                      onEdit={canManage?(e=>{e&&e.stopPropagation();setEditingItem(item);}):undefined}
                      onDelete={canManage?(e=>{e&&e.stopPropagation();handleDelete(item.id,item.name);}):undefined}
                      onClose={canManage?handleClose:undefined}/>
                  ))}
                </motion.div>
              ):(
                <motion.div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 items-stretch" variants={containerVariants}>
                  {pagedCompliance.map(item=>(
                    <ComplianceCard key={item.id} item={item} isDark={isDark} viewMode="board"
                      canManage={canManage}
                      onClick={()=>setDetailItem(item)}
                      onEdit={canManage?(e=>{e&&e.stopPropagation();setEditingItem(item);}):undefined}
                      onDelete={canManage?(e=>{e&&e.stopPropagation();handleDelete(item.id,item.name);}):undefined}
                      onClose={canManage?handleClose:undefined}/>
                  ))}
                </motion.div>
              )}
              <Pagination
                page={compliancePage}
                pageSize={compliancePageSize}
                total={filtered.length}
                onPageChange={setCompliancePage}
                onPageSizeChange={size=>{setCompliancePageSize(size);setCompliancePage(1);}}
                isDark={isDark}
                label="compliance types"
              />
            </React.Fragment>
          );

          return null;
        })}

      </motion.div>

      <AnimatePresence>
        {(showAddModal||editingItem)&&canManage&&(
          <ComplianceFormModal isDark={isDark} existing={editingItem||undefined}
            onClose={()=>{setShowAddModal(false);setEditingItem(null);}}
            onSave={()=>{setShowAddModal(false);setEditingItem(null);setRefreshKey(k=>k+1);}}/>
        )}
      </AnimatePresence>

      {/* ── AI Duplicate Detection Dialog ── */}
      <AIDuplicateDialog
        open={showDupDialog}
        onClose={() => setShowDupDialog(false)}
        groups={dupGroups}
        items={compliance}
        entityLabel="Compliance"
        accentColor="#1F6FB2"
        isDark={isDark}
        canDelete={isAdmin}
        canEdit={canManage}
        getTitle={(c) => c.name || 'Unnamed Compliance'}
        getSubtitle={(c) => [CATEGORY_CFG[c.category]?.label, c.fy_year].filter(Boolean).join(' · ') || null}
        getMeta={(c) => [
          c.category ? (CATEGORY_CFG[c.category]?.label || c.category) : null,
          c.fy_year  ? `FY ${c.fy_year}` : null,
          c.frequency ? c.frequency.replace('_', '-') : null,
        ].filter(Boolean)}
        compareFields={(a, b) => [
          { label: 'Name',      a: a.name,                       b: b.name },
          { label: 'Category',  a: CATEGORY_CFG[a.category]?.label || a.category, b: CATEGORY_CFG[b.category]?.label || b.category },
          { label: 'FY Year',   a: a.fy_year,                    b: b.fy_year },
          { label: 'Frequency', a: a.frequency,                  b: b.frequency },
          { label: 'Due Date',  a: a.due_date,                   b: b.due_date },
        ]}
        onEdit={(c) => { setEditingItem(c); setShowDupDialog(false); }}
        onDelete={isAdmin ? async (c) => {
          if (!window.confirm(`Delete "${c.name}" and all its assignments?`)) return;
          try {
            await api.delete(`/compliance/${c.id}`);
            setRefreshKey(k => k + 1);
            toast.success('Compliance deleted');
          } catch { toast.error('Failed to delete compliance'); }
        } : undefined}
        onView={(c) => { setDetailItem(c); setShowDupDialog(false); }}
      />

      {/* ── Standalone Govt Fee dialog (create / edit) ── */}
      <StandaloneGovtFeeDialog
        open={showAdhocDialog}
        onOpenChange={setShowAdhocDialog}
        editing={editingAdhoc}
        clients={adhocClients}
        onSaved={() => { fetchAdhocFees(); setEditingAdhoc(null); }}
      />

      {/* ── Linked compliance-payment edit modal ── */}
      <AnimatePresence>
        {editingLinkedFee && (
          <motion.div className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
            style={{ background: 'rgba(6,78,59,0.75)', backdropFilter: 'blur(8px)' }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => !savingLinkedFee && setEditingLinkedFee(null)}>
            <motion.div onClick={(e) => e.stopPropagation()}
              className="w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden flex flex-col"
              style={{
                backgroundColor: isDark ? D.card : '#fff',
                border: isDark ? `1px solid ${D.border}` : '1px solid #e2e8f0',
                color: isDark ? D.text : '#0f172a',
              }}
              initial={{ scale: 0.92, y: 24 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.92, y: 24 }}
              transition={{ type: 'spring', stiffness: 220, damping: 22 }}>

              {/* Header — gradient like other modals */}
              <div className="px-6 py-5 flex items-center justify-between text-white"
                style={{ background: 'linear-gradient(135deg,#0D3B66,#1F6FB2)' }}>
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center flex-shrink-0">
                    <IndianRupee className="w-5 h-5 text-white"/>
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-lg font-black truncate">Edit Compliance Payment</h2>
                    <p className="text-blue-200 text-xs truncate">
                      {editingLinkedFee.title} · {editingLinkedFee.client_name || '—'}
                    </p>
                  </div>
                </div>
                <button onClick={() => !savingLinkedFee && setEditingLinkedFee(null)}
                  className="w-8 h-8 rounded-xl bg-white/20 hover:bg-white/30 flex items-center justify-center flex-shrink-0">
                  <X className="w-4 h-4 text-white"/>
                </button>
              </div>

              {/* Body */}
              <div className="p-6 space-y-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-semibold mb-1.5 block" style={{ color: isDark ? D.muted : '#374151' }}>
                      Amount (₹)
                    </label>
                    <input type="number" min="0" step="0.01" autoFocus
                      value={editingLinkedFee.amount}
                      onChange={e => setEditingLinkedFee(f => ({ ...f, amount: e.target.value }))}
                      placeholder="0.00"
                      className="w-full px-3.5 py-2.5 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                      style={{ backgroundColor: isDark ? D.raised : '#fff', borderColor: isDark ? D.border : '#d1d5db', color: isDark ? D.text : '#1e293b' }}/>
                  </div>
                  <div>
                    <label className="text-sm font-semibold mb-1.5 block" style={{ color: isDark ? D.muted : '#374151' }}>
                      SRN
                    </label>
                    <input type="text"
                      value={editingLinkedFee.srn}
                      onChange={e => setEditingLinkedFee(f => ({ ...f, srn: e.target.value }))}
                      placeholder="e.g. M31188626"
                      className="w-full px-3.5 py-2.5 border rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                      style={{ backgroundColor: isDark ? D.raised : '#fff', borderColor: isDark ? D.border : '#d1d5db', color: isDark ? D.text : '#1e293b' }}/>
                  </div>
                </div>

                <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl border"
                  style={{
                    backgroundColor: isDark ? 'rgba(31,111,178,0.08)' : '#eff6ff',
                    borderColor: isDark ? 'rgba(31,111,178,0.25)' : '#bfdbfe',
                  }}>
                  <ShieldCheck className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: '#1F6FB2' }}/>
                  <p className="text-[11px] leading-relaxed" style={{ color: isDark ? D.muted : '#1e3a8a' }}>
                    Saving both <b>Amount</b> and <b>SRN</b> auto-marks this compliance as <b>Filed</b> and records today as the payment date.
                  </p>
                </div>
              </div>

              {/* Footer */}
              <div className="px-6 py-4 border-t flex items-center justify-end gap-2"
                style={{ borderColor: isDark ? D.border : '#f1f5f9', backgroundColor: isDark ? D.raised : '#f8fafc' }}>
                <button onClick={() => setEditingLinkedFee(null)} disabled={savingLinkedFee}
                  className="px-4 py-2 rounded-xl text-sm font-semibold border hover:opacity-80 disabled:opacity-50 transition-all"
                  style={{ color: isDark ? D.muted : '#475569', borderColor: isDark ? D.border : '#cbd5e1', backgroundColor: isDark ? D.card : '#fff' }}>
                  Cancel
                </button>
                <button disabled={savingLinkedFee}
                  onClick={async () => {
                    const f = editingLinkedFee;
                    setSavingLinkedFee(true);
                    try {
                      await api.patch(`/compliance/${f.compliance_id}/assignments/${f.assignment_id}/govt-fee`, {
                        govt_fees_amount: parseFloat(f.amount) || 0,
                        govt_fees_srn: (f.srn || '').trim(),
                        govt_fees_notes: f.notes || '',
                      });
                      toast.success('Payment updated');
                      setEditingLinkedFee(null);
                      fetchLinkedFees();
                    } catch {
                      toast.error('Update failed');
                    } finally {
                      setSavingLinkedFee(false);
                    }
                  }}
                  className="px-5 py-2 rounded-xl text-sm font-bold text-white shadow-sm hover:shadow-md disabled:opacity-60 inline-flex items-center gap-2 transition-all"
                  style={{ background: 'linear-gradient(135deg,#0D3B66,#1F6FB2)' }}>
                  {savingLinkedFee ? <Loader2 className="w-4 h-4 animate-spin"/> : <CheckCircle2 className="w-4 h-4"/>}
                  Save Payment
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </>
  );
}
