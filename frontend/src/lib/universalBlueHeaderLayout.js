/* OneNexa platform branding + global blue-header layout normalizer. */
(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const HEADER_MARK = 'data-taskosphere-blue-header-normalized';
  let scheduled = false;
  let observer = null;

  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const hasBlueGradient = (el) => {
    if (!el || !isVisible(el)) return false;
    const image = String(window.getComputedStyle(el).backgroundImage || '').toLowerCase();
    if (!image.includes('gradient')) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < Math.min(window.innerWidth * 0.55, 700) || rect.height > 260) return false;
    const title = el.querySelector('h1');
    if (!title || !isVisible(title)) return false;
    const titleColor = String(window.getComputedStyle(title).color || '').toLowerCase();
    return titleColor === 'rgb(255, 255, 255)' || titleColor === 'white';
  };

  const findActionGroup = (header) => {
    const title = header.querySelector('h1');
    if (!title) return null;
    let row = title.parentElement;
    while (row && row !== header) {
      const action = Array.from(row.children || []).find((child) => {
        if (!child || child === title.parentElement) return false;
        return Array.from(child.children || []).filter((node) => node?.tagName === 'BUTTON').length >= 2;
      });
      if (action) return action;
      row = row.parentElement;
    }
    return Array.from(header.querySelectorAll('div, nav, section')).find((candidate) => {
      const buttons = Array.from(candidate.children || []).filter((node) => node?.tagName === 'BUTTON');
      return buttons.length >= 2 && candidate !== header;
    }) || null;
  };

  const normalize = (header) => {
    if (!hasBlueGradient(header)) return;
    const actionGroup = findActionGroup(header);
    if (!actionGroup) return;
    const buttons = Array.from(actionGroup.children || []).filter((child) => child?.tagName === 'BUTTON' && isVisible(child));
    if (buttons.length < 2) return;

    // Todo Management has only two compact tabs. Do not let the global
    // blue-header normalizer stretch them into a large two-column grid.
    const title = header.querySelector('h1');
    const titleText = String(title?.textContent || '').replace(/\s+/g, ' ').trim();
    if (/^todo management$/i.test(titleText)) {
      const row = actionGroup.parentElement;
      if (row && row !== header) {
        row.style.display = 'flex';
        row.style.gridTemplateColumns = '';
        row.style.columnGap = '';
        row.style.rowGap = '';
        row.style.alignItems = 'center';
        row.style.minWidth = '0';
      }
      actionGroup.style.display = 'inline-flex';
      actionGroup.style.gridTemplateColumns = '';
      actionGroup.style.gridTemplateRows = '';
      actionGroup.style.gridAutoRows = '';
      actionGroup.style.gap = '3px';
      actionGroup.style.width = 'fit-content';
      actionGroup.style.minWidth = '0';
      actionGroup.style.alignItems = 'center';
      actionGroup.style.justifyItems = '';
      actionGroup.style.justifyContent = 'flex-start';
      actionGroup.style.padding = '3px';
      actionGroup.style.borderRadius = '10px';
      buttons.forEach((button) => {
        button.style.width = 'auto';
        button.style.minWidth = '0';
        button.style.maxWidth = 'none';
        button.style.height = '32px';
        button.style.minHeight = '32px';
        button.style.maxHeight = '32px';
        button.style.margin = '0';
        button.style.padding = '4px 10px';
        button.style.justifyContent = 'center';
        button.style.alignItems = 'center';
        button.style.gap = '4px';
        button.style.fontSize = '11px';
        button.style.lineHeight = '13px';
        button.style.whiteSpace = 'nowrap';
        button.style.wordBreak = 'normal';
        button.style.overflowWrap = 'normal';
        button.style.hyphens = 'none';
        button.style.overflow = 'visible';
        button.style.textOverflow = 'clip';
        button.style.boxSizing = 'border-box';
        Array.from(button.querySelectorAll('span')).forEach((span) => {
          span.style.minWidth = '0';
          span.style.maxWidth = 'none';
          span.style.whiteSpace = 'nowrap';
          span.style.wordBreak = 'normal';
          span.style.overflowWrap = 'normal';
          span.style.textOverflow = 'clip';
          span.style.overflow = 'visible';
          span.style.lineHeight = '13px';
          span.style.textAlign = 'center';
        });
      });
      actionGroup.setAttribute(HEADER_MARK, 'true');
      return;
    }

    const columns = Math.min(5, Math.max(2, Math.ceil(buttons.length / 2)));
    const row = actionGroup.parentElement;
    if (row && row !== header) {
      row.style.display = 'grid';
      row.style.gridTemplateColumns = 'minmax(280px, 0.78fr) minmax(0, 1.22fr)';
      row.style.columnGap = '32px';
      row.style.rowGap = '16px';
      row.style.alignItems = 'center';
      row.style.minWidth = '0';
    }
    actionGroup.style.display = 'grid';
    actionGroup.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
    actionGroup.style.gridTemplateRows = 'repeat(2, 36px)';
    actionGroup.style.gridAutoRows = '36px';
    actionGroup.style.gap = '8px';
    actionGroup.style.width = '100%';
    actionGroup.style.minWidth = '0';
    actionGroup.style.alignItems = 'stretch';
    actionGroup.style.justifyItems = 'stretch';
    actionGroup.setAttribute(HEADER_MARK, 'true');
    buttons.forEach((button) => {
      const labelLength = String(button.textContent || '').replace(/\s+/g, ' ').trim().length;
      const fontSize = labelLength > 18 ? '10px' : labelLength > 13 ? '10.5px' : '11px';
      button.style.width = '100%';
      button.style.minWidth = '0';
      button.style.maxWidth = '100%';
      button.style.height = '36px';
      button.style.minHeight = '36px';
      button.style.maxHeight = '36px';
      button.style.margin = '0';
      button.style.padding = '3px 6px';
      button.style.justifyContent = 'center';
      button.style.alignItems = 'center';
      button.style.gap = '4px';
      button.style.fontSize = fontSize;
      button.style.lineHeight = '13px';
      button.style.whiteSpace = 'normal';
      button.style.wordBreak = 'normal';
      button.style.overflowWrap = 'normal';
      button.style.hyphens = 'none';
      button.style.overflow = 'hidden';
      button.style.textOverflow = 'clip';
      button.style.boxSizing = 'border-box';
      Array.from(button.querySelectorAll('span')).forEach((span) => {
        span.style.minWidth = '0';
        span.style.maxWidth = '100%';
        span.style.whiteSpace = 'normal';
        span.style.wordBreak = 'normal';
        span.style.overflowWrap = 'normal';
        span.style.textOverflow = 'clip';
        span.style.overflow = 'visible';
        span.style.lineHeight = '13px';
        span.style.textAlign = 'center';
      });
    });
  };

  const firstLicensedPath = (user) => {
    if (!user || /info\.taskosphere@gmail\.com/i.test(String(user.email || ''))) return null;
    const selected = user.selected_features || user.company?.selected_features || user.license?.selected_features || {};
    const routes = {
      taskosphere: [['can_view_dashboard', '/dashboard'], ['can_view_tasks', '/tasks'], ['can_view_todo_dashboard', '/todos'], ['can_view_attendance', '/attendance'], ['can_view_reminders', '/reminders']],
      finix: [['can_view_accounting_reports', '/finix-dashboard'], ['can_view_sale', '/invoicing'], ['can_view_purchase', '/purchase'], ['can_view_bank', '/bank-accounts'], ['can_view_chart_of_accounts', '/chart-of-accounts'], ['can_view_journal_entries', '/journal-entries']],
      compliance: [['can_view_compliance', '/compliance-dashboard'], ['can_view_gst_reconciliation', '/gst-reconciliation'], ['can_view_trademark_sphere', '/trademark-sphere'], ['can_view_mis_report', '/mis-report'], ['can_view_roc_sphere', '/roc-sphere']],
      records: [['can_view_documents', '/records-dashboard'], ['can_view_all_dsc', '/dsc'], ['can_view_all_clients', '/clients'], ['can_view_passwords', '/passwords']],
      proposals: [['can_view_all_leads', '/client-proposals-dashboard'], ['can_create_quotations', '/quotations'], ['can_view_client_discussion', '/client-discussion']],
      people_matrix: [['can_view_user_page', '/people-matrix'], ['can_view_leave', '/leave'], ['can_view_payroll', '/payroll'], ['can_view_hr', '/hr'], ['can_view_recruitment', '/recruitment'], ['can_view_performance', '/performance']],
    };
    const moduleOrder = ['taskosphere', 'finix', 'compliance', 'records', 'proposals', 'people_matrix'];
    const normalizeKey = (value) => String(value || '').trim().toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_');
    for (const moduleId of moduleOrder) {
      const flags = selected?.[moduleId];
      if (!Array.isArray(flags)) continue;
      const normalized = flags.map(normalizeKey);
      if (normalized.some((flag) => ['all', '*', 'all_features', 'full', 'complete'].includes(flag))) return routes[moduleId][0][1];
      const hit = routes[moduleId].find(([flag]) => normalized.includes(flag));
      if (hit) return hit[1];
    }
    const licensed = [user.licensed_modules, user.company?.licensed_modules, user.modules, user.company?.modules, user.license?.modules].find((value) => Array.isArray(value) && value.length > 0) || [];
    for (const value of licensed) {
      const key = normalizeKey(value);
      if (key === 'taskosphere' || key === 'tasks') return '/dashboard';
      if (key === 'finix' || key === 'invoicing' || key === 'accounting') return '/finix-dashboard';
      if (key === 'compliance') return '/compliance-dashboard';
      if (key === 'records') return '/records-dashboard';
      if (key === 'proposals' || key === 'client_proposals') return '/client-proposals-dashboard';
      if (key === 'people_matrix' || key === 'hrms' || key === 'peoplematrix') return '/people-matrix';
    }
    return null;
  };

  const enforceLicensedLanding = () => {
    const root = document.getElementById('root');
    if (!root) return;
    let user = null;
    try { user = JSON.parse(localStorage.getItem('user') || sessionStorage.getItem('user') || 'null'); } catch {}
    const destination = firstLicensedPath(user);
    if (!destination || destination === window.location.pathname) return;
    if (window.location.pathname === '/login' || window.location.pathname === '/dashboard') {
      window.history.replaceState({}, '', destination);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  };

  const normalizeOneNexaLogin = () => {
    const root = document.getElementById('root');
    if (!root || !root.querySelector('input[autocomplete="email"]')) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let current;
    while ((current = walker.nextNode())) textNodes.push(current);
    textNodes.forEach((node) => {
      if (node.parentElement?.closest('script,style')) return;
      if (node.nodeValue && /taskosphere/i.test(node.nodeValue)) node.nodeValue = node.nodeValue.replace(/taskosphere/gi, 'OneNexa');
    });
    root.querySelectorAll('img').forEach((img) => {
      const alt = String(img.getAttribute('alt') || '').toLowerCase();
      const src = String(img.getAttribute('src') || '').toLowerCase();
      if (alt.includes('taskosphere') || src.endsWith('/logo.png') || src.includes('taskosphere')) {
        img.setAttribute('src', '/onenexa-logo.png');
        img.setAttribute('alt', 'OneNexa');
        img.style.objectFit = 'contain';
        img.style.background = 'transparent';
      }
    });
  };

  const sync = () => {
    scheduled = false;
    const root = document.getElementById('root');
    if (!root) return;
    Array.from(root.querySelectorAll('main div, main section, main header')).forEach(normalize);
    normalizeOneNexaLogin();
    enforceLicensedLanding();
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    if (window.requestAnimationFrame) window.requestAnimationFrame(sync);
    else window.setTimeout(sync, 0);
  };

  const start = () => {
    if (observer) observer.disconnect();
    observer = new MutationObserver(schedule);
    observer.observe(document.getElementById('root') || document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('popstate', schedule);
    window.addEventListener('storage', schedule);
    schedule();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
