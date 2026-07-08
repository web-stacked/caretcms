import { toggleHighlight } from './highlight.js';
import { buildCmsUrl, isStaticDelivery } from './config.js';

const PREVIEW_COOKIE = 'caret_preview';

function previewActive() {
  return document.cookie.split('; ').some((c) => c === `${PREVIEW_COOKIE}=1`);
}

function setPreviewCookie(on) {
  document.cookie = on
    ? `${PREVIEW_COOKIE}=1; path=/; SameSite=Lax`
    : `${PREVIEW_COOKIE}=; path=/; Max-Age=0; SameSite=Lax`;
}

/** Static delivery always drafts — turn preview on once so saves stay unpublished. */
export function ensureStaticPreviewMode() {
  if (!isStaticDelivery()) return false;
  if (previewActive()) return false;
  setPreviewCookie(true);
  window.location.reload();
  return true;
}

/** Align preview cookie with delivery mode (static on, server off). */
export function normalizePreviewForDelivery() {
  if (isStaticDelivery()) return ensureStaticPreviewMode();
  if (previewActive()) {
    setPreviewCookie(false);
    window.location.reload();
    return true;
  }
  return false;
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

function renderDraftControls(staticDelivery) {
  if (!staticDelivery) return '';

  return `
        <button class="cms-publish-btn cms-go-live-btn" type="button" title="Publish drafts; static visitors update after rebuild and deploy">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg>
          <span class="cms-go-live-label">Publish</span>
        </button>
        <button class="cms-discard-btn" type="button" title="Discard your draft changes">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          Discard
        </button>
        <div class="cms-toolbar-divider"></div>`;
}

function renderToolbar(navLinks, staticDelivery) {
  const navLinksHtml = navLinks
    .map(
      ({ href, label, isActive }) =>
        `<a href="${href}" class="cms-nav-link ${isActive ? 'active' : ''}">${label}</a>`,
    )
    .join('');

  const badgeLabel = staticDelivery ? 'Draft' : 'Live';
  const badgeHint = staticDelivery
    ? 'Draft preview; visitors update after publish, rebuild, and deploy'
    : 'Changes save directly to your site';

  const toolbar = document.createElement('div');
  toolbar.className = 'cms-toolbar';
  toolbar.dataset.delivery = staticDelivery ? 'static' : 'server';
  toolbar.innerHTML = `
    <div class="cms-toolbar-inner">
      <div class="cms-toolbar-left">
        <div class="cms-toolbar-badge" title="${badgeHint}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 9l10 13 10-13L12 2zm0 3.84L18.26 9 12 17.65 5.74 9 12 5.84z"/></svg>
          <span class="cms-toolbar-badge-text">${badgeLabel}</span>
        </div>
        <div class="cms-toolbar-divider"></div>
        <div class="cms-status-group" role="status" aria-live="polite">
          <span class="cms-status-dot cms-status-idle" aria-hidden="true"></span>
          <span class="cms-status-text">Ready</span>
        </div>
      </div>
      ${navLinksHtml ? `<div class="cms-toolbar-nav">${navLinksHtml}</div>` : ''}
      <div class="cms-toolbar-right">
        ${renderDraftControls(staticDelivery)}
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
          <span class="cms-highlight-label">Show all</span>
        </button>
        <div class="cms-toolbar-divider"></div>
        <button class="cms-exit-btn" type="button" title="Sign out">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          Sign out
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(toolbar);
  return toolbar;
}

export function mountToolbar({ showToast, clearDirty, onLogout }) {
  const staticDelivery = isStaticDelivery();
  const navLinks = getToolbarNavLinks(window.location.pathname);
  const toolbar = renderToolbar(navLinks, staticDelivery);

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

  const highlightBtn = toolbar.querySelector('.cms-highlight-btn');
  highlightBtn?.addEventListener('click', () =>
    toggleHighlight(highlightBtn, showToast),
  );

  async function draftRequest(method, path) {
    return fetch(buildCmsUrl(path), {
      method,
      headers: { 'Content-Type': 'application/json', 'x-caret-request': '1' },
      credentials: 'same-origin',
      body: method === 'POST' ? '{}' : undefined,
    });
  }

  async function fetchDraftCount() {
    try {
      const res = await fetch(buildCmsUrl('/draft'), {
        credentials: 'same-origin',
        headers: { 'x-caret-request': '1' },
      });
      if (!res.ok) return 0;
      const data = await res.json();
      return typeof data.count === 'number' ? data.count : 0;
    } catch {
      return 0;
    }
  }

  async function publishDrafts() {
    setStatus('saving', 'Publishing…');
    try {
      const res = await draftRequest('POST', '/publish');
      if (!res.ok) throw new Error('publish failed');
      const data = await res.json();
      const n = Array.isArray(data.published) ? data.published.length : 0;
      if (data.rebuild?.triggered && data.rebuild.ok === false) {
        setStatus('error', 'Published, deploy failed');
        showToast(
          'Changes are published, but the deploy webhook failed. Check your CI settings.',
          'error',
        );
        return false;
      }
      if (data.rebuild?.triggered) {
        showToast(
          n > 0
            ? `Published ${n} change(s) — rebuild started`
            : 'Your site is rebuilding',
          'success',
        );
      } else {
        showToast(
          n > 0
            ? `Published ${n} change(s) — rebuild and deploy to update visitors`
            : 'Already up to date',
          'success',
        );
      }
      window.location.reload();
      return true;
    } catch {
      setStatus('error', 'Publish failed');
      showToast('Publish failed', 'error');
      return false;
    }
  }

  toolbar.querySelector('.cms-exit-btn')?.addEventListener('click', async () => {
    if (staticDelivery) {
      const count = await fetchDraftCount();
      if (count > 0) {
        const goLive = window.confirm(
          `You have ${count} unpublished change${count === 1 ? '' : 's'}. Publish before signing out?`,
        );
        if (goLive) {
          await publishDrafts();
          return;
        }
        const discard = window.confirm(
          'Discard unpublished changes and sign out?',
        );
        if (!discard) return;
        try {
          const res = await draftRequest('DELETE', '/draft');
          if (!res.ok) throw new Error('discard failed');
        } catch {
          showToast('Could not discard drafts', 'error');
          return;
        }
      }
    }

    clearDirty();
    await onLogout();
  });

  const publishBtn = toolbar.querySelector('.cms-publish-btn');
  publishBtn?.addEventListener('click', async () => {
    if (
      !window.confirm(
        staticDelivery
          ? 'Publish all draft changes? Static visitors update after rebuild and deploy.'
          : 'Publish all your draft changes to the live site?',
      )
    ) {
      return;
    }
    await publishDrafts();
  });

  toolbar.querySelector('.cms-discard-btn')?.addEventListener('click', async () => {
    if (!window.confirm('Discard all your draft changes? This cannot be undone.')) return;
    try {
      const res = await draftRequest('DELETE', '/draft');
      if (!res.ok) throw new Error('discard failed');
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
