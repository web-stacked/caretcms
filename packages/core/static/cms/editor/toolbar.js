function getToolbarNavLinks(pagePath) {
  const links = [];
  const headerNav = document.querySelector('#main-header nav');
  if (!headerNav) return links;

  headerNav.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    const label = a.textContent?.trim();
    if (href && label && href.startsWith('/')) {
      const isActive = pagePath === href || (href !== '/' && pagePath.startsWith(href));
      links.push({ href, label, isActive });
    }
  });
  return links;
}

function renderToolbar(navLinks) {
  const navLinksHtml = navLinks
    .map(
      ({ href, label, isActive }) =>
        `<a href="${href}" class="cms-nav-link ${isActive ? 'active' : ''}">${label}</a>`,
    )
    .join('');

  const toolbar = document.createElement('div');
  toolbar.className = 'cms-toolbar';
  toolbar.innerHTML = `
    <div class="cms-toolbar-inner">
      <div class="cms-toolbar-left">
        <div class="cms-toolbar-badge">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 9l10 13 10-13L12 2zm0 3.84L18.26 9 12 17.65 5.74 9 12 5.84z"/></svg>
          <span class="cms-toolbar-badge-text">Editor</span>
        </div>
        <div class="cms-toolbar-divider"></div>
        <div class="cms-status-group">
          <span class="cms-status-dot cms-status-idle"></span>
          <span class="cms-status-text">Ready</span>
        </div>
      </div>
      ${navLinksHtml ? `<div class="cms-toolbar-nav">${navLinksHtml}</div>` : ''}
      <div class="cms-toolbar-right">
        <button type="button" class="cms-studio-btn" title="Toggle Content Studio panel">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="9" y1="9" x2="21" y2="9"/></svg>
          Studio
        </button>
        <div class="cms-toolbar-divider"></div>
        <button class="cms-map-btn" type="button" title="Content Map — view all editable bindings">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          Map
        </button>
        <div class="cms-toolbar-divider"></div>
        <button class="cms-highlight-btn" type="button" title="Show all editable regions">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
          Show All
        </button>
        <div class="cms-toolbar-divider"></div>
        <button class="cms-exit-btn" type="button">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          Log Out
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(toolbar);
  return toolbar;
}

export function mountToolbar({ showToast, clearDirty, onLogout }) {
  const navLinks = getToolbarNavLinks(window.location.pathname);
  const toolbar = renderToolbar(navLinks);

  const statusDot = toolbar.querySelector('.cms-status-dot');
  const statusText = toolbar.querySelector('.cms-status-text');

  function setStatus(state, text) {
    if (statusDot) {
      statusDot.className = `cms-status-dot cms-status-${state}`;
    }
    if (statusText && text) {
      statusText.textContent = text;
    }
  }

  let highlightActive = false;
  const highlightBtn = toolbar.querySelector('.cms-highlight-btn');

  highlightBtn?.addEventListener('click', () => {
    highlightActive = !highlightActive;
    document.body.classList.toggle('cms-highlight-all', highlightActive);
    highlightBtn.classList.toggle('cms-highlight-btn-active', highlightActive);

    const textNode = Array.from(highlightBtn.childNodes).find(
      (n) => n.nodeType === 3 && n.textContent?.trim(),
    );

    if (highlightActive) {
      if (textNode) textNode.textContent = ' Hide All';
      showToast('Showing all editable regions', 'success');
    } else {
      if (textNode) textNode.textContent = ' Show All';
    }
  });

  toolbar.querySelector('.cms-exit-btn')?.addEventListener('click', async () => {
    clearDirty();
    await onLogout();
  });

  const studioButton = toolbar.querySelector('.cms-studio-btn');
  const mapButton = toolbar.querySelector('.cms-map-btn');
  return {
    toolbar,
    studioButton,
    mapButton,
    setStatus,
  };
}
