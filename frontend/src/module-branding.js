/* OneNexa shell branding + active module identity. */
const MODULE_BRANDING = {
  core: { label: 'Taskosphere', landingPath: '/dashboard' },
  accounts: { label: 'Finix', landingPath: '/finix-dashboard' },
  compliance: { label: 'CompliGenie', landingPath: '/compliance-dashboard' },
  proposals: { label: 'LeadSense', landingPath: '/client-proposals-dashboard' },
  'people-matrix': { label: 'People Matrix', landingPath: '/people-matrix' },
  aiweave: { label: 'AIWeave', landingPath: '/aiweave' },
  records: { label: 'ClientSync', landingPath: '/records-dashboard' },
  engagex: { label: 'EngageX', landingPath: '/engagex', lightLogo: '/engagex/engagex-logo.svg', darkLogo: '/engagex/engagex-logo-dark.svg', collapsedLogo: '/engagex/engagex-icon.svg' },
  admin: { label: 'Admin', landingPath: '/admin-dashboard', wordmark: true },
  settings: { label: 'Settings', landingPath: '/settings/general', wordmark: true },
};
const ONE_NEXA = { label: 'OneNexa', landingPath: '/dashboard', lightLogo: '/onenexa-logo.svg', darkLogo: '/onenexa-logo.svg', collapsedLogo: '/onenexa-icon.svg' };
let scheduled = false;
let lastModule = '';

const normalized = value => String(value || '').trim().toLowerCase().replace(/[-\s]/g, '_');
const currentUser = () => { try { const raw = sessionStorage.getItem('user') || localStorage.getItem('user'); return raw ? JSON.parse(raw) : null; } catch { return null; } };
const entitledToEngageX = () => { const user = currentUser(); const modules = [user?.licensed_modules, user?.modules, user?.company?.licensed_modules, user?.license?.modules].find(v => Array.isArray(v)) || []; return modules.some(m => normalized(m) === 'engagex') || user?.permissions?.can_access_engagex === true; };
const routeModule = () => {
  const p = window.location.pathname || '';
  if (p === '/engagex' || p.startsWith('/engagex/')) return 'engagex';
  if (/^\/(compliance-dashboard|compliance|gst-reconciliation|trademark-sphere|roc-sphere|mis-report|salary-slips)(\/|$)/.test(p)) return 'compliance';
  if (/^\/(client-proposals-dashboard|leads|quotations|client-discussion)(\/|$)/.test(p)) return 'proposals';
  if (/^\/(finix-dashboard|invoicing|purchase|bank-accounts|chart-of-accounts|journal-entries|accounting-reports|accounting-books|day-book|cash-bank-book|cash-flow|outstanding-report|bank-reconciliation|depreciation|tds-tcs|financial-ratios|comparative-report|yearly-report|opening-balances|accounting-audit-trail|bulk-import|due-dates|import-invoices)(\/|$)/.test(p)) return 'accounts';
  if (/^\/(people-matrix|users|leave|payroll|hr|recruitment)(\/|$)/.test(p)) return 'people-matrix';
  if (/^\/aiweave(\/|$)/.test(p)) return 'aiweave';
  if (/^\/(records-dashboard|dsc|documents|clients|passwords|client-approvals)(\/|$)/.test(p)) return 'records';
  if (/^\/admin-dashboard|^\/admin\//.test(p)) return 'admin';
  if (/^\/settings(\/|$)/.test(p)) return 'settings';
  return 'core';
};
const setText = (selector, value) => { const node = document.querySelector(selector); if (node && node.textContent.trim() !== value) node.textContent = value; };
const ensureEngageXTab = () => {
  const bar = document.getElementById('top-module-switcher-bar');
  if (!bar) return;
  const existing = document.getElementById('nav-tab-engagex');
  if (!entitledToEngageX()) { existing?.remove(); return; }
  if (existing) return;
  const a = document.createElement('a'); a.id = 'nav-tab-engagex'; a.href = '/engagex'; a.className = 'inline-flex items-center gap-2 px-3 py-2 text-sm font-medium whitespace-nowrap text-slate-600 hover:text-slate-900';
  a.innerHTML = '<img src="/engagex/engagex-icon.svg" alt="" aria-hidden="true" style="width:18px;height:18px;object-fit:contain"><span>EngageX</span>';
  bar.appendChild(a);
};
const ensureEngageXSidebar = active => {
  const aside = document.querySelector('aside'); if (!aside) return;
  const old = aside.querySelector('[data-engagex-sidebar="true"]');
  if (!active) { old?.remove(); aside.querySelectorAll('[data-engagex-hidden="true"]').forEach(n => { n.style.display=''; n.removeAttribute('data-engagex-hidden'); }); return; }
  aside.querySelectorAll('a[href],button').forEach(n => { const h=n.getAttribute('href')||''; if (!h.startsWith('/engagex') && !n.closest('[data-engagex-sidebar="true"]') && !n.textContent.includes('Collapse Sidebar')) { n.style.display='none'; n.setAttribute('data-engagex-hidden','true'); } });
  if (old) return;
  const block=document.createElement('div'); block.dataset.engagexSidebar='true'; block.className='space-y-1 px-2 py-3';
  block.innerHTML='<div class="mb-2 flex items-center gap-2 rounded-lg bg-slate-800/40 px-3 py-2 text-xs font-bold uppercase tracking-wider text-cyan-200"><img src="/engagex/engagex-icon.svg" alt="" style="width:22px;height:22px"><span>EngageX</span></div><a href="/engagex" class="flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-semibold text-white hover:bg-slate-800">◈<span>Dashboard</span></a><a href="/engagex/whatsapp" class="flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium text-slate-200 hover:bg-slate-800">◉<span>WhatsApp Hub</span></a><a href="/engagex/mailmaster" class="flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium text-slate-200 hover:bg-slate-800">✉<span>MailMaster</span></a>';
  const collapse=Array.from(aside.querySelectorAll('*')).find(n=>n.textContent?.trim()==='Collapse Sidebar'); (collapse?.parentElement||aside).prepend(block);
};
const sync = () => {
  scheduled=false; ensureEngageXTab();
  const moduleId=routeModule(); const module=MODULE_BRANDING[moduleId]||MODULE_BRANDING.core; ensureEngageXSidebar(moduleId==='engagex');
  const header=document.querySelector('header.fixed'); if (!header) return;
  const link=header.querySelector('a[href="/dashboard"]')||header.querySelector('a.relative.flex.items-center'); if (!link) return;
  let img=link.querySelector('img[data-onenexa-shell-logo="true"]')||link.querySelector('img');
  if (!img) { img=document.createElement('img'); img.dataset.onenexaShellLogo='true'; link.querySelectorAll(':scope > span').forEach(n=>n.style.display='none'); link.appendChild(img); }
  const collapsed=Boolean(header.firstElementChild && header.firstElementChild.getBoundingClientRect().width<=100);
  const src=collapsed?ONE_NEXA.collapsedLogo:ONE_NEXA.lightLogo; if(img.src!==new URL(src,location.origin).href) img.src=src; img.alt=ONE_NEXA.label; img.style.display='block'; img.style.objectFit='contain'; img.style.width=collapsed?'58px':'205px'; img.style.height=collapsed?'58px':'56px'; img.style.margin='0 auto'; img.style.filter=document.documentElement.classList.contains('dark')?'brightness(0) invert(1)':'none';
  const title=header.querySelector('h1'); if(title){title.textContent=module.label; title.setAttribute('aria-label',module.label);}
  document.title=`${module.label} · OneNexa`; lastModule=moduleId;
};
const schedule=()=>{if(scheduled)return;scheduled=true;window.setTimeout(sync,0);};
const observer=new MutationObserver(schedule); const start=()=>{observer.observe(document.getElementById('root')||document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','href']});schedule();};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
window.addEventListener('popstate',schedule); document.addEventListener('click',e=>{if(e.target?.closest?.('#top-module-switcher-bar a,#top-module-switcher-bar button,header a[href],aside a,aside button'))schedule();},true); window.setInterval(()=>{if(lastModule!==routeModule())schedule();},2000);
