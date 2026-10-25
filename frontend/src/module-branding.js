/* OneNexa shell branding + active module identity. */
const MODULE_BRANDING = {
  core: { label: 'Taskosphere', landingPath: '/dashboard' },
  accounts: { label: 'Finix', landingPath: '/finix-dashboard' },
  compliance: { label: 'CompliGenie', landingPath: '/compliance-dashboard' },
  proposals: { label: 'LeadSense', landingPath: '/client-proposals-dashboard' },
  'people-matrix': { label: 'People Matrix', landingPath: '/people-matrix' },
  aiweave: { label: 'AIWeave', landingPath: '/aiweave' },
  records: { label: 'ClientSync', landingPath: '/records-dashboard' },
  engagex: { label: 'EngageX', landingPath: '/engagex', lightLogo: '/engagex/engagex-logo-light.png', darkLogo: '/engagex/engagex-logo-dark.png', collapsedLogo: '/engagex/engagex-icon.png' },
  admin: { label: 'Admin', landingPath: '/admin-dashboard', wordmark: true },
  settings: { label: 'Settings', landingPath: '/settings/general', wordmark: true },
};
const ONE_NEXA = { label: 'OneNexa', landingPath: '/dashboard', lightLogo: '/onenexa-logo.svg', darkLogo: '/onenexa-logo.svg', collapsedLogo: '/onenexa-icon.svg' };
let scheduled = false;
let lastModule = '';

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
// EngageX navigation (module tab + sidebar) is rendered natively by
// DashboardLayout from NAV_GROUPS/SECTION_META and gated by the permission
// matrix; it is no longer injected into the DOM here.
const sync = () => {
  scheduled=false;
  const moduleId=routeModule(); const module=MODULE_BRANDING[moduleId]||MODULE_BRANDING.core;
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
