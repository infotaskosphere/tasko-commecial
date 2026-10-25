/* Shared module branding for the commercial shell. */
const MODULE_BRANDING = {
  core: { label: 'Taskosphere', landingPath: '/dashboard', lightLogo: '/logo-lite.png', darkLogo: '/logo-dark.png', collapsedLogo: '/icon-192.png', alt: 'Task-O-Sphere' },
  accounts: { label: 'Finix', landingPath: '/finix-dashboard', lightLogo: '/finix-logo.png', darkLogo: '/finix-logo.png', collapsedLogo: '/finix-icon.png', alt: 'Finix AI Accounting' },
  compliance: { label: 'CompliGenie', landingPath: '/compliance-dashboard', lightLogo: '/compligenie-logo.png', darkLogo: '/compligenie-logo.png', collapsedLogo: '/compligenie-icon.svg', alt: 'CompliGenie' },
  proposals: { label: 'LeadSense', landingPath: '/client-proposals-dashboard', lightLogo: '/leadsense-logo.png', darkLogo: '/leadsense-logo.png', collapsedLogo: '/leadsense-logo.png', alt: 'LeadSense' },
  'people-matrix': { label: 'People Matrix', landingPath: '/people-matrix', lightLogo: '/people-matrix-logo.png', darkLogo: '/people-matrix-logo.png', collapsedLogo: '/people-matrix-logo.png', alt: 'People Matrix' },
  aiweave: { label: 'AIWeave', landingPath: '/aiweave', lightLogo: '/aiweave-logo-lite.png', darkLogo: '/aiweave-logo-dark.png', collapsedLogo: '/aiweave-icon.png', alt: 'AIWeave' },
  records: { label: 'ClientSync', landingPath: '/records-dashboard', lightLogo: '/clientsync-logo-light.png', darkLogo: '/clientsync-logo-dark.png', collapsedLogo: '/clientsync-icon-light.png', collapsedLogoDark: '/clientsync-icon-dark.png', alt: 'ClientSync' },
  engagex: { label: 'EngageX', landingPath: '/engagex', lightLogo: '/engagex/engagex-logo.svg', darkLogo: '/engagex/engagex-logo-dark.svg', collapsedLogo: '/engagex/engagex-icon.svg', alt: 'EngageX' },
  admin: { label: 'Admin', landingPath: '/admin-dashboard', wordmark: true, alt: 'Admin' },
  settings: { label: 'Setting', landingPath: '/settings/general', wordmark: true, alt: 'Setting' },
};
const AIWEAVE_INLINE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="96" viewBox="0 0 420 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0D3B66"/><stop offset=".55" stop-color="#1F6FB2"/><stop offset="1" stop-color="#1FAF5A"/></linearGradient></defs><g transform="translate(8 8)"><circle cx="40" cy="40" r="34" fill="#fff" stroke="url(#g)" stroke-width="5"/><path d="M21 45c7-18 18-25 31-18 7 4 11 11 7 20-4 10-16 14-27 8" fill="none" stroke="url(#g)" stroke-width="5" stroke-linecap="round"/><path d="M25 29c6 9 15 12 28 8M27 56c7-7 15-11 28-10" fill="none" stroke="#1FAF5A" stroke-width="4" stroke-linecap="round"/><circle cx="20" cy="45" r="4" fill="#1F6FB2"/><circle cx="52" cy="27" r="4" fill="#1FAF5A"/><circle cx="58" cy="48" r="4" fill="#0D3B66"/></g><text x="96" y="61" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="42" font-weight="700" fill="#0D3B66">AI</text><text x="145" y="61" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="42" font-weight="700" fill="#1FAF5A">Weave</text></svg>';
const INLINE_FALLBACK_LOGOS = { aiweave: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(AIWEAVE_INLINE_SVG) };
const failedLogos = new Set();
const FALLBACK = MODULE_BRANDING.core;
let scheduled = false;
let lastModuleId = '';

const hasEngageXEntitlement = () => {
  try {
    const raw = sessionStorage.getItem('user') || localStorage.getItem('user');
    if (!raw) return false;
    const user = JSON.parse(raw);
    const modules = [user?.licensed_modules, user?.modules, user?.company?.licensed_modules, user?.company?.modules, user?.license?.modules].find(v => Array.isArray(v) && v.length) || [];
    return modules.some(v => String(v).trim().toLowerCase().replace(/-/g, '_') === 'engagex') || user?.permissions?.can_access_engagex === true;
  } catch { return false; }
};

const getRouteModuleId = () => {
  const path = window.location.pathname || '';
  if (path === '/engagex' || path.startsWith('/engagex/')) return 'engagex';
  if (path === '/compliance-dashboard' || path === '/compliance' || path.startsWith('/compliance/') || path === '/gst-reconciliation' || path.startsWith('/gst-reconciliation/') || path === '/trademark-sphere' || path.startsWith('/trademark-sphere/') || path === '/roc-sphere' || path.startsWith('/roc-sphere/') || path === '/mis-report' || path.startsWith('/mis-report/') || path === '/salary-slips' || path.startsWith('/salary-slips/')) return 'compliance';
  if (path === '/client-proposals-dashboard' || path.startsWith('/leads/') || path === '/leads' || path.startsWith('/quotations/') || path === '/quotations' || path.startsWith('/client-discussion/') || path === '/client-discussion') return 'proposals';
  if (path === '/finix-dashboard' || path.startsWith('/invoicing') || path.startsWith('/purchase') || path.startsWith('/bank-accounts') || path.startsWith('/journal-entries') || path === '/chart-of-accounts' || path === '/zero-touch-entry' || path === '/accounting-reports' || path === '/accounting-books' || path === '/day-book') return 'accounts';
  if (path === '/people-matrix' || path.startsWith('/users') || path.startsWith('/leave') || path.startsWith('/payroll') || path.startsWith('/hr') || path.startsWith('/recruitment')) return 'people-matrix';
  if (path === '/aiweave' || path.startsWith('/aiweave/')) return 'aiweave';
  if (path === '/records-dashboard' || path === '/dsc' || path === '/documents' || path === '/clients' || path === '/passwords' || path === '/client-approvals') return 'records';
  if (path === '/admin-dashboard' || path.startsWith('/admin/')) return 'admin';
  if (path === '/settings' || path.startsWith('/settings/')) return 'settings';
  return null;
};
const getActiveModuleId = () => { const routeModuleId = getRouteModuleId(); if (routeModuleId) return routeModuleId; const activeTab = document.querySelector('#top-module-switcher-bar [id^="nav-tab-"][data-active="true"], #top-module-switcher-bar [id^="nav-tab-"][aria-current="page"], #top-module-switcher-bar [id^="nav-tab-"].font-semibold'); const moduleId = (activeTab?.id || '').replace(/^nav-tab-/, ''); return MODULE_BRANDING[moduleId] ? moduleId : 'core'; };
const setTabLabel = (id, label) => { const tab = document.querySelector(id); if (!tab) return; const labelNode = tab.querySelector('span'); if (labelNode && labelNode.textContent !== label) labelNode.textContent = label; tab.setAttribute('aria-label', label); tab.setAttribute('title', label); };

const ensureEngageXTab = () => {
  const bar = document.getElementById('top-module-switcher-bar');
  const entitled = hasEngageXEntitlement();
  const existing = document.getElementById('nav-tab-engagex');
  if (!entitled) { existing?.remove(); return; }
  if (!bar || existing) return;
  const anchor = document.createElement('a');
  anchor.id = 'nav-tab-engagex'; anchor.href = '/engagex';
  anchor.className = 'inline-flex items-center gap-2 px-3 py-2 text-sm font-medium whitespace-nowrap text-slate-600 hover:text-slate-900';
  anchor.innerHTML = '<img src="/engagex/engagex-icon.svg" alt="" aria-hidden="true" style="width:18px;height:18px;object-fit:contain"/><span>EngageX</span>';
  anchor.addEventListener('click', () => window.setTimeout(scheduleSync, 0));
  bar.appendChild(anchor);
};

const ensureEngageXSidebar = (active) => {
  const aside = document.querySelector('aside'); if (!aside) return;
  const existing = aside.querySelector('[data-engagex-sidebar="true"]');
  if (!active) { existing?.remove(); aside.querySelectorAll('[data-engagex-hidden="true"]').forEach(node => { node.style.display = ''; node.removeAttribute('data-engagex-hidden'); }); return; }
  const engagePaths = new Set(['/engagex', '/engagex/whatsapp', '/engagex/mailmaster']);
  aside.querySelectorAll('a[href], button').forEach(node => { const href = node.getAttribute('href') || ''; const isEngage = href && Array.from(engagePaths).some(path => href === path || href.startsWith(`${path}/`)); if (!isEngage && !node.closest('[data-engagex-sidebar="true"]') && !node.closest('[data-onenexa-shell]') && node.textContent.trim() && !node.textContent.includes('Collapse Sidebar')) { node.style.display = 'none'; node.setAttribute('data-engagex-hidden', 'true'); } });
  if (existing) return;
  const block = document.createElement('div'); block.dataset.engagexSidebar = 'true'; block.className = 'space-y-1 px-2 py-3';
  block.innerHTML = '<div class="mb-2 flex items-center gap-2 rounded-lg bg-slate-800/40 px-3 py-2 text-xs font-bold uppercase tracking-wider text-cyan-200"><img src="/engagex/engagex-icon.svg" alt="" style="width:22px;height:22px;object-fit:contain"/><span>EngageX</span></div><a href="/engagex" class="flex items-center gap-3 rounded-lg bg-slate-800 px-3 py-3 text-sm font-semibold text-white hover:bg-slate-700"><span>◈</span><span>Dashboard</span></a><a href="/engagex/whatsapp" class="flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium text-slate-200 hover:bg-slate-800"><span>◉</span><span>WhatsApp Hub</span></a><a href="/engagex/mailmaster" class="flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium text-slate-200 hover:bg-slate-800"><span>✉</span><span>MailMaster</span></a>';
  const collapse = Array.from(aside.querySelectorAll('*')).find(node => node.textContent?.trim() === 'Collapse Sidebar');
  (collapse?.parentElement || aside).prepend(block);
};

const renameNavigation = () => { setTabLabel('#nav-tab-core', 'Taskosphere'); setTabLabel('#nav-tab-accounts', 'Finix'); setTabLabel('#nav-tab-aiweave', 'AIWeave'); setTabLabel('#nav-tab-compliance', 'CompliGenie'); setTabLabel('#nav-tab-records', 'ClientSync'); setTabLabel('#nav-tab-proposals', 'LeadSense'); setTabLabel('#nav-tab-people-matrix', 'People Matrix'); ensureEngageXTab(); };
const renameSidebarText = (from, to) => { document.querySelectorAll('aside a, aside button').forEach(node => { const text = node.querySelector('span:last-child') || node; if (String(text.textContent || '').trim() === from) text.textContent = to; }); };
const renameSidebarDivider = (from, to) => { Array.from(document.querySelectorAll('aside')).flatMap(aside => Array.from(aside.querySelectorAll('*'))).forEach(node => { if (String(node.textContent || '').trim() === from && node.children.length === 0) node.textContent = to; }); };
const isDarkMode = () => document.documentElement.classList.contains('dark') || document.body.classList.contains('dark');

const syncModuleBranding = () => {
  scheduled = false; renameNavigation();
  const moduleId = getActiveModuleId(); const branding = MODULE_BRANDING[moduleId] || FALLBACK;
  ensureEngageXSidebar(moduleId === 'engagex');
  if (branding.wordmark) { lastModuleId = moduleId; return; }
  const header = document.querySelector('header.fixed'); if (!header) return;
  const logoLink = header.querySelector('a[href="/dashboard"]') || header.querySelector('a.relative.flex.items-center'); if (!logoLink) return;
  const logoImages = Array.from(logoLink.querySelectorAll('img')); const visibleLogo = logoImages.find(img => getComputedStyle(img).display !== 'none') || logoImages[logoImages.length - 1]; if (!visibleLogo) return;
  const brandColumn = header.firstElementChild; const collapsed = Boolean(brandColumn && brandColumn.getBoundingClientRect().width <= 100);
  let logoSrc = collapsed ? ((isDarkMode() && branding.collapsedLogoDark) || branding.collapsedLogo) : (isDarkMode() ? branding.darkLogo : branding.lightLogo);
  if (failedLogos.has(logoSrc) && INLINE_FALLBACK_LOGOS[moduleId]) logoSrc = INLINE_FALLBACK_LOGOS[moduleId];
  if (logoLink.getAttribute('href') !== branding.landingPath) logoLink.setAttribute('href', branding.landingPath);
  if (visibleLogo.getAttribute('src') !== logoSrc) visibleLogo.setAttribute('src', logoSrc);
  if (visibleLogo.getAttribute('alt') !== branding.alt) visibleLogo.setAttribute('alt', branding.alt);
  if (!visibleLogo.dataset.brandingFallbackBound) { visibleLogo.dataset.brandingFallbackBound = 'true'; visibleLogo.addEventListener('error', () => { const failed = visibleLogo.getAttribute('src'); if (!failed || failed.startsWith('data:') || failedLogos.has(failed)) return; failedLogos.add(failed); scheduleSync(); }); }
  visibleLogo.setAttribute('aria-label', branding.alt); visibleLogo.style.display = 'block'; visibleLogo.style.objectFit = 'contain'; visibleLogo.style.objectPosition = 'center center'; visibleLogo.style.flexShrink = '0'; visibleLogo.style.maxWidth = '100%'; visibleLogo.style.margin = '0 auto'; visibleLogo.style.transform = 'translateY(0)'; visibleLogo.style.width = collapsed ? '58px' : '205px'; visibleLogo.style.height = collapsed ? '58px' : (moduleId === 'engagex' ? '58px' : '56px'); visibleLogo.style.background = ''; visibleLogo.style.borderRadius = ''; visibleLogo.style.padding = '0';
  const headerTitle = header.querySelector('h1');
  if (headerTitle) { headerTitle.textContent = branding.label; headerTitle.setAttribute('aria-label', branding.label); const modulePill = headerTitle.nextElementSibling; if (modulePill?.querySelectorAll) { const pillSpans = modulePill.querySelectorAll(':scope > span'); if (pillSpans.length >= 3) { pillSpans[0].style.display = 'none'; pillSpans[1].style.display = 'none'; } } }
  if (moduleId === 'engagex') document.title = 'EngageX · OneNexa';
  if (moduleId === 'proposals') { renameSidebarText('Client Proposals Dashboard', 'LeadSense Dashboard'); renameSidebarDivider('Client Proposals', 'LeadSense'); document.title = 'LeadSense Dashboard · OneNexa'; }
  if (moduleId === 'records') { renameSidebarText('Records Dashboard', 'ClientSync Dashboard'); renameSidebarDivider('Records', 'ClientSync'); document.title = 'ClientSync · OneNexa'; }
  if (moduleId === 'compliance') { renameSidebarText('Compliance Dashboard', 'CompliGenie Dashboard'); renameSidebarDivider('Compliance', 'CompliGenie'); document.title = 'CompliGenie Dashboard · OneNexa'; }
  if (window.location.pathname.startsWith('/master-console')) { document.querySelectorAll('span,div,p').forEach(node => { if (node.children.length === 0 && String(node.textContent || '').trim().toLowerCase() === 'engagex') node.textContent = 'EngageX'; }); }
  lastModuleId = moduleId;
};

const scheduleSync = () => { if (scheduled) return; scheduled = true; window.setTimeout(syncModuleBranding, 0); };
const observer = new MutationObserver(scheduleSync);
const start = () => { observer.observe(document.getElementById('root') || document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'src', 'href'] }); scheduleSync(); };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
window.addEventListener('popstate', scheduleSync);
document.addEventListener('click', event => { if (event.target?.closest?.('#top-module-switcher-bar button, #top-module-switcher-bar a, header a[href], aside a, aside button')) scheduleSync(); }, true);
window.setInterval(() => { if (lastModuleId !== getActiveModuleId()) scheduleSync(); }, 2000);
