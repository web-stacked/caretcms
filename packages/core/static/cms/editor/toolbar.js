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

/** @typedef {'saving' | 'idle' | 'error'} ToolbarStatusState */

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
        </span>`;
}

/** @param {boolean} staticDelivery */
function renderToolbar(staticDelivery) {
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
        <div class="cms-status-group" role="status" aria-live="polite">
          <span class="cms-status-dot cms-status-idle" aria-hidden="true"></span>
          <span class="cms-status-text">Ready</span>
        </div>
      </div>
      <div class="cms-toolbar-right">
        ${renderDraftControls(staticDelivery)}
        <button type="button" class="cms-retry-rebuild-btn" hidden>Retry deploy</button>
        <div class="cms-mode-switch" role="group" aria-label="Page mode">
          <button type="button" class="cms-mode-edit" aria-pressed="true">Edit</button>
          <button type="button" class="cms-mode-preview" aria-pressed="false">Preview</button>
        </div>
        <button type="button" class="cms-studio-btn" title="Toggle Content Studio panel">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="9" y1="9" x2="21" y2="9"/></svg>
          Studio
        </button>
        <details class="cms-tools-menu">
          <summary class="cms-tools-summary">Tools</summary>
          <div class="cms-tools-popover">
            <button class="cms-highlight-btn" type="button" aria-label="Show editable areas" aria-pressed="false">
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
              <span class="cms-highlight-label">Show editable areas</span>
            </button>
            <button class="cms-map-btn" type="button" aria-label="Content map">
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              Content map
            </button>
          </div>
        </details>
        <button class="cms-exit-btn" type="button" title="Sign out">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          Sign out
        </button>
      </div>
    </div>
    <div class="cms-signout-backdrop" hidden>
      <div class="cms-signout-dialog" role="dialog" aria-modal="true" aria-labelledby="cms-signout-title" aria-describedby="cms-signout-copy">
        <h2 id="cms-signout-title">Unpublished changes</h2>
        <p id="cms-signout-copy"></p>
        <div class="cms-signout-actions">
          <button class="cms-signout-cancel" type="button">Cancel</button>
          <button class="cms-signout-discard" type="button">Discard and sign out</button>
          <button class="cms-signout-keep" type="button">Keep drafts and sign out</button>
          <button class="cms-signout-publish" type="button">Publish and sign out</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(toolbar);
  const signoutBackdrop = toolbar.querySelector('.cms-signout-backdrop');
  if (signoutBackdrop) document.body.appendChild(signoutBackdrop);
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
  const toolbar = renderToolbar(staticDelivery);

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

  async function draftsSurviveSignOut() {
    try {
      const response = await fetch(buildCmsUrl('/auth/session'), { credentials: 'same-origin' });
      const body = response.ok ? await response.json() : null;
      return body?.draftsSurviveSignOut === true;
    } catch {
      return false;
    }
  }

  /** @param {number} count @param {boolean} canKeep @returns {Promise<'publish' | 'keep' | 'discard' | 'cancel'>} */
  function chooseSignoutAction(count, canKeep) {
    const backdrop = /** @type {HTMLElement} */ (document.querySelector('.cms-signout-backdrop'));
    const dialog = /** @type {HTMLElement} */ (backdrop.querySelector('.cms-signout-dialog'));
    const copy = /** @type {HTMLElement} */ (backdrop.querySelector('#cms-signout-copy'));
    const publish = /** @type {HTMLButtonElement} */ (backdrop.querySelector('.cms-signout-publish'));
    const keep = /** @type {HTMLButtonElement} */ (backdrop.querySelector('.cms-signout-keep'));
    const discard = /** @type {HTMLButtonElement} */ (backdrop.querySelector('.cms-signout-discard'));
    const cancel = /** @type {HTMLButtonElement} */ (backdrop.querySelector('.cms-signout-cancel'));
    const title = /** @type {HTMLElement} */ (backdrop.querySelector('#cms-signout-title'));
    title.textContent = 'Unpublished changes';
    publish.textContent = 'Publish and sign out';
    publish.classList.remove('is-danger');
    keep.textContent = 'Keep drafts and sign out';
    discard.textContent = 'Discard and sign out';
    copy.textContent = canKeep
      ? `You have ${count} unpublished change${count === 1 ? '' : 's'}. Publish now, keep the drafts for your next sign-in, or discard them.`
      : `You have ${count} unpublished change${count === 1 ? '' : 's'}. Drafts from this password session cannot be reopened after signing out, so publish, discard, or cancel.`;
    publish.hidden = !canPublishDrafts;
    keep.hidden = !canKeep;
    discard.hidden = false;
    backdrop.hidden = false;
    cancel.focus();

    return new Promise((resolve) => {
      /** @param {'publish' | 'keep' | 'discard' | 'cancel'} action */
      function finish(action) {
        backdrop.hidden = true;
        document.removeEventListener('keydown', onKeydown, true);
        cancel.removeEventListener('click', cancelAction);
        discard.removeEventListener('click', discardAction);
        keep.removeEventListener('click', keepAction);
        publish.removeEventListener('click', publishAction);
        backdrop.removeEventListener('click', backdropAction);
        resolve(action);
      }
      function cancelAction() { finish('cancel'); }
      function discardAction() { finish('discard'); }
      function keepAction() { finish('keep'); }
      function publishAction() { finish('publish'); }
      /** @param {MouseEvent} event */
      function backdropAction(event) { if (event.target === backdrop) finish('cancel'); }
      /** @param {KeyboardEvent} event */
      function onKeydown(event) {
        if (event.key === 'Escape') { event.preventDefault(); finish('cancel'); }
        if (event.key !== 'Tab') return;
        const controls = [cancel, discard, keep, publish].filter(button => !button.hidden);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
      cancel.addEventListener('click', cancelAction);
      discard.addEventListener('click', discardAction);
      keep.addEventListener('click', keepAction);
      publish.addEventListener('click', publishAction);
      backdrop.addEventListener('click', backdropAction);
      document.addEventListener('keydown', onKeydown, true);
    });
  }

  /**
   * @param {{ title: string, copy: string, confirmLabel: string, danger?: boolean, restoreFocus?: HTMLElement | null }} options
   * @returns {Promise<boolean>}
   */
  function confirmToolbarAction({ title, copy, confirmLabel, danger = false, restoreFocus = null }) {
    const backdrop = /** @type {HTMLElement} */ (document.querySelector('.cms-signout-backdrop'));
    const titleEl = /** @type {HTMLElement} */ (backdrop.querySelector('#cms-signout-title'));
    const copyEl = /** @type {HTMLElement} */ (backdrop.querySelector('#cms-signout-copy'));
    const confirm = /** @type {HTMLButtonElement} */ (backdrop.querySelector('.cms-signout-publish'));
    const keep = /** @type {HTMLButtonElement} */ (backdrop.querySelector('.cms-signout-keep'));
    const discard = /** @type {HTMLButtonElement} */ (backdrop.querySelector('.cms-signout-discard'));
    const cancel = /** @type {HTMLButtonElement} */ (backdrop.querySelector('.cms-signout-cancel'));
    titleEl.textContent = title;
    copyEl.textContent = copy;
    confirm.textContent = confirmLabel;
    confirm.classList.toggle('is-danger', danger);
    confirm.hidden = false;
    keep.hidden = true;
    discard.hidden = true;
    backdrop.hidden = false;
    cancel.focus();

    return new Promise((resolve) => {
      /** @param {boolean} accepted */
      function finish(accepted) {
        backdrop.hidden = true;
        document.removeEventListener('keydown', onKeydown, true);
        cancel.removeEventListener('click', cancelAction);
        confirm.removeEventListener('click', confirmAction);
        backdrop.removeEventListener('click', backdropAction);
        if (restoreFocus?.isConnected) restoreFocus.focus();
        resolve(accepted);
      }
      function cancelAction() { finish(false); }
      function confirmAction() { finish(true); }
      /** @param {MouseEvent} event */
      function backdropAction(event) { if (event.target === backdrop) finish(false); }
      /** @param {KeyboardEvent} event */
      function onKeydown(event) {
        if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        if (event.key !== 'Tab') return;
        if (event.shiftKey && document.activeElement === cancel) { event.preventDefault(); confirm.focus(); }
        else if (!event.shiftKey && document.activeElement === confirm) { event.preventDefault(); cancel.focus(); }
      }
      cancel.addEventListener('click', cancelAction);
      confirm.addEventListener('click', confirmAction);
      backdrop.addEventListener('click', backdropAction);
      document.addEventListener('keydown', onKeydown, true);
    });
  }

  const highlightBtn = /** @type {HTMLButtonElement | null} */ (toolbar.querySelector('.cms-highlight-btn'));
  highlightBtn?.addEventListener('click', () => toggleHighlight(highlightBtn, showToast));
  const toolsMenu = /** @type {HTMLDetailsElement | null} */ (toolbar.querySelector('.cms-tools-menu'));
  toolbar.querySelector('.cms-map-btn')?.addEventListener('click', () => toolsMenu?.removeAttribute('open'));
  document.addEventListener('pointerdown', (event) => {
    if (toolsMenu?.open && event.target instanceof Node && !toolsMenu.contains(event.target)) {
      toolsMenu.removeAttribute('open');
    }
  });

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

  /** @param {{ reload?: boolean }} [options] */
  async function publishDrafts({ reload = true } = {}) {
    setStatus('saving', 'Publishing…');
    try {
      const presentation = presentPublishResult(await draftClient.publish());
      if (retryRebuildButton) retryRebuildButton.hidden = !presentation.retryAvailable;
      if (presentation.status) {
        setStatus(presentation.status.state, presentation.status.text);
      }
      showToast(presentation.toast.message, presentation.toast.kind);
      if (presentation.reload && reload) window.location.reload();
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
      if (count > 0) {
        const action = await chooseSignoutAction(count, await draftsSurviveSignOut());
        if (action === 'cancel') return;
        if (action === 'publish') {
          if (!(await publishDrafts({ reload: false }))) return;
        } else if (action === 'discard') {
          try {
            await draftClient.discard();
          } catch {
            showToast('Some drafts need publish recovery. Retry Publish before discarding.', 'error');
            return;
          }
        } else if (action !== 'keep') {
          return;
        }
      }
    }

    clearDirty();
    await onLogout();
  });

  const publishBtn = /** @type {HTMLButtonElement | null} */ (toolbar.querySelector('.cms-publish-btn'));
  publishBtn?.addEventListener('click', async () => {
    if (!(await confirmToolbarAction({
      title: 'Publish drafts?',
      copy: staticDelivery
        ? 'This publishes all draft changes. Static visitors update after rebuild and deploy.'
        : 'This publishes all your draft changes to the live site.',
      confirmLabel: 'Publish',
      restoreFocus: publishBtn,
    }))) return;
    await publishDrafts();
  });

  const discardBtn = /** @type {HTMLButtonElement | null} */ (toolbar.querySelector('.cms-discard-btn'));
  discardBtn?.addEventListener('click', async () => {
    if (!(await confirmToolbarAction({
      title: 'Discard drafts?',
      copy: 'This permanently removes all your draft changes.',
      confirmLabel: 'Discard drafts',
      danger: true,
      restoreFocus: discardBtn,
    }))) return;
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
  const editModeButton = toolbar.querySelector('.cms-mode-edit');
  const previewModeButton = toolbar.querySelector('.cms-mode-preview');
  return {
    toolbar,
    studioButton,
    mapButton,
    editModeButton,
    previewModeButton,
    setStatus,
  };
}
