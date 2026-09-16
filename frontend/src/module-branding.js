/*
 * Shared module branding for the commercial shell.
 * Keeps module identity in one place without coupling dashboard pages to the
 * global header. Navigation remains the source of truth for active module.
 *
 * IMPORTANT: Product labels are intentionally kept here as a single runtime
 * compatibility layer. Internal route names, permission identifiers and API
 * names remain unchanged so existing integrations are not disturbed.
 */
const MODULE_BRANDING = {
  core: { label: 'Taskosphere', landingPath: '/dashboard', lightLogo: '/logo-lite.png', darkLogo: '/logo-dark.png', collapsedLogo: '/icon-192.png', alt: 'Task-O-Sphere' },
  accounts: { label: 'Finix', landingPath: '/finix-dashboard', lightLogo: '/finix-logo.png', darkLogo: '/finix-logo.png', collapsedLogo: '/finix-icon.png', alt: 'Finix AI Accounting' },
  compliance: { label: 'CompliGenie', landingPath: '/compliance-dashboard', lightLogo: '/compligenie-logo.png.png', darkLogo: '/compligenie-logo.png.png', collapsedLogo: '/compligenie-logo.png.png', alt: 'CompliGenie' },
  proposals: { label: 'LeadSense', landingPath: '/client-proposals-dashboard', lightLogo: '/leadsense-logo.png', darkLogo: '/leadsense-logo.png', collapsedLogo: '/leadsense-logo.png', alt: 'LeadSense' },
  'people-matrix': { label: 'People Matrix', landingPath: '/people-matrix', lightLogo: '/people-matrix-logo.png', darkLogo: '/people-matrix-logo.png', collapsedLogo: '/people-matrix-logo.png', alt: 'People Matrix' },
};

const FALLBACK = MODULE_BRANDING.core;
let scheduled = false;
let lastModuleId = '';

const getRouteModuleId = () => {
  const path = window.location.pathname || '';
  if (
    path === '/compliance-dashboard' || path === '/compliance' || path.startsWith('/compliance/') ||
    path === '/gst-reconciliation' || path.startsWith('/gst-reconciliation/') ||
    path === '/trademark-sphere' || path.startsWith('/trademark-sphere/') ||
    path === '/roc-sphere' || path.startsWith('/roc-sphere/') ||
    path === '/mis-report' || path.startsWith('/mis-report/') ||
    path === '/salary-slips' || path.startsWith('/salary-slips/')
  ) return 'compliance';
  if (path === '/client-proposals-dashboard' || path.startsWith('/leads/') || path === '/leads' || path.startsWith('/quotations/') || path === '/quotations' || path.startsWith('/client-discussion/') || path === '/client-discussion') return 'proposals';
  if (path === '/finix-dashboard' || path.startsWith('/invoicing') || path.startsWith('/purchase') || path.startsWith('/bank-accounts') || path.startsWith('/journal-entries')) return 'accounts';
  if (path === '/people-matrix' || path.startsWith('/users') || path.startsWith('/leave') || path.startsWith('/payroll') || path.startsWith('/hr') || path.startsWith('/recruitment')) return 'people-matrix';
  return null;
};

const getActiveModuleId = () => {
  const activeTab = document.querySelector('#top-module-switcher-bar [id^="nav-tab-"].font-semibold');
  const moduleId = (activeTab?.id || '').replace(/^nav-tab-/, '');
  return MODULE_BRANDING[moduleId] ? moduleId : (getRouteModuleId() || 'core');
};

const setTabLabel = (id, label) => {
  const tab = document.querySelector(id);
  if (!tab) return;
  const labelNode = tab.querySelector('span');
  if (labelNode && labelNode.textContent !== label) labelNode.textContent = label;
  tab.setAttribute('aria-label', label);
  tab.setAttribute('title', label);
};

const renameNavigation = () => {
  setTabLabel('#nav-tab-proposals', 'LeadSense');
  setTabLabel('#nav-tab-compliance', 'CompliGenie');
};

const renameSidebarText = (from, to) => {
  document.querySelectorAll('aside a, aside button').forEach((node) => {
    const text = node.querySelector('span:last-child') || node;
    if (String(text.textContent || '').trim() === from) text.textContent = to;
  });
};

const renameSidebarDivider = (from, to) => {
  Array.from(document.querySelectorAll('aside')).flatMap((aside) => Array.from(aside.querySelectorAll('*'))).forEach((node) => {
    if (String(node.textContent || '').trim() === from && node.children.length === 0) node.textContent = to;
  });
};

const isDarkMode = () => document.documentElement.classList.contains('dark') || document.body.classList.contains('dark');

const syncModuleBranding = () => {
  scheduled = false;
  renameNavigation();
  const moduleId = getActiveModuleId();
  const branding = MODULE_BRANDING[moduleId] || FALLBACK;
  const header = document.querySelector('header.fixed');
  if (!header) return;

  const logoLink = header.querySelector('a[href="/dashboard"]') || header.querySelector('a.relative.flex.items-center');
  const logoImages = logoLink?.querySelectorAll('img') || [];
  const visibleLogo = Array.from(logoImages).find((img) => getComputedStyle(img).display !== 'none') || logoImages[logoImages.length - 1];
  if (!logoLink || !visibleLogo) return;

  const brandColumn = header.firstElementChild;
  const collapsed = Boolean(brandColumn && brandColumn.getBoundingClientRect().width <= 100);
  const logoSrc = collapsed ? branding.collapsedLogo : (isDarkMode() ? branding.darkLogo : branding.lightLogo);

  if (logoLink.getAttribute('href') !== branding.landingPath) logoLink.setAttribute('href', branding.landingPath);
  if (visibleLogo.getAttribute('src') !== logoSrc) visibleLogo.setAttribute('src', logoSrc);
  if (visibleLogo.getAttribute('alt') !== branding.alt) visibleLogo.setAttribute('alt', branding.alt);
  visibleLogo.setAttribute('aria-label', branding.alt);
  visibleLogo.style.display = 'block';
  visibleLogo.style.objectFit = 'contain';
  visibleLogo.style.objectPosition = 'center center';
  visibleLogo.style.flexShrink = '0';
  visibleLogo.style.maxWidth = '100%';
  visibleLogo.style.margin = '0 auto';
  visibleLogo.style.transform = 'translateY(0)';

  if (moduleId === 'proposals' || moduleId === 'people-matrix' || moduleId === 'compliance') {
    visibleLogo.style.background = '#ffffff';
    visibleLogo.style.borderRadius = '8px';
    visibleLogo.style.padding = '0';
  } else {
    visibleLogo.style.background = '';
    visibleLogo.style.borderRadius = '';
    visibleLogo.style.padding = '';
  }

  if (moduleId === 'compliance') {
    const complianceTab = document.querySelector('#nav-tab-compliance');
    if (complianceTab) {
      complianceTab.style.borderBottom = '2px solid #1F6FB2';
      complianceTab.style.color = '#0D3B66';
    }
    visibleLogo.style.width = collapsed ? '54px' : '185px';
    visibleLogo.style.height = collapsed ? '54px' : '50px';
  }

  if (moduleId === 'proposals') {
    const title = header.querySelector('h1');
    if (title) title.textContent = 'LeadSense';
    renameSidebarText('Client Proposals Dashboard', 'LeadSense Dashboard');
    renameSidebarDivider('Client Proposals', 'LeadSense');
    document.title = 'LeadSense Dashboard · Task-O-Sphere';
  }

  if (moduleId === 'compliance') {
    const title = header.querySelector('h1');
    if (title) title.textContent = 'CompliGenie';
    renameSidebarText('Compliance Dashboard', 'CompliGenie Dashboard');
    renameSidebarDivider('Compliance', 'CompliGenie');
    document.title = 'CompliGenie Dashboard · Task-O-Sphere';
  }

  lastModuleId = moduleId;
};

const scheduleSync = () => {
  if (scheduled) return;
  scheduled = true;
  window.setTimeout(syncModuleBranding, 0);
};

const observer = new MutationObserver(scheduleSync);
const start = () => {
  observer.observe(document.getElementById('root') || document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'src', 'href'] });
  scheduleSync();
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();

window.addEventListener('popstate', scheduleSync);
document.addEventListener('click', (event) => {
  if (event.target?.closest?.('#top-module-switcher-bar button, header a[href], aside a, aside button')) scheduleSync();
}, true);
window.setInterval(() => {
  if (lastModuleId !== getActiveModuleId()) scheduleSync();
}, 500);
