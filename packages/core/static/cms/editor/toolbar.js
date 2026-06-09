import { buildCmsUrl } from './config.js';

const PREVIEW_COOKIE = 'caret_preview';

function previewActive() {
  return document.cookie.split('; ').some((c) => c === `${PREVIEW_COOKIE}=1`);
}

function setPreviewCookie(on) {
  document.cookie = on
    ? `${PREVIEW_COOKIE}=1; path=/; SameSite=Lax`
    : `${PREVIEW_COOKIE}=; path=/; Max-Age=0; SameSite=Lax`;
}

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
        <button class="cms-preview-btn" type="button" title="Toggle draft preview — edit without publishing to the live site">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          Preview
        </button>
        <button class="cms-publish-btn" type="button" title="Publish your draft changes to the live site" hidden>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg>
          Publish
        </button>
        <button class="cms-discard-btn" type="button" title="Discard your draft changes" hidden>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          Discard
        </button>
        <div class="cms-toolbar-divider"></div>
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

  // --- Draft preview + publish/discard ---
  const previewBtn = toolbar.querySelector('.cms-preview-btn');
  const publishBtn = toolbar.querySelector('.cms-publish-btn');
  const discardBtn = toolbar.querySelector('.cms-discard-btn');
  const badgeText = toolbar.querySelector('.cms-toolbar-badge-text');

  function reflectPreview() {
    const on = previewActive();
    previewBtn?.classList.toggle('cms-preview-btn-active', on);
    if (publishBtn) publishBtn.hidden = !on;
    if (discardBtn) discardBtn.hidden = !on;
    if (badgeText) badgeText.textContent = on ? 'Draft' : 'Editor';
    const label = previewBtn
      && Array.from(previewBtn.childNodes).find((n) => n.nodeType === 3 && n.textContent?.trim());
    if (label) label.textContent = on ? ' Previewing' : ' Preview';
  }
  reflectPreview();

  previewBtn?.addEventListener('click', () => {
    const turningOn = !previewActive();
    setPreviewCookie(turningOn);
    showToast(
      turningOn ? 'Draft preview on — your edits stay unpublished' : 'Draft preview off',
      'success',
    );
    // Reload so the server installs (or drops) the per-editor draft overlay.
    window.location.reload();
  });

  async function draftRequest(method, path) {
    return fetch(buildCmsUrl(path), {
      method,
      headers: { 'Content-Type': 'application/json', 'x-caret-request': '1' },
      credentials: 'same-origin',
      body: method === 'POST' ? '{}' : undefined,
    });
  }

  publishBtn?.addEventListener('click', async () => {
    if (!window.confirm('Publish all your draft changes to the live site?')) return;
    setStatus('saving', 'Publishing…');
    try {
      const res = await draftRequest('POST', '/publish');
      if (!res.ok) throw new Error('publish failed');
      const data = await res.json();
      const n = Array.isArray(data.published) ? data.published.length : 0;
      // Drafts are flushed; leave preview so the editor sees the published site.
      setPreviewCookie(false);
      showToast(`Published ${n} change(s)`, 'success');
      window.location.reload();
    } catch {
      setStatus('error', 'Publish failed');
      showToast('Publish failed', 'error');
    }
  });

  discardBtn?.addEventListener('click', async () => {
    if (!window.confirm('Discard all your draft changes? This cannot be undone.')) return;
    try {
      const res = await draftRequest('DELETE', '/draft');
      if (!res.ok) throw new Error('discard failed');
      setPreviewCookie(false);
      showToast('Draft discarded', 'success');
      window.location.reload();
    } catch {
      showToast('Discard failed', 'error');
    }
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
