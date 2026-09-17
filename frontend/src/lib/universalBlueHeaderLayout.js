/*
 * Global blue-header layout normalizer.
 * Keeps existing page markup/actions intact and standardizes the action area
 * into two balanced rows with equal button sizes and readable labels.
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

    // Keep a maximum of five columns so long labels still have enough room.
    // The same grid width is used for every button, including the second row.
    const columns = Math.min(5, Math.max(2, Math.ceil(buttons.length / 2)));
    const row = actionGroup.parentElement;

    if (row && row !== header) {
      row.style.display = 'grid';
      row.style.gridTemplateColumns = 'minmax(280px, 0.78fr) minmax(0, 1.22fr)';
      row.style.columnGap = '32px';
      row.style.rowGap = '16px';
      row.style.alignItems = 'center';
      row.style.minWidth = '0';
      row.dataset.taskosphereBlueHeaderRow = 'true';
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
    actionGroup.style.flexWrap = 'nowrap';
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

      // Keep any existing label/icon spans shrinkable so the label wraps at
      // spaces instead of being clipped from the side or through the middle.
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

  const sync = () => {
    scheduled = false;
    const root = document.getElementById('root');
    if (!root) return;
    Array.from(root.querySelectorAll('main div, main section, main header')).forEach(normalize);
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
    schedule();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
