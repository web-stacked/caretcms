import { isPolicyDraftMode } from './config.js';
import { toggleHighlight } from './highlight.js';
import { buildCmsUrl, isStaticDelivery } from './config.js';
import { createDeploymentStatusPoller } from './deployment-status.js';
import { presentPublishResult } from './publish-result.js';
import { createDraftClient } from './draft-client.js';
import { createPreviewModeController } from './preview-mode.js';

const previewMode = createPreviewModeController({
  isStaticDelivery,
  isPolicyDraftMode,
  documentRef: document,
  reload: () => window.location.reload(),
});

/** Static delivery always drafts — turn preview on once so saves stay unpublished. */
export function ensureStaticPreviewMode() {
  return previewMode.ensureStaticPreviewMode();
}

/** Align preview cookie with delivery mode (static on, server off). */
export function normalizePreviewForDelivery() {
  return previewMode.normalizePreviewForDelivery();
}

/** @typedef {{ href: string, label: string, isActive: boolean }} ToolbarNavLink */
/** @typedef {'saving' | 'idle' | 'error'} ToolbarStatusState */

/** @param {string} pagePath @returns {ToolbarNavLink[]} */
function getToolbarNavLinks(pagePath) {
  /** @type {ToolbarNavLink[]} */
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

/** @param {boolean} staticDelivery */
function renderDraftControls(staticDelivery) {
  // Static delivery is always drafting, so the controls stay visible. Server
  // delivery saves field edits straight to the site, but inline body-block
  // edits are ALWAYS drafts (they splice into source files only at publish), so
  // the controls render here too — hidden until at least one draft is pending
  // (toggled by refreshDraftControls) so the toolbar stays quiet otherwise.
  const publishTitle = isPolicyDraftMode() ? 'Publish private drafts to shared content' : staticDelivery
    ? 'Publish drafts; static visitors update after rebuild and deploy'
    : 'Publish your body-block drafts into the source files';
  return `
        <span class="cms-draft-controls"${staticDelivery ? '' : ' hidden'}>
          <button class="cms-publish-btn cms-go-live-btn" type="button" title="${publishTitle}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg>
            <span class="cms-go-live-label">Publish</span>
          </button>
          <button class="cms-discard-btn" type="button" title="Discard your draft changes">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            Discard
          </button>
          <div class="cms-toolbar-divider"></div>
        </span>`;
}

/** @param {ToolbarNavLink[]} navLinks @param {boolean} staticDelivery */
function renderToolbar(navLinks, staticDelivery) {
  const navLinksHtml = navLinks
    .map(
      ({ href, label, isActive }) =>
        `<a href="${href}" class="cms-nav-link ${isActive ? 'active' : ''}">${label}</a>`,
    )
    .join('');

  const badgeLabel = staticDelivery || isPolicyDraftMode() ? 'Draft' : 'Live';
  const badgeHint = isPolicyDraftMode() ? 'Changes save to your private draft; publishing requires permission' : staticDelivery
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
        <button type="button" class="cms-retry-rebuild-btn" hidden>Retry deploy</button>
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

/**
 * @param {{
 *   showToast: (message: string, type: 'success' | 'error') => void,
 *   clearDirty: () => void,
 *   onLogout: () => void | Promise<void>,
 * }} options
 */
export function mountToolbar({ showToast, clearDirty, onLogout }) {
  const staticDelivery = isStaticDelivery();
  const navLinks = getToolbarNavLinks(window.location.pathname);
  const toolbar = renderToolbar(navLinks, staticDelivery);

  const statusDot = toolbar.querySelector('.cms-status-dot');
  const statusText = toolbar.querySelector('.cms-status-text');

  /** @param {ToolbarStatusState} state @param {string} text */
  function setStatus(state, text) {
    if (statusDot) {
      statusDot.className = `cms-status-dot cms-status-${state}`;
    }
    if (statusText && text) {
      statusText.textContent = text;
    }
  }

  const deploymentStatus = createDeploymentStatusPoller({
    fetchStatus: () => fetch(buildCmsUrl('/deployment'), {
        credentials: 'same-origin',
        headers: { 'x-caret-request': '1' },
      }),
    setStatus,
    setBuildId(buildId) {
      const statusGroup = /** @type {HTMLElement | null} */ (toolbar.querySelector('.cms-status-group'));
      if (statusGroup) {
        statusGroup.title = buildId ? `Build ${buildId}` : '';
      }
    },
  });
  const draftClient = createDraftClient({ buildUrl: path => buildCmsUrl(path) });

  const highlightBtn = /** @type {HTMLButtonElement | null} */ (toolbar.querySelector('.cms-highlight-btn'));
  highlightBtn?.addEventListener('click', () =>
    toggleHighlight(highlightBtn, showToast),
  );

  let canPublishDrafts = true;
  const retryRebuildButton = /** @type {HTMLButtonElement | null} */ (toolbar.querySelector('.cms-retry-rebuild-btn'));
  async function fetchDraftCount() {
    try {
      const data = await draftClient.getState();
      canPublishDrafts = data.canPublish;
      const publishButton = /** @type {HTMLButtonElement | null} */ (toolbar.querySelector('.cms-publish-btn'));
      if (publishButton) publishButton.hidden = !data.canPublish;
      if (retryRebuildButton) retryRebuildButton.hidden = !data.retryRebuild || !data.canPublish;
      return data.count;
    } catch {
      return 0;
    }
  }

  async function publishDrafts() {
    setStatus('saving', 'Publishing…');
    try {
      const presentation = presentPublishResult(await draftClient.publish());
      if (retryRebuildButton) retryRebuildButton.hidden = !presentation.retryAvailable;
      if (presentation.status) {
        setStatus(presentation.status.state, presentation.status.text);
      }
      showToast(presentation.toast.message, presentation.toast.kind);
      if (presentation.reload) window.location.reload();
      return presentation.completed;
    } catch {
      setStatus('error', 'Publish failed');
      showToast('Publication could not finish. Some content may already be published. Retry Publish to recover.', 'error');
      return false;
    }
  }

  toolbar.querySelector('.cms-exit-btn')?.addEventListener('click', async () => {
    if (staticDelivery || isPolicyDraftMode()) {
      const count = await fetchDraftCount();
      if (count > 0 && canPublishDrafts) {
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
          await draftClient.discard();
        } catch {
          showToast('Some drafts need publish recovery. Retry Publish before discarding.', 'error');
          return;
        }
      }
    }

    clearDirty();
    await onLogout();
  });

  const publishBtn = /** @type {HTMLButtonElement | null} */ (toolbar.querySelector('.cms-publish-btn'));
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
      await draftClient.discard();
      showToast('Draft discarded', 'success');
      window.location.reload();
    } catch {
      showToast('Discard failed', 'error');
    }
  });

  // Server delivery hides the draft controls until a body draft exists. Field
  // edits save directly (no draft), so the count reflects pending body blocks.
  // Refresh on mount and whenever a body block is drafted; publish/discard
  // reload the page, so mount re-evaluates from scratch.
  const draftControls = /** @type {HTMLElement | null} */ (toolbar.querySelector('.cms-draft-controls'));
  async function refreshDraftControls() {
    const count = await fetchDraftCount();
    if (draftControls) draftControls.hidden = !staticDelivery && !isPolicyDraftMode() && count === 0;
  }
  refreshDraftControls();
  window.addEventListener('cms:draftSaved', refreshDraftControls);
  retryRebuildButton?.addEventListener('click', async () => {
    retryRebuildButton.disabled = true;
    setStatus('saving', 'Retrying deploy…');
    try {
      const data = await draftClient.retryDeployment();
      retryRebuildButton.hidden = true;
      setStatus(data.deploymentTracked ? 'saving' : 'idle', data.deploymentTracked ? 'Deploying…' : 'Deploy requested');
      showToast('Deploy requested. Your published content is unchanged.', 'success');
      if (data.deploymentTracked) deploymentStatus.schedule();
    } catch {
      setStatus('error', 'Published, deploy failed');
      showToast('The deploy hook failed. Check its configuration and retry.', 'error');
    } finally { retryRebuildButton.disabled = false; }
  });

  void deploymentStatus.refresh();

  const studioButton = toolbar.querySelector('.cms-studio-btn');
  const mapButton = toolbar.querySelector('.cms-map-btn');
  return {
    toolbar,
    studioButton,
    mapButton,
    setStatus,
  };
}
