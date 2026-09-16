/*
 * Shared module branding for the commercial shell.
 * Keeps module identity in one place without coupling dashboard pages to the
 * global header. Navigation remains the source of truth for active module.
 */
const MODULE_BRANDING = {
  core: { label: 'Taskosphere', landingPath: '/dashboard', lightLogo: '/logo-lite.png', darkLogo: '/logo-dark.png', collapsedLogo: '/icon-192.png', alt: 'Task-O-Sphere' },
  accounts: { label: 'Finix', landingPath: '/finix-dashboard', lightLogo: '/finix-logo.png', darkLogo: '/finix-logo.png', collapsedLogo: '/finix-icon.png', alt: 'Finix AI Accounting' },
  proposals: { label: 'LeadSense', landingPath: '/client-proposals-dashboard', lightLogo: '/leadsense-logo.svg', darkLogo: '/leadsense-logo.svg', collapsedLogo: '/leadsense-logo.svg', alt: 'LeadSense' },
  'people-matrix': { label: 'People Matrix', landingPath: '/people-matrix', lightLogo: '/people-matrix-logo.png', darkLogo: '/people-matrix-logo.png', collapsedLogo: '/people-matrix-logo.png', alt: 'People Matrix' },
};

const FALLBACK = MODULE_BRANDING.core;
let scheduled = false;
let lastModuleId = '';

const getActiveModuleId = () => {
  const activeTab = document.querySelector('#top-module-switcher-bar [id^="nav-tab-"].font-semibold');
  const moduleId = (activeTab?.id || '').replace(/^nav-tab-/, '');
  return MODULE_BRANDING[moduleId] ? moduleId : 'core';
};

const isDarkMode = () => document.documentElement.classList.contains('dark') || document.body.classList.contains('dark');

const syncModuleBranding = () => {
  scheduled = false;
  const moduleId = getActiveModuleId();
  const branding = MODULE_BRANDING[moduleId] || FALLBACK;
  const header = document.querySelector('header.fixed');
  if (!header) return;

  const logoLink = header.querySelector('a[href="/dashboard"]') || header.querySelector('a.relative.flex.items-center');
  const logoImages = logoLink?.querySelectorAll('img') || [];
  const visibleLogo = Array.from(logoImages).find((img) => getComputedStyle(img).display !== 'none') || logoImages[logoImages.length - 1];
  if (!logoLink || !visibleLogo) return;

  // Read collapsed state from the shell column, not the current image source.
  // This keeps the correct icon when switching between modules while collapsed.
  const brandColumn = header.firstElementChild;
  const collapsed = Boolean(brandColumn && brandColumn.getBoundingClientRect().width <= 100);
  const logoSrc = collapsed ? branding.collapsedLogo : (isDarkMode() ? branding.darkLogo : branding.lightLogo);

  if (logoLink.getAttribute('href') !== branding.landingPath) logoLink.setAttribute('href', branding.landingPath);
  if (visibleLogo.getAttribute('src') !== logoSrc) visibleLogo.setAttribute('src', logoSrc);
  if (visibleLogo.getAttribute('alt') !== branding.alt) visibleLogo.setAttribute('alt', branding.alt);
  visibleLogo.setAttribute('aria-label', branding.alt);
  visibleLogo.style.objectFit = 'contain';

  if (moduleId === 'proposals' || moduleId === 'people-matrix') {
    visibleLogo.style.background = '#ffffff';
    visibleLogo.style.borderRadius = '8px';
    visibleLogo.style.padding = '2px';
  } else {
    visibleLogo.style.background = '';
    visibleLogo.style.borderRadius = '';
    visibleLogo.style.padding = '';
  }

  // Rename only visible proposal-module labels. Routes, APIs and permission
  // identifiers remain unchanged for backward compatibility.
  if (moduleId === 'proposals') {
    const title = header.querySelector('h1');
    if (title) title.textContent = 'LeadSense';
    const proposalTab = document.querySelector('#nav-tab-proposals');
    if (proposalTab) {
      const label = proposalTab.querySelector('span');
      if (label) label.textContent = 'LeadSense';
      proposalTab.setAttribute('aria-label', 'LeadSense');
    }
    document.querySelectorAll('aside a, aside button').forEach((node) => {
      const text = node.querySelector('span:last-child') || node;
      if (String(text.textContent || '').trim() === 'Client Proposals Dashboard') text.textContent = 'LeadSense Dashboard';
    });
    const divider = Array.from(document.querySelectorAll('aside')).flatMap((aside) => Array.from(aside.querySelectorAll('*'))).find((node) => String(node.textContent || '').trim() === 'Client Proposals');
    if (divider) divider.textContent = 'LeadSense';
    document.title = 'LeadSense Dashboard · Task-O-Sphere';
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
