export const prerender = false;

import type { APIContext } from "astro";
import { isEditorAuthenticated } from "../auth/session.js";
import { getRuntimeConfig } from "../config.js";
import { resolveAdapter } from "./_helpers.js";
import {
  escapeHtml,
  htmlResponse,
  redirectResponse,
  renderStudioPage,
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
  const known = await adapter.discoverCollections();
  if (!known.includes(collection)) {
    return redirectResponse(`${runtime.mountPath}/cms`);
  }

  const label = humanize(collection);
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
        <h2 style="font-family:var(--studio-font-heading);font-size:1.25rem;margin:0;color:var(--studio-text);">${escapeHtml(label)}</h2>
        <p id="entry-count" style="font-size:0.7rem;margin:0.25rem 0 0;color:var(--studio-text-dim);">Loading…</p>
      </div>
      <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;">
        <input id="search-input" type="text" placeholder="Search…" class="studio-input" style="max-width:240px;" />
        <button id="btn-reorder" class="studio-btn-ghost">Reorder</button>
        <button id="btn-new" class="studio-btn-primary">+ New</button>
      </div>
    </div>

    <div id="loading" style="display:flex;justify-content:center;padding:5rem 0;">
      <div class="studio-spinner" style="width:24px;height:24px;"></div>
    </div>

    <div id="empty" hidden style="text-align:center;padding:5rem 0;color:var(--studio-text-dim);">
      <p style="font-size:0.875rem;margin:0 0 0.75rem;">No entries yet.</p>
      <button id="btn-empty-create" class="studio-btn-primary">Create First Entry</button>
    </div>

    <div id="error-state" hidden style="text-align:center;padding:5rem 0;">
      <p style="font-size:0.875rem;margin:0 0 0.75rem;color:var(--studio-red);">Failed to load entries.</p>
      <button id="retry-btn" class="studio-btn-ghost">Retry</button>
    </div>

    <div id="entries-grid" hidden style="display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));"></div>

    <div id="reorder-container" hidden>
      <div id="reorder-list" style="display:flex;flex-direction:column;gap:0.25rem;"></div>
      <div style="display:flex;justify-content:flex-end;gap:0.75rem;margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--studio-border);">
        <button id="btn-reorder-cancel" class="studio-btn-ghost">Cancel</button>
        <button id="btn-reorder-save" class="studio-btn-primary">Save Order</button>
      </div>
    </div>
  </div>

  <div id="create-dialog" class="modal-backdrop" hidden>
    <div class="modal-card">
      <div class="modal-header">
        <span>New Entry</span>
        <button id="btn-create-close" class="studio-btn-ghost" style="padding:4px 10px;">Close</button>
      </div>
      <div class="modal-body">
        <label for="create-id-input" class="studio-label">Entry ID (slug)</label>
        <input id="create-id-input" type="text" class="studio-input" placeholder="e.g. my-first-entry" autocomplete="off" spellcheck="false" />
        <p id="create-hint" style="font-size:10px;margin:0.5rem 0 1rem;color:var(--studio-text-dim);">Lowercase letters, numbers, and hyphens only.</p>
        <p id="create-error" class="studio-error-text" hidden></p>
        <div style="display:flex;justify-content:flex-end;gap:0.75rem;">
          <button id="btn-create-cancel" class="studio-btn-ghost">Cancel</button>
          <button id="btn-create-confirm" class="studio-btn-primary" disabled>Create</button>
        </div>
      </div>
    </div>
  </div>`;

  const inlineScript = `(function () {
    var COLLECTION = ${JSON.stringify(collection)};
    var API = ${JSON.stringify(runtime.apiBasePath)};
    var MOUNT = ${JSON.stringify(runtime.mountPath)};
    var ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    var allEntries = [];

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

    function htmlEsc(s) { return String(s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; });
    }

    function getTitle(d) {
      if (!d) return 'Untitled';
      for (var i = 0; i < ['name','title','question','company_name','headline','label'].length; i++) {
        var k = ['name','title','question','company_name','headline','label'][i];
        if (typeof d[k] === 'string' && d[k]) return d[k];
      }
      return 'Untitled';
    }
    function getThumb(d) {
      if (!d) return null;
      if (Array.isArray(d.images) && typeof d.images[0] === 'string') return d.images[0];
      if (typeof d.image === 'string' && d.image) return d.image;
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
        var title = getTitle(entry.data);
        var thumb = getThumb(entry.data);
        var subtitle = getSubtitle(entry.data);
        var card = document.createElement('a');
        card.href = MOUNT + '/cms/' + encodeURIComponent(COLLECTION) + '/' + encodeURIComponent(entry.id);
        card.className = 'entry-card studio-card';
        card.style.display = 'block';
        card.style.overflow = 'hidden';
        card.style.textDecoration = 'none';
        card.innerHTML =
          (thumb ? '<div class="entry-thumb"><img src="' + htmlEsc(thumb) + '" alt="' + htmlEsc(title) + '" loading="lazy" /></div>' : '') +
          '<div style="padding:1rem;">' +
            '<h3 style="font-size:0.875rem;font-weight:500;margin:0 0 0.25rem;color:var(--studio-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + htmlEsc(title) + '</h3>' +
            (subtitle ? '<p style="font-size:0.7rem;margin:0 0 0.25rem;color:var(--studio-text-dim);text-transform:capitalize;">' + htmlEsc(subtitle) + '</p>' : '') +
            '<p style="font-size:0.65rem;margin:0;color:var(--studio-text-dim);font-family:var(--studio-font-mono);">' + htmlEsc(entry.id) + '</p>' +
          '</div>';
        grid.appendChild(card);
      }
    }

    function loadEntries() {
      loading.hidden = false;
      errorState.hidden = true;
      empty.hidden = true;
      grid.hidden = true;
      fetch(API + '/entries?collection=' + encodeURIComponent(COLLECTION))
        .then(function (res) {
          if (res.status === 401) {
            window.location.href = MOUNT + '?redirect=' + encodeURIComponent(window.location.pathname);
            return null;
          }
          if (!res.ok) throw new Error('failed');
          return res.json();
        })
        .then(function (json) {
          if (!json) return;
          allEntries = Array.isArray(json.entries) ? json.entries : [];
          loading.hidden = true;
          countEl.textContent = allEntries.length + ' ' + (allEntries.length === 1 ? 'entry' : 'entries');
          renderEntries(allEntries);
        })
        .catch(function () {
          loading.hidden = true;
          countEl.textContent = 'Error';
          errorState.hidden = false;
        });
    }

    loadEntries();
    retryBtn.addEventListener('click', loadEntries);

    searchInput.addEventListener('input', function () {
      var q = searchInput.value.toLowerCase();
      if (!q) { renderEntries(allEntries); return; }
      var filtered = allEntries.filter(function (e) {
        var t = getTitle(e.data).toLowerCase();
        return t.indexOf(q) >= 0 || e.id.toLowerCase().indexOf(q) >= 0;
      });
      renderEntries(filtered);
    });

    /* ─── Create dialog ─────────────────────────────────────────────── */
    function openDialog() {
      dialog.hidden = false;
      idInput.value = '';
      errorEl.hidden = true;
      confirmBtn.disabled = true;
      idInput.focus();
    }
    function closeDialog() { dialog.hidden = true; }
    function validate() {
      var v = idInput.value.trim();
      if (!v) { confirmBtn.disabled = true; errorEl.hidden = true; return; }
      if (!ID_RE.test(v)) { errorEl.textContent = 'Use lowercase letters, numbers, and hyphens only.'; errorEl.hidden = false; confirmBtn.disabled = true; return; }
      if (allEntries.some(function (e) { return e.id === v; })) { errorEl.textContent = 'An entry with this ID already exists.'; errorEl.hidden = false; confirmBtn.disabled = true; return; }
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
            body: JSON.stringify({ type: 'put_entry', collection: COLLECTION, id: entryId, data: template }),
          });
        })
        .then(function (res) {
          if (!res) return;
          if (res.status === 401) { window.location.href = MOUNT + '?redirect=' + encodeURIComponent(window.location.pathname); return; }
          if (!res.ok) throw new Error('mutate failed');
          window.location.href = MOUNT + '/cms/' + encodeURIComponent(COLLECTION) + '/' + encodeURIComponent(entryId);
        })
        .catch(function () {
          errorEl.textContent = 'Failed to create entry. Try again.';
          errorEl.hidden = false;
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Create';
        });
    }
    newBtn.addEventListener('click', openDialog);
    emptyCreateBtn.addEventListener('click', openDialog);
    document.getElementById('btn-create-close').addEventListener('click', closeDialog);
    document.getElementById('btn-create-cancel').addEventListener('click', closeDialog);
    confirmBtn.addEventListener('click', createEntry);
    idInput.addEventListener('input', validate);
    idInput.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !confirmBtn.disabled) createEntry(); });
    dialog.addEventListener('click', function (e) { if (e.target === dialog) closeDialog(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !dialog.hidden) closeDialog(); });

    /* ─── Reorder mode ──────────────────────────────────────────────── */
    var reorderMode = false;
    var ordered = [];
    function enterReorder() {
      reorderMode = true;
      ordered = allEntries.slice().sort(function (a, b) {
        var ao = (a.data && typeof a.data.order === 'number') ? a.data.order : 0;
        var bo = (b.data && typeof b.data.order === 'number') ? b.data.order : 0;
        return ao - bo;
      });
      grid.hidden = true; empty.hidden = true;
      searchInput.style.display = 'none'; newBtn.style.display = 'none';
      reorderBtn.textContent = 'Reordering…'; reorderBtn.disabled = true;
      reorderContainer.hidden = false;
      renderReorderList();
    }
    function exitReorder() {
      reorderMode = false;
      reorderContainer.hidden = true;
      searchInput.style.display = ''; newBtn.style.display = '';
      reorderBtn.textContent = 'Reorder'; reorderBtn.disabled = false;
      renderEntries(allEntries);
    }
    function renderReorderList() {
      reorderList.innerHTML = '';
      var dragIdx = null;
      ordered.forEach(function (entry, idx) {
        var item = document.createElement('div');
        item.className = 'reorder-item';
        item.draggable = true;
        item.dataset.idx = String(idx);
        item.innerHTML =
          '<span class="reorder-handle">&#9776;</span>' +
          '<span class="reorder-label">' + htmlEsc(getTitle(entry.data)) + '</span>' +
          '<span class="reorder-order">' + (idx + 1) + '</span>';
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
      reorderSave.disabled = true; reorderSave.textContent = 'Saving…';
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
        .catch(function () { reorderSave.disabled = false; reorderSave.textContent = 'Retry'; });
    }
    reorderBtn.addEventListener('click', enterReorder);
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
