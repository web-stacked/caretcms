import { isPolicyDraftMode } from './config.js';
import { toggleHighlight } from './highlight.js';
import { buildCmsUrl, isStaticDelivery } from './config.js';
import { createDeploymentStatusPoller } from './deployment-status.js';
import { presentPublishResult } from './publish-result.js';
import { createDraftClient } from './draft-client.js';
import { mountToolbarKeys } from './toolbar-keys.js';
import { t, tHtml } from './i18n.js';
/** @typedef {'saving' | 'idle' | 'error'} ToolbarStatusState */

// A Publish in progress, carried across a reload the dev server starts.
const PUBLISHING_KEY = 'caret:publishing';

/** @param {number} count */
function changeCount(count) {
  return count === 1 ? t('editor.toolbar.changesOne') : t('editor.toolbar.changesOther', { count });
}

/** @param {boolean} staticDelivery */
function renderDraftControls(staticDelivery) {
  // Shown only while drafts are pending, in every mode (toggled by
  // refreshDraftControls): static delivery and policies always draft, and
  // server delivery drafts inline body-block edits until they're published.
  const publishTitle = staticDelivery
    ? tHtml('editor.toolbar.publishTitleStatic')
    : tHtml('editor.toolbar.publishTitle');
  return `
        <span class="cms-draft-controls" hidden>
          <button class="cms-publish-btn cms-go-live-btn" type="button" title="${publishTitle}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg>
            <span class="cms-go-live-label">${tHtml('editor.toolbar.publish')}</span>
          </button>
          <button class="cms-discard-btn" type="button" title="${tHtml('editor.toolbar.discardTitle')}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            ${tHtml('editor.toolbar.discard')}
          </button>
        </span>`;
}

/** @param {boolean} staticDelivery */
function renderToolbar(staticDelivery) {
  const mode = staticDelivery || isPolicyDraftMode() ? 'draft' : 'live';
  const badgeLabel = tHtml(mode === 'draft' ? 'editor.toolbar.draft' : 'editor.toolbar.live');
  const badgeHint = staticDelivery
    ? tHtml('editor.toolbar.hintStatic')
    : isPolicyDraftMode()
      ? tHtml('editor.toolbar.hintPolicy')
      : tHtml('editor.toolbar.hintLive');

  const toolbar = document.createElement('div');
  toolbar.className = 'cms-toolbar';
  toolbar.dataset.delivery = staticDelivery ? 'static' : 'server';
  toolbar.innerHTML = `
    <div class="cms-toolbar-inner" role="toolbar" aria-label="${tHtml('editor.toolbar.label')}">
      <div class="cms-toolbar-left">
        <button type="button" class="cms-status-pill" data-mode="${mode}" aria-haspopup="dialog" aria-expanded="false" aria-controls="cms-status-panel">
          <span class="cms-status-dot cms-status-idle" aria-hidden="true"></span>
          <span class="cms-status-text">${badgeLabel}</span>
        </button>
        <span class="cms-status-live" role="status" aria-live="polite"></span>
      </div>
      <div class="cms-toolbar-right">
        ${renderDraftControls(staticDelivery)}
        <button type="button" class="cms-retry-rebuild-btn" hidden>${tHtml('editor.toolbar.retryUpdate')}</button>
        <div class="cms-mode-switch" role="group" aria-label="${tHtml('editor.toolbar.pageMode')}">
          <button type="button" class="cms-mode-edit" aria-pressed="true" title="${tHtml('editor.toolbar.editTitle')}">${tHtml('editor.toolbar.edit')}</button>
          <button type="button" class="cms-mode-preview" aria-pressed="false" title="${tHtml('editor.toolbar.previewTitle')}">${tHtml('editor.toolbar.preview')}</button>
        </div>
        <button type="button" class="cms-studio-btn" title="${tHtml('editor.toolbar.studioTitle')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="9" y1="9" x2="21" y2="9"/></svg>
          ${tHtml('editor.toolbar.studio')}
        </button>
        <details class="cms-tools-menu">
          <summary class="cms-tools-summary">${tHtml('editor.toolbar.tools')}</summary>
          <div class="cms-tools-popover">
            <button class="cms-highlight-btn" type="button" aria-label="${tHtml('editor.highlight.show')}" aria-pressed="false">
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
              <span class="cms-highlight-label">${tHtml('editor.highlight.show')}</span>
            </button>
            <button class="cms-map-btn" type="button" aria-label="${tHtml('editor.map.title')}">
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              ${tHtml('editor.map.title')}
            </button>
          </div>
        </details>
        <button class="cms-exit-btn" type="button" title="${tHtml('editor.toolbar.signOut')}" aria-label="${tHtml('editor.toolbar.signOut')}">
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          <span class="cms-btn-label">${tHtml('editor.toolbar.signOut')}</span>
        </button>
      </div>
    </div>
    <div id="cms-status-panel" class="cms-status-panel" role="dialog" aria-label="${tHtml('editor.toolbar.statusPanel')}" hidden>
      <p class="cms-status-panel-mode"><strong>${badgeLabel}</strong></p>
      <p class="cms-status-panel-hint">${badgeHint}</p>
      <p class="cms-status-panel-line" data-line="status" hidden></p>
      <p class="cms-status-panel-line cms-status-panel-problem" data-line="problem" hidden></p>
      <p class="cms-status-panel-line" data-line="saved" hidden></p>
      <p class="cms-status-panel-line" data-line="drafts" hidden></p>
      <p class="cms-status-panel-line" data-line="build" hidden></p>
      <div class="cms-status-panel-actions">
        <button type="button" data-action="undo" hidden>${tHtml('editor.toolbar.undoLast')}</button>
        <button type="button" data-action="history">${tHtml('editor.toolbar.history')}</button>
      </div>
    </div>
    <div class="cms-dialog-backdrop" hidden>
      <div class="cms-dialog" role="dialog" aria-modal="true" aria-labelledby="cms-signout-title" aria-describedby="cms-signout-copy">
        <h2 id="cms-signout-title">${tHtml('editor.toolbar.unpublishedTitle')}</h2>
        <p id="cms-signout-copy"></p>
        <div class="cms-dialog-actions">
          <button class="cms-signout-cancel" type="button">${tHtml('editor.toolbar.cancel')}</button>
          <button class="cms-signout-discard" type="button">${tHtml('editor.toolbar.discardAndSignOut')}</button>
          <button class="cms-signout-keep" type="button">${tHtml('editor.toolbar.keepAndSignOut')}</button>
          <button class="cms-signout-publish" type="button">${tHtml('editor.toolbar.publishAndSignOut')}</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(toolbar);
  const signoutBackdrop = toolbar.querySelector('.cms-dialog-backdrop');
  if (signoutBackdrop) document.body.appendChild(signoutBackdrop);
  const statusPanel = toolbar.querySelector('.cms-status-panel');
  if (statusPanel) document.body.appendChild(statusPanel);
  return toolbar;
}

/**
 * @param {{
 *   showToast: import('./toast.js').ToastController,
 *   clearDirty: () => void,
 *   hasUnsavedEdits: () => boolean,
 *   undo: { available: () => boolean, run: () => void | Promise<void> },
 *   onOpenHistory: () => void,
 *   onLogout: () => void | Promise<void>,
 * }} options
 */
export function mountToolbar({ showToast, clearDirty, hasUnsavedEdits, undo, onOpenHistory, onLogout }) {
  const staticDelivery = isStaticDelivery();
  const toolbar = renderToolbar(staticDelivery);
  const modeLabel = staticDelivery || isPolicyDraftMode() ? t('editor.toolbar.draft') : t('editor.toolbar.live');

  const statusDot = toolbar.querySelector('.cms-status-dot');
  const statusText = toolbar.querySelector('.cms-status-text');
  const statusLive = toolbar.querySelector('.cms-status-live');
  const pill = /** @type {HTMLButtonElement} */ (toolbar.querySelector('.cms-status-pill'));
  const panel = /** @type {HTMLElement} */ (document.getElementById('cms-status-panel'));

  // The status pill: one dot and one word. The word says what's happening
  // (saving, unsaved, a failure) and returns to the mode ("Live" or "Draft")
  // a few seconds after a success. The panel holds the details.
  /** @type {{ state: ToolbarStatusState | 'dirty', text: string }} */
  let current = { state: 'idle', text: modeLabel };
  /** @type {number | null} */
  let lastSavedAt = null;
  let buildLabel = '';
  /** @type {{ message: string, at: number } | null} */
  let lastProblem = null;

  /** Keep the latest error in the panel after its toast closes. @param {string} message */
  function reportProblem(message) {
    lastProblem = { message, at: Date.now() };
    if (!panel.hidden) renderPanel();
  }
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let restModeTimer;

  /** @param {ToolbarStatusState | 'dirty'} state @param {string} text */
  function showStatus(state, text) {
    clearTimeout(restModeTimer);
    current = { state, text };
    if (statusDot) statusDot.className = `cms-status-dot cms-status-${state}`;
    if (statusText && text) statusText.textContent = text;
    if (statusLive && text) statusLive.textContent = text;
    if (state === 'idle') {
      if (text !== modeLabel) lastSavedAt = Date.now();
      restModeTimer = setTimeout(() => {
        if (current.state === 'idle' && statusText) statusText.textContent = modeLabel;
      }, 3000);
    }
    if (!panel.hidden) renderPanel();
  }

  /** @param {number} at */
  function savedAgo(at) {
    const seconds = Math.round((Date.now() - at) / 1000);
    if (seconds < 45) return t('editor.toolbar.savedJustNow');
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return t('editor.toolbar.savedMinutesAgo', { minutes });
    return t('editor.toolbar.savedAt', { time: new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) });
  }

  /** @param {string} name @param {string} text */
  function setLine(name, text) {
    const line = /** @type {HTMLElement | null} */ (panel.querySelector(`[data-line="${name}"]`));
    if (!line) return;
    line.textContent = text;
    line.hidden = !text;
  }

  function renderPanel() {
    setLine('status', current.state === 'idle' ? '' : current.text);
    const problemRecent = lastProblem && Date.now() - lastProblem.at < 10 * 60 * 1000;
    setLine('problem', problemRecent && lastProblem ? t('editor.toolbar.lastProblem', { message: lastProblem.message }) : '');
    setLine('saved', lastSavedAt ? savedAgo(lastSavedAt) : '');
    setLine('build', buildLabel);
    const undoButton = /** @type {HTMLElement | null} */ (panel.querySelector('[data-action="undo"]'));
    if (undoButton) undoButton.hidden = !undo.available();
  }

  function positionPanel() {
    // Lined up with the bar's left edge, and as far above it as the Tools menu.
    const rect = (pill.closest('.cms-toolbar-inner') ?? pill).getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 14)}px`;
  }

  async function openPanel() {
    panel.hidden = false;
    pill.setAttribute('aria-expanded', 'true');
    renderPanel();
    positionPanel();
    const count = await fetchDraftCount();
    setLine('drafts', count > 0 ? changeCount(count) : '');
    positionPanel();
  }

  /** @param {boolean} [restoreFocus] */
  function closePanel(restoreFocus = true) {
    if (panel.hidden) return;
    panel.hidden = true;
    pill.setAttribute('aria-expanded', 'false');
    if (restoreFocus) pill.focus();
  }

  pill.addEventListener('click', () => {
    if (panel.hidden) void openPanel();
    else closePanel();
  });
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closePanel(); }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!panel.hidden && event.target instanceof Node && !panel.contains(event.target) && !pill.contains(event.target)) {
      closePanel(false);
    }
  });
  panel.querySelector('[data-action="undo"]')?.addEventListener('click', () => {
    closePanel();
    void undo.run();
  });
  // A Publish or Discard ends in a reload; carry its confirmation across it.
  /** @param {string} message @param {'success' | 'error'} kind */
  function reloadWithToast(message, kind) {
    try { sessionStorage.setItem('caret:after-reload-toast', JSON.stringify({ message, kind })); } catch { /* shown nowhere */ }
    window.location.reload();
  }
  try {
    const carried = JSON.parse(sessionStorage.getItem('caret:after-reload-toast') || 'null');
    sessionStorage.removeItem('caret:after-reload-toast');
    const publishing = JSON.parse(sessionStorage.getItem(PUBLISHING_KEY) || 'null');
    sessionStorage.removeItem(PUBLISHING_KEY);
    if (carried && typeof carried.message === 'string') {
      // Shown as the page comes back, so it stays long enough to be read.
      setTimeout(() => (carried.kind === 'error'
        ? showToast(carried.message, 'error')
        : showToast.saved({ message: carried.message })), 0);
    } else if (publishing && typeof publishing.count === 'number' && Date.now() - publishing.at < 120000) {
      // Publishing writes the site's files, and the dev server can reload the
      // page before the answer arrives: say what happened from the drafts left.
      setTimeout(() => void confirmPublishAfterReload(publishing.count), 0);
    }
  } catch { /* nothing carried */ }

  panel.querySelector('[data-action="history"]')?.addEventListener('click', () => {
    closePanel(false);
    onOpenHistory();
  });

  // The status shown before "Unsaved changes", restored if the edit is undone.
  /** @type {{ dot: string, text: string } | null} */
  let beforeUnsaved = null;

  /** @param {ToolbarStatusState} state @param {string} text */
  function setStatus(state, text) {
    beforeUnsaved = null;
    showStatus(state, text);
  }

  /** @param {boolean} unsaved */
  function setUnsaved(unsaved) {
    if (unsaved && !beforeUnsaved) {
      beforeUnsaved = { dot: statusDot?.className ?? '', text: statusText?.textContent ?? '' };
      showStatus('dirty', t('editor.toolbar.unsaved'));
    } else if (!unsaved && beforeUnsaved) {
      if (statusDot) statusDot.className = beforeUnsaved.dot;
      if (statusText) statusText.textContent = beforeUnsaved.text;
      beforeUnsaved = null;
    }
  }

  // A deploy that failed and waits for Retry outranks an older "Live".
  let rebuildPending = false;
  const deploymentStatus = createDeploymentStatusPoller({
    fetchStatus: () => fetch(buildCmsUrl('/deployment'), {
        credentials: 'same-origin',
        headers: { 'x-caret-request': '1' },
      }),
    setStatus: (state, text) => (rebuildPending && state === 'idle'
      ? setStatus('error', t('editor.deploy.failed'))
      : setStatus(state, text)),
    setBuildId(buildId) {
      buildLabel = buildId ? t('editor.toolbar.build', { id: buildId }) : '';
      if (!panel.hidden) renderPanel();
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
    const backdrop = /** @type {HTMLElement} */ (document.querySelector('.cms-dialog-backdrop'));
    const dialog = /** @type {HTMLElement} */ (backdrop.querySelector('.cms-dialog'));
    const copy = /** @type {HTMLElement} */ (backdrop.querySelector('#cms-signout-copy'));
    const publish = /** @type {HTMLButtonElement} */ (backdrop.querySelector('.cms-signout-publish'));
    const keep = /** @type {HTMLButtonElement} */ (backdrop.querySelector('.cms-signout-keep'));
    const discard = /** @type {HTMLButtonElement} */ (backdrop.querySelector('.cms-signout-discard'));
    const cancel = /** @type {HTMLButtonElement} */ (backdrop.querySelector('.cms-signout-cancel'));
    const title = /** @type {HTMLElement} */ (backdrop.querySelector('#cms-signout-title'));
    title.textContent = t('editor.toolbar.unpublishedTitle');
    publish.textContent = t('editor.toolbar.publishAndSignOut');
    publish.classList.remove('is-danger');
    keep.textContent = t('editor.toolbar.keepAndSignOut');
    discard.textContent = t('editor.toolbar.discardAndSignOut');
    copy.textContent = canKeep
      ? t(count === 1 ? 'editor.toolbar.signOutKeepOne' : 'editor.toolbar.signOutKeepOther', { count })
      : t(count === 1 ? 'editor.toolbar.signOutLoseOne' : 'editor.toolbar.signOutLoseOther', { count });
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
    const backdrop = /** @type {HTMLElement} */ (document.querySelector('.cms-dialog-backdrop'));
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
  let draftCount = 0;
  const retryRebuildButton = /** @type {HTMLButtonElement | null} */ (toolbar.querySelector('.cms-retry-rebuild-btn'));
  async function fetchDraftCount() {
    try {
      const data = await draftClient.getState();
      canPublishDrafts = data.canPublish;
      const publishButton = /** @type {HTMLButtonElement | null} */ (toolbar.querySelector('.cms-publish-btn'));
      if (publishButton) publishButton.hidden = !data.canPublish;
      if (retryRebuildButton) retryRebuildButton.hidden = !data.retryRebuild || !data.canPublish;
      rebuildPending = data.retryRebuild && data.canPublish;
      if (rebuildPending && current.state === 'idle') setStatus('error', t('editor.publish.notUpdated'));
      draftCount = data.count;
      return data.count;
    } catch {
      return 0;
    }
  }

  /** After a reload during Publish: the drafts that are gone were published. @param {number} before */
  async function confirmPublishAfterReload(before) {
    let left = before;
    // The publish can still be finishing on the server; give it a few seconds.
    for (let attempt = 0; attempt < 8; attempt++) {
      left = await fetchDraftCount();
      if (left < before) break;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    if (left < before) showToast.saved({ message: t('editor.toolbar.publishedAfterReload', { changes: changeCount(before - left) }) });
    else showToast(t('editor.toolbar.publishUnconfirmed', { changes: changeCount(left) }), 'error');
  }

  /** @param {{ reload?: boolean }} [options] */
  async function publishDrafts({ reload = true } = {}) {
    setStatus('saving', t('editor.toolbar.publishing'));
    try { sessionStorage.setItem(PUBLISHING_KEY, JSON.stringify({ count: draftCount, at: Date.now() })); } catch { /* not carried */ }
    try {
      const presentation = presentPublishResult(await draftClient.publish());
      try { sessionStorage.removeItem(PUBLISHING_KEY); } catch { /* nothing to clear */ }
      await fetchDraftCount();
      if (retryRebuildButton) retryRebuildButton.hidden = !presentation.retryAvailable;
      if (presentation.status) {
        setStatus(presentation.status.state, presentation.status.text);
      }
      if (presentation.reload && reload) reloadWithToast(presentation.toast.message, presentation.toast.kind);
      else showToast(presentation.toast.message, presentation.toast.kind);
      return presentation.completed;
    } catch {
      try { sessionStorage.removeItem(PUBLISHING_KEY); } catch { /* nothing to clear */ }
      setStatus('error', t('editor.toolbar.publishFailed'));
      showToast(t('editor.toolbar.publishFailedCopy'), 'error');
      return false;
    }
  }

  toolbar.querySelector('.cms-exit-btn')?.addEventListener('click', async () => {
    // Text on the page that hasn't saved yet (still being edited, or kept after
    // a failed save) is gone once the page unloads.
    if (hasUnsavedEdits() && !(await confirmToolbarAction({
      title: t('editor.toolbar.unsaved'),
      copy: t('editor.toolbar.unsavedSignOutCopy'),
      confirmLabel: t('editor.toolbar.signOutAnyway'),
      danger: true,
    }))) return;

    // Body-block drafts wait for Publish in every delivery mode, not only in
    // static delivery or under an authorization policy.
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
          showToast(t('editor.toolbar.discardNeedsRecovery'), 'error');
          return;
        }
      } else if (action !== 'keep') {
        return;
      }
    }

    clearDirty();
    await onLogout();
  });

  const publishBtn = /** @type {HTMLButtonElement | null} */ (toolbar.querySelector('.cms-publish-btn'));
  publishBtn?.addEventListener('click', async () => {
    const changes = changeCount(draftCount);
    if (!(await confirmToolbarAction({
      title: draftCount === 1 ? t('editor.toolbar.publishConfirmOne') : t('editor.toolbar.publishConfirmOther', { count: draftCount }),
      // When visitors see it depends on the server (a Markdown source can need
      // a rebuild), so only static delivery says it here; the result says it.
      copy: staticDelivery
        ? t(draftCount === 1 ? 'editor.toolbar.publishCopyStaticOne' : 'editor.toolbar.publishCopyStaticOther', { changes })
        : t('editor.toolbar.publishCopy', { changes }),
      confirmLabel: t('editor.toolbar.publish'),
      restoreFocus: publishBtn,
    }))) return;
    await publishDrafts();
  });

  const discardBtn = /** @type {HTMLButtonElement | null} */ (toolbar.querySelector('.cms-discard-btn'));
  discardBtn?.addEventListener('click', async () => {
    const changes = changeCount(draftCount);
    if (!(await confirmToolbarAction({
      title: t('editor.toolbar.discardConfirm', { changes }),
      copy: t('editor.toolbar.discardCopy', { changes }),
      confirmLabel: t('editor.toolbar.discard'),
      danger: true,
      restoreFocus: discardBtn,
    }))) return;
    try {
      await draftClient.discard();
      reloadWithToast(t('editor.toolbar.discarded', { changes }), 'success');
    } catch {
      showToast(t('editor.toolbar.discardFailed'), 'error');
    }
  });

  // Server delivery hides the draft controls until a body draft exists. Field
  // edits save directly (no draft), so the count reflects pending body blocks.
  // Refresh on mount and whenever a body block is drafted; publish/discard
  // reload the page, so mount re-evaluates from scratch.
  const draftControls = /** @type {HTMLElement | null} */ (toolbar.querySelector('.cms-draft-controls'));
  async function refreshDraftControls() {
    const count = await fetchDraftCount();
    if (draftControls) draftControls.hidden = count === 0;
    const label = toolbar.querySelector('.cms-go-live-label');
    if (label) label.textContent = count > 0 ? t('editor.toolbar.publishCount', { count }) : t('editor.toolbar.publish');
    publishBtn?.setAttribute('aria-label', count > 0 ? t('editor.toolbar.publishChanges', { changes: changeCount(count) }) : t('editor.toolbar.publish'));
  }
  refreshDraftControls();
  window.addEventListener('cms:draftSaved', refreshDraftControls);
  // Drafts can change elsewhere (another tab, another device) while this page waits.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshDraftControls();
  });
  retryRebuildButton?.addEventListener('click', async () => {
    retryRebuildButton.disabled = true;
    setStatus('saving', t('editor.toolbar.retryingUpdate'));
    try {
      const data = await draftClient.retryDeployment();
      retryRebuildButton.hidden = true;
      setStatus(data.deploymentTracked ? 'saving' : 'idle', data.deploymentTracked ? t('editor.deploy.updating') : t('editor.toolbar.updateRequested'));
      showToast(t('editor.toolbar.updateRequestedCopy'), 'success');
      if (data.deploymentTracked) deploymentStatus.schedule();
    } catch {
      setStatus('error', t('editor.publish.notUpdated'));
      showToast(t('editor.toolbar.retryUpdateFailed'), 'error');
    } finally { retryRebuildButton.disabled = false; }
  });

  void deploymentStatus.refresh();

  const keys = mountToolbarKeys(/** @type {HTMLElement} */ (toolbar.querySelector('.cms-toolbar-inner')), { skipLabel: t('editor.toolbar.skip') });
  const studioButton = toolbar.querySelector('.cms-studio-btn');
  const mapButton = toolbar.querySelector('.cms-map-btn');
  const editModeButton = toolbar.querySelector('.cms-mode-edit');
  const previewModeButton = toolbar.querySelector('.cms-mode-preview');
  return {
    toolbar,
    toolbarTabStop: keys.tabStop,
    studioButton,
    mapButton,
    editModeButton,
    previewModeButton,
    setStatus,
    reportProblem,
    setUnsaved,
  };
}
