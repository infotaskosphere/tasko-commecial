/*
 * Global blue-header layout normalizer.
 *
 * Different commercial pages historically built their blue action headers
 * independently. This keeps the existing page markup/actions intact while
 * normalizing the action area into two balanced rows with equal button sizes
 * and consistent gaps across every module.
 */
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
    const style = window.getComputedStyle(el);
    const image = String(style.backgroundImage || '').toLowerCase();
    if (!image.includes('gradient')) return false;

    // Require a substantial page-level card/header so ordinary gradient
    // buttons, avatars and small decorative elements are never normalized.
    const rect = el.getBoundingClientRect();
    if (rect.width < Math.min(window.innerWidth * 0.55, 700)) return false;
    if (rect.height > 260) return false;

    const title = el.querySelector('h1');
    if (!title || !isVisible(title)) return false;

    const titleStyle = window.getComputedStyle(title);
    const titleColor = String(titleStyle.color || '').toLowerCase();
    return titleColor === 'rgb(255, 255, 255)' || titleColor === 'white';
  };

  const findActionGroup = (header) => {
    const title = header.querySelector('h1');
    if (!title) return null;

    // Walk upward from the title until the sibling action group is found.
    // This matches the shared pattern used by Tasks, Finix, Records,
    // People Matrix and the accounting/compliance pages without requiring
    // every page to use one exact Tailwind class list.
    let row = title.parentElement;
    while (row && row !== header) {
      const children = Array.from(row.children || []);
      const action = children.find((child) => {
        if (!child || child === title.parentElement) return false;
        return child.querySelectorAll?.(':scope > button').length >= 2;
      });
      if (action) return action;
      row = row.parentElement;
    }

    // Fallback for pages where the buttons are nested one level deeper.
    const candidates = Array.from(header.querySelectorAll('div, nav, section'));
    return candidates.find((candidate) => {
      const buttons = candidate.querySelectorAll?.(':scope > button') || [];
      return buttons.length >= 2 && candidate !== header;
    }) || null;
  };

  const normalize = (header) => {
    if (!hasBlueGradient(header)) return;

    const actionGroup = findActionGroup(header);
    if (!actionGroup) return;

    const buttons = Array.from(actionGroup.children || []).filter((child) => {
      return child?.matches?.(':scope > button') && isVisible(child);
    });
    if (buttons.length < 2) return;

    const columns = Math.max(2, Math.ceil(buttons.length / 2));

    // Keep the title and actions in a predictable desktop two-column header.
    // On narrow screens the title stacks above the action grid.
    const row = actionGroup.parentElement;
    if (row && row !== header) {
      row.style.display = 'grid';
      row.style.gridTemplateColumns = 'minmax(280px, 0.78fr) minmax(0, 1.22fr)';
      row.style.columnGap = '32px';
      row.style.rowGap = '16px';
      row.style.alignItems = 'center';
      row.dataset.taskosphereBlueHeaderRow = 'true';
    }

    actionGroup.style.display = 'grid';
    actionGroup.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
    actionGroup.style.gridTemplateRows = 'repeat(2, minmax(36px, auto))';
    actionGroup.style.gridAutoRows = '36px';
    actionGroup.style.gap = '8px';
    actionGroup.style.width = '100%';
    actionGroup.style.minWidth = '0';
    actionGroup.style.alignItems = 'stretch';
    actionGroup.style.flexWrap = 'nowrap';
    actionGroup.setAttribute(HEADER_MARK, 'true');
    actionGroup.dataset.buttonCount = String(buttons.length);

    buttons.forEach((button) => {
      button.style.width = '100%';
      button.style.minWidth = '0';
      button.style.height = '36px';
      button.style.minHeight = '36px';
      button.style.margin = '0';
      button.style.justifyContent = 'center';
      button.style.whiteSpace = 'nowrap';
      button.style.overflow = 'hidden';
      button.style.textOverflow = 'ellipsis';
      button.style.boxSizing = 'border-box';
    });
  };

  const sync = () => {
    scheduled = false;
    const root = document.getElementById('root');
    if (!root) return;

    // Only inspect reasonably small gradient cards that contain a page title.
    const candidates = Array.from(root.querySelectorAll('main div, main section, main header'));
    candidates.forEach(normalize);
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame ? window.requestAnimationFrame(sync) : window.setTimeout(sync, 0);
  };

  const start = () => {
    if (observer) observer.disconnect();
    observer = new MutationObserver(schedule);
    observer.observe(document.getElementById('root') || document.body, {
      childList: true,
      subtree: true,
    });
    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('popstate', schedule);
    schedule();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
