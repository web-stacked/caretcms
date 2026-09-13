import { canPerform } from "../authorization.js";
export const prerender = false;

import type { APIContext } from "astro";
import { isEditorAuthenticated } from "../auth/session.js";
import { getRuntimeConfig } from "../config.js";
import { resolveAdapter } from "./_helpers.js";
import {
  isKnownStudioCollection,
  resolveCollectionStudioConfig,
} from "../schema-registry.js";
import { publicationField } from "../collection-policy.js";
import {
  escapeHtml,
  htmlResponse,
  redirectResponse,
  renderStudioPage,
  serializeJsonForScript,
} from "../views/studio-layout.js";

function humanize(name: string): string {
  return name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function GET(context: APIContext): Promise<Response> {
  const runtime = getRuntimeConfig();
  const collection = (context.params.collection ?? "").toString();
  const loginRedirect = `${runtime.mountPath}?redirect=${encodeURIComponent(context.url.pathname)}`;

  if (!isEditorAuthenticated(context)) {
    return redirectResponse(loginRedirect);
  }

  if (!collection) {
    return redirectResponse(`${runtime.mountPath}/cms`);
  }

  const adapter = await resolveAdapter();
  if (!(await isKnownStudioCollection(adapter, collection))) {
    return redirectResponse(`${runtime.mountPath}/cms`);
  }

  const collectionConfig = await resolveCollectionStudioConfig(adapter, collection);
  if (collectionConfig.singletonId) {
    return redirectResponse(
      `${runtime.mountPath}/cms/${encodeURIComponent(collection)}/${encodeURIComponent(collectionConfig.singletonId)}`,
    );
  }
  const label = collectionConfig.label || humanize(collection);
  const messages = runtime.messages;
  const creatable = collectionConfig.creatable !== false && await canPerform("edit", collection);
  const orderable = collectionConfig.orderable !== false && await canPerform("edit", collection);
  const publicationFieldName = publicationField(collectionConfig);
  const safeCollection = escapeHtml(collection);

  const extraStyles = `
    .entry-card {
      transition: transform 0.2s, border-color 0.2s, background 0.2s;
    }
    .entry-card:hover {
      transform: translateY(-2px);
      border-color: var(--studio-accent-strong, rgba(59, 130, 246, 0.3));
    }
    .entry-thumb {
      aspect-ratio: 1;
      background: rgba(0, 0, 0, 0.2);
      overflow: hidden;
      display: block;
    }
    .entry-thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .reorder-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border: 1px solid var(--studio-border);
      background: var(--studio-surface);
      cursor: grab;
      transition: border-color 0.15s, opacity 0.15s, transform 0.15s;
      user-select: none;
    }
    .reorder-item:active { cursor: grabbing; }
    .reorder-item.dragging { opacity: 0.4; border-color: var(--studio-accent); }
    .reorder-item.drag-over { border-color: var(--studio-accent); transform: scale(1.01); }
    .reorder-handle { color: var(--studio-text-dim); font-size: 16px; line-height: 1; flex-shrink: 0; }
    .reorder-label { flex: 1; font-size: 14px; color: var(--studio-text); }
    .reorder-order { font-size: 11px; color: var(--studio-text-dim); font-variant-numeric: tabular-nums; min-width: 24px; text-align: right; }
    .reorder-controls { display: flex; gap: 0.35rem; flex-shrink: 0; }
    .reorder-move { min-width: 32px; padding: 4px 8px; }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 1rem;
    }
    .modal-backdrop[hidden] { display: none; }
    .modal-card {
      width: 100%;
      max-width: 28rem;
      background: var(--studio-bg);
      border: 1px solid var(--studio-border);
    }
    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.5rem;
      border-bottom: 1px solid var(--studio-border);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--studio-text);
    }
    .modal-body { padding: 1.5rem; }
  `;

  const body = `<div class="studio-fade-in" style="max-width:80rem;margin:0 auto;" id="collection-page" data-collection="${safeCollection}">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:1.5rem;">
      <div>
        <h1 style="font-family:var(--studio-font-heading);font-size:1.25rem;margin:0;color:var(--studio-text);">${escapeHtml(label)}</h1>
        <p id="entry-count" style="font-size:0.7rem;margin:0.25rem 0 0;color:var(--studio-text-dim);">${escapeHtml(messages["common.loading"])}</p>
      </div>
      <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;">
        <label for="search-input" style="font-size:0.7rem;color:var(--studio-text-dim);">${escapeHtml(messages["collection.search"])}</label>
        <input id="search-input" name="search" type="search" placeholder="${escapeHtml(messages["collection.searchPlaceholder"])}" class="studio-input" style="max-width:240px;" />
        ${orderable ? `<button id="btn-reorder" type="button" class="studio-btn-ghost" aria-controls="reorder-container" aria-expanded="false">${escapeHtml(messages["collection.reorder"])}</button>` : ""}
        ${creatable ? `<button id="btn-new" class="studio-btn-primary">${escapeHtml(messages["collection.new"])}</button>` : ""}
      </div>
    </div>

    <div id="loading" style="display:flex;justify-content:center;padding:5rem 0;">
      <div class="studio-spinner" style="width:24px;height:24px;"></div>
    </div>

    <div id="empty" hidden style="text-align:center;padding:5rem 0;color:var(--studio-text-dim);">
      <p style="font-size:0.875rem;margin:0 0 0.75rem;">${escapeHtml(messages["collection.noEntries"])}</p>
      ${creatable ? `<button id="btn-empty-create" class="studio-btn-primary">${escapeHtml(messages["collection.createFirst"])}</button>` : ""}
    </div>

    <div id="error-state" hidden style="text-align:center;padding:5rem 0;">
      <p style="font-size:0.875rem;margin:0 0 0.75rem;color:var(--studio-red);">${escapeHtml(messages["collection.failed"])}</p>
      <button id="retry-btn" class="studio-btn-ghost">${escapeHtml(messages["common.retry"])}</button>
    </div>

    <div id="entries-grid" hidden style="display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));"></div>

    <nav id="pagination" aria-label="${escapeHtml(messages["collection.pagination"])}" hidden style="display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-top:1rem;">
      <button id="page-prev" type="button" class="studio-btn-ghost">${escapeHtml(messages["collection.previous"])}</button>
      <span id="page-range" role="status" aria-live="polite"></span>
      <button id="page-next" type="button" class="studio-btn-ghost">${escapeHtml(messages["collection.next"])}</button>
    </nav>
    <p id="reorder-scope" hidden style="font-size:0.8rem;color:var(--studio-text-dim);">${escapeHtml(messages["collection.reorderScope"])}</p>

    <div id="reorder-container" role="region" aria-label="${escapeHtml(messages["collection.reorder"])}" hidden>
      <div id="reorder-list" role="list" style="display:flex;flex-direction:column;gap:0.25rem;"></div>
      <div style="display:flex;justify-content:flex-end;gap:0.75rem;margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--studio-border);">
        <button id="btn-reorder-cancel" type="button" class="studio-btn-ghost">${escapeHtml(messages["common.cancel"])}</button>
        <button id="btn-reorder-save" type="button" class="studio-btn-primary">${escapeHtml(messages["collection.saveOrder"])}</button>
      </div>
    </div>
  </div>

  <div id="create-dialog" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="create-dialog-title" aria-describedby="create-hint" hidden>
    <div class="modal-card">
      <div class="modal-header">
        <h2 id="create-dialog-title" style="font:inherit;letter-spacing:inherit;text-transform:inherit;margin:0;">${escapeHtml(messages["collection.newEntry"])}</h2>
        <button id="btn-create-close" type="button" class="studio-btn-ghost" style="padding:4px 10px;">${escapeHtml(messages["common.close"])}</button>
      </div>
      <div class="modal-body">
        <label for="create-id-input" class="studio-label">${escapeHtml(messages["collection.entryId"])}</label>
        <input id="create-id-input" type="text" class="studio-input" placeholder="${escapeHtml(messages["collection.entryIdPlaceholder"])}" autocomplete="off" spellcheck="false" />
        <p id="create-hint" style="font-size:10px;margin:0.5rem 0 0.35rem;color:var(--studio-text-dim);">${escapeHtml(messages["collection.idHint"])}</p>
        ${publicationFieldName ? `<p style="font-size:10px;margin:0 0 1rem;color:var(--studio-text-dim);">${escapeHtml(messages["collection.publishHint"])}</p>` : ""}
        <p id="create-error" class="studio-error-text" hidden></p>
        <div style="display:flex;justify-content:flex-end;gap:0.75rem;">
          <button id="btn-create-cancel" type="button" class="studio-btn-ghost">${escapeHtml(messages["common.cancel"])}</button>
          <button id="btn-create-confirm" type="button" class="studio-btn-primary" disabled>${escapeHtml(messages["collection.create"])}</button>
        </div>
      </div>
    </div>
  </div>`;

  const inlineScript = `(function () {
    var COLLECTION = ${serializeJsonForScript(collection)};
    var API = ${serializeJsonForScript(runtime.apiBasePath)};
    var MOUNT = ${serializeJsonForScript(runtime.mountPath)};
    var MSG = ${serializeJsonForScript(messages)};
    var PUBLICATION_FIELD = ${serializeJsonForScript(publicationFieldName)};
    var ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    var allEntries = [];
    var currentPage = 1;
    var query = '';
    var requestVersion = 0;
    var searchTimer;
    var pagination = document.getElementById('pagination');
    var previousPage = document.getElementById('page-prev');
    var nextPage = document.getElementById('page-next');
    var pageRange = document.getElementById('page-range');
    var reorderScope = document.getElementById('reorder-scope');

    var grid = document.getElementById('entries-grid');
    var loading = document.getElementById('loading');
    var empty = document.getElementById('empty');
    var errorState = document.getElementById('error-state');
    var retryBtn = document.getElementById('retry-btn');
    var countEl = document.getElementById('entry-count');
    var searchInput = document.getElementById('search-input');
    var newBtn = document.getElementById('btn-new');
    var emptyCreateBtn = document.getElementById('btn-empty-create');
    var reorderBtn = document.getElementById('btn-reorder');
    var reorderContainer = document.getElementById('reorder-container');
    var reorderList = document.getElementById('reorder-list');
    var reorderSave = document.getElementById('btn-reorder-save');
    var reorderCancel = document.getElementById('btn-reorder-cancel');
    var dialog = document.getElementById('create-dialog');
    var idInput = document.getElementById('create-id-input');
    var errorEl = document.getElementById('create-error');
    var confirmBtn = document.getElementById('btn-create-confirm');
    var createCloseBtn = document.getElementById('btn-create-close');
    var createCancelBtn = document.getElementById('btn-create-cancel');
    var dialogTrigger = null;
    var knownDuplicateIds = new Set();

    function htmlEsc(s) { return String(s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; });
    }

    function getTitle(d) {
      if (!d) return MSG['collection.untitled'];
      for (var i = 0; i < ['name','title','question','company_name','headline','label'].length; i++) {
        var k = ['name','title','question','company_name','headline','label'][i];
        if (typeof d[k] === 'string' && d[k]) return d[k];
      }
      return MSG['collection.untitled'];
    }
    function getThumb(d) {
      if (!d) return null;
      if (Array.isArray(d.images) && typeof d.images[0] === 'string') return d.images[0];
      if (Array.isArray(d.images) && d.images[0] && typeof d.images[0].src === 'string') return d.images[0].src;
      if (typeof d.image === 'string' && d.image) return d.image;
      if (typeof d.coverImage === 'string' && d.coverImage) return d.coverImage;
      if (typeof d.portrait === 'string' && d.portrait) return d.portrait;
      if (typeof d.thumbnail === 'string' && d.thumbnail) return d.thumbnail;
      if (typeof d.bg_image === 'string' && d.bg_image) return d.bg_image;
      return null;
    }
    function getSubtitle(d) {
      if (!d) return '';
      if (typeof d.category === 'string') return d.category;
      if (typeof d.price === 'number') return '$' + d.price.toLocaleString();
      if (typeof d.date === 'string') return d.date;
      if (typeof d.order === 'number') return 'Order: ' + d.order;
      return '';
    }

    function renderEntries(entries) {
      grid.innerHTML = '';
      if (entries.length === 0) {
        grid.hidden = true;
        empty.hidden = false;
        return;
      }
      empty.hidden = true;
      grid.hidden = false;
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var title = entry.readError ? entry.id : getTitle(entry.data);
        var thumb = getThumb(entry.data);
        var subtitle = getSubtitle(entry.data);
        var publication = PUBLICATION_FIELD && entry.data && typeof entry.data[PUBLICATION_FIELD] === 'boolean'
          ? (entry.data[PUBLICATION_FIELD]
            ? '<span style="font-size:0.62rem;color:var(--studio-green);">' + htmlEsc(MSG['collection.published']) + '</span>'
            : '<span style="font-size:0.62rem;color:var(--studio-text-dim);">' + htmlEsc(MSG['collection.unpublished']) + '</span>')
          : '';
        var invalid = Array.isArray(entry.validationIssues) && entry.validationIssues.length
          ? '<span style="display:block;font-size:0.62rem;color:var(--studio-red);margin-bottom:0.25rem;">' + htmlEsc(MSG['collection.invalid']) + '</span>'
          : '';
        var card = document.createElement('a');
        card.href = MOUNT + '/cms/' + encodeURIComponent(COLLECTION) + '/' + encodeURIComponent(entry.id);
        card.className = 'entry-card studio-card';
        card.style.display = 'block';
        card.style.overflow = 'hidden';
        card.style.textDecoration = 'none';
        card.innerHTML =
          (thumb ? '<div class="entry-thumb"><img src="' + htmlEsc(thumb) + '" alt="' + htmlEsc(title) + '" loading="lazy" /></div>' : '') +
          '<div style="padding:1rem;">' +
            '<h2 style="font-size:0.875rem;font-weight:500;margin:0 0 0.25rem;color:var(--studio-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + htmlEsc(title) + '</h2>' +
            (subtitle ? '<p style="font-size:0.7rem;margin:0 0 0.25rem;color:var(--studio-text-dim);text-transform:capitalize;">' + htmlEsc(subtitle) + '</p>' : '') +
            (entry.readError ? '<p role="note">' + htmlEsc(MSG['collection.unreadable']) + '</p>' : invalid) +
            publication +
            '<p style="font-size:0.65rem;margin:0;color:var(--studio-text-dim);font-family:var(--studio-font-mono);">' + htmlEsc(entry.id) + '</p>' +
          '</div>';
        grid.appendChild(card);
      }
    }

    function loadEntries() {
      var version = ++requestVersion;
      pagination.hidden = true;
      if (reorderBtn) reorderBtn.disabled = true;
      loading.hidden = false;
      errorState.hidden = true;
      empty.hidden = true;
      grid.hidden = true;
      return fetch(API + '/entries?collection=' + encodeURIComponent(COLLECTION) + '&page=' + currentPage + '&q=' + encodeURIComponent(query))
        .then(function (res) {
          if (res.status === 401) {
            window.location.href = MOUNT + '?redirect=' + encodeURIComponent(window.location.pathname);
            return null;
          }
          if (!res.ok) throw new Error('failed');
          return res.json();
        })
        .then(function (json) {
          if (!json || version !== requestVersion) return;
          allEntries = Array.isArray(json.entries) ? json.entries : [];
          loading.hidden = true;
          var paging = json.pagination;
          currentPage = paging.page;
          countEl.textContent = paging.total + ' ' + (paging.total === 1 ? MSG['count.entry'] : MSG['count.entries']);
          previousPage.disabled = !paging.hasPrev;
          nextPage.disabled = !paging.hasNext;
          pageRange.textContent = MSG['collection.range'].replace('{start}', paging.total ? (paging.page - 1) * paging.pageSize + 1 : 0).replace('{end}', Math.min(paging.page * paging.pageSize, paging.total)).replace('{total}', paging.total);
          pagination.hidden = paging.total === 0;
          empty.querySelector('p').textContent = query ? MSG['collection.noResults'] : MSG['collection.noEntries'];
          if (emptyCreateBtn) emptyCreateBtn.hidden = Boolean(query);
          var limited = Boolean(query) || paging.totalPages > 1 || allEntries.some(function (entry) { return entry.readError; });
          if (reorderBtn) { reorderBtn.disabled = limited; reorderScope.hidden = !limited; }

          renderEntries(allEntries);
        })
        .catch(function () {
          if (version !== requestVersion) return;
          loading.hidden = true;
          countEl.textContent = MSG['common.error'];
          errorState.hidden = false;
        });
    }

    loadEntries();
    retryBtn.addEventListener('click', loadEntries);

    previousPage.addEventListener('click', function () { currentPage--; loadEntries(); });
    nextPage.addEventListener('click', function () { currentPage++; loadEntries(); });
    searchInput.addEventListener('input', function () {
      clearTimeout(searchTimer);
      ++requestVersion; // ignore older responses immediately, including during debounce
      if (reorderBtn) reorderBtn.disabled = true;
      previousPage.disabled = true; nextPage.disabled = true;
      searchTimer = setTimeout(function () {
        query = searchInput.value.trim(); currentPage = 1; loadEntries();
      }, 180);
    });

    /* ─── Create dialog ─────────────────────────────────────────────── */
    function openDialog() {
      dialogTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.hidden = false;
      idInput.value = '';
      errorEl.hidden = true;
      confirmBtn.disabled = true;
      idInput.focus();
    }
    function closeDialog() {
      if (dialog.hidden) return;
      dialog.hidden = true;
      var trigger = dialogTrigger;
      dialogTrigger = null;
      if (trigger && trigger.isConnected) trigger.focus();
    }
    function validate() {
      var v = idInput.value.trim();
      if (!v) { confirmBtn.disabled = true; errorEl.hidden = true; return; }
      if (!ID_RE.test(v)) { errorEl.textContent = MSG['collection.invalidId']; errorEl.hidden = false; confirmBtn.disabled = true; return; }
      if (knownDuplicateIds.has(v) || allEntries.some(function (e) { return e.id === v; })) { errorEl.textContent = MSG['collection.duplicateId']; errorEl.hidden = false; confirmBtn.disabled = true; return; }
      errorEl.hidden = true; confirmBtn.disabled = false;
    }
    function createEntry() {
      var entryId = idInput.value.trim();
      if (!entryId || !ID_RE.test(entryId)) return;
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Creating…';
      fetch(API + '/schema?collection=' + encodeURIComponent(COLLECTION))
        .then(function (res) { return res.ok ? res.json() : { template: {} }; })
        .then(function (info) {
          var template = (info && info.template) || {};
          if ('slug' in template) template.slug = entryId;
          if ('id' in template) template.id = entryId;
          return fetch(API + '/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-caret-request': '1' },
            credentials: 'same-origin',
            body: JSON.stringify({ type: 'put_entry', collection: COLLECTION, id: entryId, data: template, createOnly: true }),
          });
        })
        .then(function (res) {
          if (!res) return;
          if (res.status === 401) { window.location.href = MOUNT + '?redirect=' + encodeURIComponent(window.location.pathname); return; }
          if (res.status === 409) {
            knownDuplicateIds.add(entryId);
            errorEl.textContent = MSG['collection.duplicateId'];
            errorEl.hidden = false;
            confirmBtn.disabled = true;
            confirmBtn.textContent = MSG['collection.create'];
            idInput.focus();
            idInput.select();
            return;
          }
          if (!res.ok) throw new Error('mutate failed');
          window.location.href = MOUNT + '/cms/' + encodeURIComponent(COLLECTION) + '/' + encodeURIComponent(entryId) + '?new=1';
        })
        .catch(function () {
          errorEl.textContent = MSG['collection.createFailed'];
          errorEl.hidden = false;
          confirmBtn.disabled = false;
          confirmBtn.textContent = MSG['collection.create'];
        });
    }
    if (newBtn) newBtn.addEventListener('click', openDialog);
    if (emptyCreateBtn) emptyCreateBtn.addEventListener('click', openDialog);
    createCloseBtn.addEventListener('click', closeDialog);
    createCancelBtn.addEventListener('click', closeDialog);
    confirmBtn.addEventListener('click', createEntry);
    idInput.addEventListener('input', validate);
    idInput.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !confirmBtn.disabled) createEntry(); });
    dialog.addEventListener('click', function (e) { if (e.target === dialog) closeDialog(); });
    document.addEventListener('keydown', function (e) {
      if (!dialog.hidden) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeDialog();
          return;
        }
        if (e.key !== 'Tab') return;
        var focusable = [createCloseBtn, idInput, createCancelBtn, confirmBtn].filter(function (element) {
          return !element.disabled && !element.hidden;
        });
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      if (e.key === 'Escape' && reorderMode) {
        e.preventDefault();
        e.stopPropagation();
        exitReorder();
      }
    }, true);

    /* ─── Reorder mode ──────────────────────────────────────────────── */
    var reorderMode = false;
    var ordered = [];
    var reorderTrigger = null;
    function enterReorder() {
      if (reorderBtn.disabled) return;
      reorderTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : reorderBtn;
      pagination.hidden = true;
      reorderMode = true;
      ordered = allEntries.slice().sort(function (a, b) {
        var ao = (a.data && typeof a.data.order === 'number') ? a.data.order : 0;
        var bo = (b.data && typeof b.data.order === 'number') ? b.data.order : 0;
        return ao - bo;
      });
      grid.hidden = true; empty.hidden = true;
      searchInput.style.display = 'none'; if (newBtn) newBtn.style.display = 'none';
      reorderBtn.textContent = MSG['collection.reordering']; reorderBtn.disabled = true;
      reorderBtn.setAttribute('aria-expanded', 'true');
      reorderContainer.hidden = false;
      renderReorderList();
      var firstMove = reorderList.querySelector('button:not(:disabled)');
      (firstMove || reorderCancel).focus();
    }
    function exitReorder() {
      reorderMode = false;
      reorderContainer.hidden = true;
      searchInput.style.display = ''; if (newBtn) newBtn.style.display = '';
      reorderBtn.textContent = MSG['collection.reorder']; reorderBtn.disabled = false;
      reorderBtn.setAttribute('aria-expanded', 'false');
      var trigger = reorderTrigger;
      reorderTrigger = null;
      loadEntries().then(function () {
        if (trigger && trigger.isConnected) trigger.focus();
      });
    }
    function moveReorderEntry(index, direction) {
      var target = index + direction;
      if (target < 0 || target >= ordered.length) return;
      var moved = ordered.splice(index, 1)[0];
      if (!moved) return;
      ordered.splice(target, 0, moved);
      renderReorderList();
      var nextItem = reorderList.children[target];
      var sameDirection = nextItem && nextItem.querySelector('[data-move="' + direction + '"]');
      var oppositeDirection = nextItem && nextItem.querySelector('[data-move="' + (-direction) + '"]');
      var focusTarget = sameDirection && !sameDirection.disabled ? sameDirection : oppositeDirection;
      if (focusTarget) focusTarget.focus();
    }
    function renderReorderList() {
      reorderList.innerHTML = '';
      var dragIdx = null;
      ordered.forEach(function (entry, idx) {
        var item = document.createElement('div');
        item.className = 'reorder-item';
        item.setAttribute('role', 'listitem');
        item.draggable = true;
        item.dataset.idx = String(idx);
        var title = getTitle(entry.data);
        item.innerHTML =
          '<span class="reorder-handle" aria-hidden="true">&#9776;</span>' +
          '<span class="reorder-label">' + htmlEsc(title) + '</span>' +
          '<span class="reorder-order">' + (idx + 1) + '</span>' +
          '<span class="reorder-controls">' +
            '<button type="button" class="studio-btn-ghost reorder-move" data-move="-1" aria-label="' + htmlEsc(MSG['field.moveUp'] + ' ' + title) + '"' + (idx === 0 ? ' disabled' : '') + '>&uarr;</button>' +
            '<button type="button" class="studio-btn-ghost reorder-move" data-move="1" aria-label="' + htmlEsc(MSG['field.moveDown'] + ' ' + title) + '"' + (idx === ordered.length - 1 ? ' disabled' : '') + '>&darr;</button>' +
          '</span>';
        item.querySelectorAll('[data-move]').forEach(function (button) {
          button.addEventListener('click', function () {
            moveReorderEntry(idx, Number(button.dataset.move));
          });
        });
        item.addEventListener('dragstart', function () { dragIdx = idx; item.classList.add('dragging'); });
        item.addEventListener('dragend', function () {
          dragIdx = null; item.classList.remove('dragging');
          reorderList.querySelectorAll('.reorder-item').forEach(function (el) { el.classList.remove('drag-over'); });
        });
        item.addEventListener('dragover', function (e) { e.preventDefault(); if (dragIdx !== null && dragIdx !== idx) item.classList.add('drag-over'); });
        item.addEventListener('dragleave', function () { item.classList.remove('drag-over'); });
        item.addEventListener('drop', function (e) {
          e.preventDefault(); item.classList.remove('drag-over');
          if (dragIdx !== null && dragIdx !== idx) {
            var moved = ordered.splice(dragIdx, 1)[0];
            ordered.splice(idx, 0, moved);
            renderReorderList();
          }
        });
        reorderList.appendChild(item);
      });
    }
    function saveOrder() {
      reorderSave.disabled = true; reorderSave.textContent = MSG['common.saving'];
      var items = ordered.map(function (entry, idx) {
        return { id: entry.id, order: idx, expectedRevision: entry.revision };
      });
      var reorderReq = fetch(API + '/mutate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-caret-request': '1' },
        credentials: 'same-origin',
        body: JSON.stringify({ type: 'reorder_entries', collection: COLLECTION, items: items }),
      });
      Promise.all([reorderReq])
        .then(function (responses) {
          for (var i = 0; i < responses.length; i++) {
            if (!responses[i].ok) throw new Error('save failed');
          }
          ordered.forEach(function (entry, idx) { if (entry.data) entry.data.order = idx; });
          exitReorder();
        })
        .catch(function () { reorderSave.disabled = false; reorderSave.textContent = MSG['common.retry']; });
    }
    if (reorderBtn) reorderBtn.addEventListener('click', enterReorder);
    reorderCancel.addEventListener('click', exitReorder);
    reorderSave.addEventListener('click', saveOrder);
  })();`;

  return htmlResponse(
    renderStudioPage({
      runtime,
      title: label,
      breadcrumb: [{ label }],
      body,
      extraStyles,
      inlineScript,
    }),
  );
}
