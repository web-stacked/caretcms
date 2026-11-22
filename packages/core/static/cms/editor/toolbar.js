import { isPolicyDraftMode } from './config.js';
import { toggleHighlight } from './highlight.js';
import { buildCmsUrl, isStaticDelivery } from './config.js';
import { createDeploymentStatusPoller } from './deployment-status.js';
import { presentPublishResult } from './publish-result.js';
import { createDraftClient } from './draft-client.js';
import { createChangesView } from './changes-view.js';
import { mountAwayNotice } from './away-notice.js';
import { buildPublishReceipt } from './publish-receipt.js';
import { createFirstVisit } from './first-visit.js';
import { createPageHistory } from './page-history.js';
import { mountToolbarKeys } from './toolbar-keys.js';
import { t, tHtml } from './i18n.js';
/** @typedef {'saving' | 'idle' | 'error'} ToolbarStatusState */

// A Publish in progress, carried across a reload the dev server starts.
const PUBLISHING_KEY = 'caret:publishing';

/**
 * The entries a publish published, with the revision each now has.
 * @param {unknown} result
 * @returns {{ collection: string, id: string, revision: number, fingerprint: string }[]}
 */
function publishedEntries(result) {
  const list = result && typeof result === 'object' ? /** @type {{ published?: unknown }} */ (result).published : null;
  return (Array.isArray(list) ? list : [])
    .filter(entry => entry && typeof entry.collection === 'string' && typeof entry.id === 'string' && Number.isSafeInteger(entry.revision) && typeof entry.fingerprint === 'string')
    .map(entry => ({ collection: entry.collection, id: entry.id, revision: entry.revision, fingerprint: entry.fingerprint }));
}

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
          <button class="cms-conflict-btn" type="button" hidden></button>
          <button class="cms-changes-btn" type="button" aria-pressed="false" title="${tHtml('editor.changes.title')}">${tHtml('editor.changes.show')}</button>
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
            <button class="cms-page-history-btn" type="button">${tHtml('editor.pageHistory.title')}</button>
            <button class="cms-intro-btn" type="button">${tHtml('editor.intro.again')}</button>
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
  const draftMode = staticDelivery || isPolicyDraftMode();
  // At rest the pill names where your work stands: "Live" when saves go
  // straight to the site; in draft mode "Draft" while changes wait for
  // Publish, "Published" once nothing does.
  let modeLabel = draftMode ? t('editor.toolbar.draft') : t('editor.toolbar.live');

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

  /** Draft mode only: the resting label and panel hint follow the unpublished count. @param {number} count */
  function showRestingMode(count) {
    const label = count > 0 ? t('editor.toolbar.draft') : t('editor.toolbar.published');
    const hint = count > 0 ? (staticDelivery ? t('editor.toolbar.hintStatic') : t('editor.toolbar.hintPolicy')) : t('editor.toolbar.hintPublished');
    const wasResting = statusText?.textContent === modeLabel;
    modeLabel = label;
    pill.dataset.state = count > 0 ? 'draft' : 'published';
    const mode = panel.querySelector('.cms-status-panel-mode strong');
    if (mode) mode.textContent = label;
    const hintLine = panel.querySelector('.cms-status-panel-hint');
    if (hintLine) hintLine.textContent = hint;
    if (current.state === 'idle' && wasResting) {
      current = { state: 'idle', text: label };
      if (statusText) statusText.textContent = label;
    }
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
  /**
   * @param {string} message @param {'success' | 'error'} kind
   * @param {{ collection: string, id: string, revision: number, fingerprint: string }[]} [undoable] What a publish published, for its Undo.
   */
  function reloadWithToast(message, kind, undoable) {
    try { sessionStorage.setItem('caret:after-reload-toast', JSON.stringify({ message, kind, ...(undoable?.length ? { undoable } : {}) })); } catch { /* shown nowhere */ }
    window.location.reload();
  }
  try {
    const carried = JSON.parse(sessionStorage.getItem('caret:after-reload-toast') || 'null');
    sessionStorage.removeItem('caret:after-reload-toast');
    const publishing = JSON.parse(sessionStorage.getItem(PUBLISHING_KEY) || 'null');
    sessionStorage.removeItem(PUBLISHING_KEY);
    if (carried && typeof carried.message === 'string') {
      // Shown as the page comes back, so it stays long enough to be read.
      // After a publish: Undo puts back what it replaced, while nothing has changed since.
      const undoable = Array.isArray(carried.undoable) ? carried.undoable : [];
      setTimeout(() => (carried.kind === 'error'
        ? showToast(carried.message, 'error')
        : showToast.saved(undoable.length
          ? { message: carried.message, duration: 15000, action: { label: t('editor.undoPublish.action'), onClick: () => undoPublish(undoable) } }
          : { message: carried.message })), 0);
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

  /**
   * Wait for a choice in the toolbar dialog, whichever of its buttons are shown.
   * @returns {Promise<'publish' | 'keep' | 'discard' | 'cancel'>}
   */
  function awaitDialogChoice() {
    const backdrop = /** @type {HTMLElement} */ (document.querySelector('.cms-dialog-backdrop'));
    const publish = /** @type {HTMLButtonElement} */ (backdrop.querySelector('.cms-signout-publish'));
    const keep = /** @type {HTMLButtonElement} */ (backdrop.querySelector('.cms-signout-keep'));
    const discard = /** @type {HTMLButtonElement} */ (backdrop.querySelector('.cms-signout-discard'));
    const cancel = /** @type {HTMLButtonElement} */ (backdrop.querySelector('.cms-signout-cancel'));
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
    return awaitDialogChoice();
  }

  /**
   * Ask which version of an entry to keep when the same fields changed in the
   * draft and on the site.
   * @param {import('./draft-client.js').DraftConflict} conflict
   * @returns {Promise<'mine' | 'site' | 'cancel'>}
   */
  async function chooseConflictAction(conflict) {
    const backdrop = /** @type {HTMLElement} */ (document.querySelector('.cms-dialog-backdrop'));
    const copy = /** @type {HTMLElement} */ (backdrop.querySelector('#cms-signout-copy'));
    const publish = /** @type {HTMLButtonElement} */ (backdrop.querySelector('.cms-signout-publish'));
    const keep = /** @type {HTMLButtonElement} */ (backdrop.querySelector('.cms-signout-keep'));
    const discard = /** @type {HTMLButtonElement} */ (backdrop.querySelector('.cms-signout-discard'));
    const title = /** @type {HTMLElement} */ (backdrop.querySelector('#cms-signout-title'));
    const name = conflict.title ? t('editor.publish.entryNamed', { title: conflict.title }) : t('editor.publish.entryUnnamed');
    // Body text whose block changed can't be kept in place: it can be copied, then dropped.
    const bodyOnly = !conflict.removed && conflict.fields.length === 0;
    title.textContent = t(conflict.removed ? 'editor.conflict.removedTitle' : 'editor.conflict.title', { name });
    const lines = conflict.removed
      ? [t('editor.conflict.removedCopy')]
      : [
        ...(conflict.fields.length ? [t('editor.conflict.copy'), ...conflict.fields.flatMap(field => ['',
          t('editor.conflict.field', { label: field.label }),
          t('editor.conflict.site', { value: field.site || t('editor.conflict.empty') }),
          t('editor.conflict.mine', { value: field.mine || t('editor.conflict.empty') })])] : []),
        ...(conflict.body.length ? [...(conflict.fields.length ? [''] : []), t('editor.conflict.bodyCopy'),
          ...conflict.body.flatMap(text => ['', t('editor.conflict.bodyMine', { value: text || t('editor.conflict.empty') })])] : []),
      ];
    copy.style.whiteSpace = 'pre-line';
    publish.classList.remove('is-danger');
    try {
      for (;;) {
        copy.textContent = lines.join('\n');
        // Body text only: copy it (neutral) or drop it (the destructive slot).
        // Otherwise: take the site's version, or keep mine.
        publish.textContent = t(conflict.removed ? 'editor.conflict.keepMineRemoved' : 'editor.conflict.keepMine');
        keep.textContent = t(bodyOnly ? 'editor.conflict.copyText' : conflict.removed ? 'editor.conflict.useSiteRemoved' : 'editor.conflict.useSite');
        discard.textContent = t('editor.conflict.dropText');
        publish.hidden = bodyOnly;
        keep.hidden = false;
        discard.hidden = !bodyOnly;
        const choice = await awaitDialogChoice();
        if (choice === 'cancel') return 'cancel';
        if (choice === 'publish') return 'mine';
        if (choice === 'discard' || !bodyOnly) return 'site';
        try {
          await navigator.clipboard.writeText(conflict.body.join('\n\n'));
          showToast(t('editor.conflict.copied'), 'success');
        } catch { /* the text stays on screen to copy by hand */ }
      }
    } finally {
      copy.style.whiteSpace = '';
    }
  }


  /**
   * @param {{ title: string, copy: string, confirmLabel: string, danger?: boolean, restoreFocus?: HTMLElement | null, extra?: HTMLElement | null }} options
   *   `extra` is shown between the copy and the buttons while the dialog is open.
   * @returns {Promise<boolean>}
   */
  function confirmToolbarAction({ title, copy, confirmLabel, danger = false, restoreFocus = null, extra = null }) {
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
    if (extra) copyEl.after(extra);
    backdrop.hidden = false;
    cancel.focus();

    return new Promise((resolve) => {
      /** @param {boolean} accepted */
      function finish(accepted) {
        backdrop.hidden = true;
        extra?.remove();
        confirm.disabled = false;
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
        // Loop through whatever can take focus: the extra content's controls, Cancel, then the confirm button.
        const controls = /** @type {HTMLElement[]} */ ([...(extra?.querySelectorAll('input, button') ?? []), cancel, ...(confirm.disabled ? [] : [confirm])]);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
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
  // First visit in this browser: outline what can be edited and say how it works. Tools shows it again.
  const firstVisit = createFirstVisit({ showToast, draftMode });
  toolbar.querySelector('.cms-intro-btn')?.addEventListener('click', () => { toolsMenu?.removeAttribute('open'); firstVisit.show(); });
  firstVisit.showOnce();
  // Page history: drag back through earlier versions of this page; Restore makes one a draft.
  const pageHistory = createPageHistory({ showToast, reload: message => reloadWithToast(message, 'success') });
  toolbar.querySelector('.cms-page-history-btn')?.addEventListener('click', () => { toolsMenu?.removeAttribute('open'); void pageHistory.open(); });
  document.addEventListener('pointerdown', (event) => {
    if (toolsMenu?.open && event.target instanceof Node && !toolsMenu.contains(event.target)) {
      toolsMenu.removeAttribute('open');
    }
  });

  /** @type {{ markOwn: (entries: { collection: string, id: string }[]) => void }} */
  let awayNotice = { markOwn: () => {} };
  let canPublishDrafts = true;
  let draftCount = 0;
  /** @type {import('./draft-client.js').DraftConflict[]} */
  let draftConflicts = [];
  const conflictBtn = /** @type {HTMLButtonElement | null} */ (toolbar.querySelector('.cms-conflict-btn'));

  /**
   * Walk the editor through each draft that collides with the site. Keeping
   * their own values needs no reload (the page already shows them); taking the
   * site's changes what the page shows.
   */
  async function settleConflicts() {
    let tookSite = false;
    for (const conflict of [...draftConflicts]) {
      const choice = await chooseConflictAction(conflict);
      if (choice === 'cancel') break;
      try {
        await draftClient.resolveConflict(conflict.collection, conflict.id, choice);
        if (choice === 'site') tookSite = true;
      } catch {
        showToast(t('editor.conflict.failed'), 'error');
        break;
      }
    }
    if (tookSite) { reloadWithToast(t('editor.conflict.tookSite'), 'success'); return; }
    await refreshDraftControls();
    if (draftConflicts.length === 0) showToast(t('editor.conflict.keptMine'), 'success');
  }
  conflictBtn?.addEventListener('click', settleConflicts);

  // The Changes view: a dot on each element the editor changed, or that changed on the site under their draft.
  const changesBtn = /** @type {HTMLButtonElement | null} */ (toolbar.querySelector('.cms-changes-btn'));
  const changesView = createChangesView({
    getChanges: () => draftClient.getChanges(),
    revertField: (collection, id, field) => draftClient.revertField(collection, id, field),
    settleConflicts,
    onReverted: () => reloadWithToast(t('editor.changes.undone'), 'success'),
    onError: message => showToast(message, 'error'),
  });
  changesBtn?.addEventListener('click', async () => {
    const marked = await changesView.toggle();
    changesBtn.setAttribute('aria-pressed', String(changesView.isOn()));
    if (marked === null) showToast(t('editor.changes.unavailable'), 'error');
    else if (changesView.isOn() && marked === 0) showToast(t('editor.changes.none'), 'success');
  });
  /** Whether the last count came from the server, rather than a failed request. */
  let draftCountKnown = false;
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
      draftCountKnown = true;
      draftConflicts = data.conflicts;
      if (conflictBtn) {
        conflictBtn.hidden = draftConflicts.length === 0;
        conflictBtn.textContent = t(draftConflicts.length === 1 ? 'editor.conflict.buttonOne' : 'editor.conflict.buttonOther', { count: draftConflicts.length });
      }
      return data.count;
    } catch {
      draftCountKnown = false;
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

  /** Titles of the entries a publish held back for uncommitted file changes. @param {unknown} result */
  function heldForUncommitted(result) {
    const conflicts = result && typeof result === 'object' ? /** @type {{ conflicts?: unknown }} */ (result).conflicts : null;
    return (Array.isArray(conflicts) ? conflicts : [])
      .filter(conflict => conflict && conflict.reason === 'uncommitted_source')
      .map(conflict => typeof conflict.title === 'string' && conflict.title ? conflict.title : String(conflict.id ?? ''));
  }

  /**
   * One result for a publish that ran twice: what the first pass published,
   * plus everything the second pass reports.
   * @param {unknown} first @param {unknown} second
   */
  function mergePublishResults(first, second) {
    const a = /** @type {Record<string, unknown>} */ (first && typeof first === 'object' ? first : {});
    const b = /** @type {Record<string, unknown>} */ (second && typeof second === 'object' ? second : {});
    const list = (/** @type {unknown} */ value) => (Array.isArray(value) ? value : []);
    return { ...b, published: [...list(a.published), ...list(b.published)] };
  }

  /** @param {{ reload?: boolean }} [options] */
  /**
   * Undo a publish: stage what each entry was before it as a draft and publish
   * those drafts. An entry changed since, or holding a newer draft, is left alone.
   * @param {{ collection: string, id: string, revision: number, fingerprint: string }[]} published
   */
  async function undoPublish(published) {
    /** @type {{ collection: string, id: string }[]} */
    const staged = [];
    /** @type {string[]} */
    const refused = [];
    for (const entry of published) {
      try {
        const reason = await draftClient.stageUndo(entry.collection, entry.id, entry.revision, entry.fingerprint);
        if (reason) refused.push(reason);
        else staged.push({ collection: entry.collection, id: entry.id });
      } catch {
        refused.push('unknown');
      }
    }
    if (staged.length === 0) {
      showToast(t(`editor.undoPublish.${refused[0] ?? 'unknown'}`), 'error');
      return;
    }
    // What the page shows next is the editor's own doing, not news for "since you were last here".
    awayNotice.markOwn(staged);
    await publishDrafts({ entries: staged, undoing: true });
    if (refused.length) showToast(t(`editor.undoPublish.${refused[0]}`), 'error');
  }

  /**
   * @param {{ reload?: boolean, entries?: { collection: string, id: string }[] | null, undoing?: boolean }} [options]
   *   `entries` publishes only those drafts; `undoing` says the publish puts back an earlier one.
   */
  async function publishDrafts({ reload = true, entries = null, undoing = false } = {}) {
    setStatus('saving', t('editor.toolbar.publishing'));
    try { sessionStorage.setItem(PUBLISHING_KEY, JSON.stringify({ count: draftCount, at: Date.now() })); } catch { /* not carried */ }
    try {
      let result = await draftClient.publish({ entries });
      // Entries held back because their file has changes Git hasn't committed:
      // publishing would commit those too, so ask first.
      const uncommitted = heldForUncommitted(result);
      if (uncommitted.length > 0 && await confirmToolbarAction({
        title: t(uncommitted.length === 1 ? 'editor.uncommitted.titleOne' : 'editor.uncommitted.titleOther', { count: uncommitted.length }),
        copy: t('editor.uncommitted.copy', { names: uncommitted.join(', ') }),
        confirmLabel: t('editor.uncommitted.publishAnyway'),
      })) {
        const forced = await draftClient.publish({ allowUncommitted: true, entries });
        result = mergePublishResults(result, forced);
      }
      const presentation = presentPublishResult(result);
      try { sessionStorage.removeItem(PUBLISHING_KEY); } catch { /* nothing to clear */ }
      await fetchDraftCount();
      if (retryRebuildButton) retryRebuildButton.hidden = !presentation.retryAvailable;
      if (presentation.status) {
        setStatus(presentation.status.state, presentation.status.text);
      }
      const undoable = presentation.completed && !undoing ? publishedEntries(result) : [];
      const message = presentation.completed && undoing ? t('editor.undoPublish.done') : presentation.toast.message;
      if (presentation.reload && reload) reloadWithToast(message, presentation.toast.kind, undoable);
      else showToast(presentation.toast.message, presentation.toast.kind);
      // Entries held back because the site changed in the same place: ask now.
      if (!presentation.completed && draftConflicts.length > 0 && reload) void settleConflicts();
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
    // What will be published, by name. Without the list the dialog still asks, as before.
    const pending = await draftClient.getPending().catch(() => []);
    const confirmButton = /** @type {HTMLButtonElement | null} */ (document.querySelector('.cms-dialog-backdrop .cms-signout-publish'));
    const receipt = pending.length ? buildPublishReceipt(pending, (chosen) => { if (confirmButton) confirmButton.disabled = chosen === 0; }) : null;
    if (!(await confirmToolbarAction({
      extra: receipt?.element,
      title: draftCount === 1 ? t('editor.toolbar.publishConfirmOne') : t('editor.toolbar.publishConfirmOther', { count: draftCount }),
      // When visitors see it depends on the server (a Markdown source can need
      // a rebuild), so only static delivery says it here; the result says it.
      copy: staticDelivery
        ? t(draftCount === 1 ? 'editor.toolbar.publishCopyStaticOne' : 'editor.toolbar.publishCopyStaticOther', { changes })
        : t('editor.toolbar.publishCopy', { changes }),
      confirmLabel: t('editor.toolbar.publish'),
      restoreFocus: publishBtn,
    }))) return;
    await publishDrafts({ entries: receipt?.chosen() ?? null });
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
    // An unknown count keeps "Draft": never claim it's published on a failed check.
    if (draftMode && draftCountKnown) showRestingMode(count);
    const label = toolbar.querySelector('.cms-go-live-label');
    if (label) label.textContent = count > 0 ? t('editor.toolbar.publishCount', { count }) : t('editor.toolbar.publish');
    publishBtn?.setAttribute('aria-label', count > 0 ? t('editor.toolbar.publishChanges', { changes: changeCount(count) }) : t('editor.toolbar.publish'));
  }
  refreshDraftControls();

  // "Since you were last here": content on this page that changed and isn't the editor's own draft.
  awayNotice = mountAwayNotice({
    showToast,
    ownChanges: async () => new Set((await draftClient.getChanges()).flatMap(entry =>
      entry.changes.filter(change => change.kind !== 'site').map(change => `${entry.collection}::${entry.id}::${change.field}`))),
  });
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
