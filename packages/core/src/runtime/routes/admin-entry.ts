import { canPerform } from "../authorization.js";
export const prerender = false;

import type { APIContext } from "astro";
import { isEditorAuthenticated } from "../auth/session.js";
import { getRuntimeConfig } from "../config.js";
import { resolveAdapter } from "./_helpers.js";
import {
  getStudioCollections,
  isKnownStudioCollection,
  resolveCollectionStudioConfig,
} from "../schema-registry.js";
import { getRequestContext } from "../request-context.js";
import { publicationField, resolvePreviewPath } from "../collection-policy.js";
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
  const id = (context.params.id ?? "").toString();
  const loginRedirect = `${runtime.mountPath}?redirect=${encodeURIComponent(context.url.pathname)}`;

  if (!isEditorAuthenticated(context)) {
    return redirectResponse(loginRedirect);
  }

  if (!collection || !id) {
    return redirectResponse(`${runtime.mountPath}/cms`);
  }

  const adapter = await resolveAdapter();
  if (!(await isKnownStudioCollection(adapter, collection))) {
    return redirectResponse(`${runtime.mountPath}/cms`);
  }

  const collectionConfig = await resolveCollectionStudioConfig(adapter, collection);
  if (collectionConfig.singletonId && id !== collectionConfig.singletonId) {
    return redirectResponse(
      `${runtime.mountPath}/cms/${encodeURIComponent(collection)}/${encodeURIComponent(collectionConfig.singletonId)}`,
    );
  }
  const label = collectionConfig.label || humanize(collection);
  const studioCollections = await getStudioCollections(adapter);
  const collectionSwitcher = studioCollections.map(({ name, config }) => ({
    label: config.label || humanize(name),
    href: config.singletonId
      ? `${runtime.mountPath}/cms/${encodeURIComponent(name)}/${encodeURIComponent(config.singletonId)}`
      : `${runtime.mountPath}/cms/${encodeURIComponent(name)}`,
    selected: name === collection,
  }));
  const editable = await canPerform("edit", collection, id);
  const deletable = editable && collectionConfig.deletable !== false && !collectionConfig.singletonId && await canPerform("delete", collection, id);
  const canRestore = editable && await canPerform("publish", collection, id);
  const savingToPreview = getRequestContext()?.overlayActive === true;
  const previewPath = resolvePreviewPath(collectionConfig, id);
  const publicationFieldName = publicationField(collectionConfig);
  const messages = runtime.messages;
  const isNew = context.url.searchParams.get("new") === "1";

  const config = {
    apiBasePath: runtime.apiBasePath,
    mountPath: runtime.mountPath,
    collection,
    id,
    isNew,
    initializeIfMissing: collectionConfig.singletonId === id,
    deletable,
    editable,
    saveTarget: savingToPreview ? "preview" : "live",
    previewPath,
    titleField: collectionConfig.titleField ?? null,
    fallbackTitle: collectionConfig.singletonId ? label : null,
    publicationField: publicationFieldName,
    messages,
  };

  const extraStyles = `@import "/__caret/admin-entry.css?v=studio-ux-20260913";
    .editor-action-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      position: sticky;
      top: 0;
      z-index: 8;
      padding: 0.75rem 0;
      margin: -0.75rem 0 0.75rem;
      border-bottom: 1px solid var(--studio-border);
      background: var(--studio-bg);
      background: color-mix(in srgb, var(--studio-bg) 92%, transparent);
      backdrop-filter: blur(14px);
    }
    .editor-heading { min-width: 0; }
    .editor-action-bar h1 {
      font-family: var(--studio-font-heading);
      font-size: 1.125rem;
      font-weight: 600;
      margin: 0;
      color: var(--studio-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #status-msg {
      display: inline-block;
      min-height: 1.25rem;
      margin-top: 0.2rem;
      font-size: 0.78rem;
    }
    .entry-visibility {
      display: inline-flex;
      align-items: center;
      margin-left: 0.5rem;
      padding-left: 0.65rem;
      border-left: 1px solid var(--studio-border);
      color: var(--studio-text-muted);
      font-size: 0.72rem;
    }
    .entry-visibility[data-visible="true"] { color: var(--studio-green); }
    .editor-context {
      display: grid;
      gap: 0.25rem;
      padding: 0.25rem 0.5rem 0.65rem;
      border-bottom: 1px solid var(--studio-border);
      margin-bottom: 0.35rem;
      font-size: 0.75rem;
      color: var(--studio-text-dim);
    }
    .editor-context .meta {
      margin: 0;
      font-family: var(--studio-font-mono);
      overflow-wrap: anywhere;
    }
    .editor-actions {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      justify-content: flex-end;
      flex-shrink: 0;
    }
    #btn-save {
      min-width: 6.75rem;
      min-height: 2.375rem;
      padding: 0.5rem 1rem;
      border: none;
      border-radius: var(--radius-theme-sm);
      font-family: var(--studio-font);
      font-size: 0.8rem;
      font-weight: 600;
    }
    #btn-save.studio-save-dirty {
      box-shadow: 0 8px 24px var(--studio-accent-soft);
    }
    .editor-more { position: relative; }
    .editor-more > summary {
      list-style: none;
      white-space: nowrap;
    }
    .editor-more > summary::-webkit-details-marker { display: none; }
    .editor-more[open] > summary {
      color: var(--studio-text);
      border-color: var(--studio-border-hover);
      background: var(--color-theme-surface-muted);
    }
    .editor-more-menu {
      position: absolute;
      top: calc(100% + 0.5rem);
      right: 0;
      display: grid;
      gap: 0.25rem;
      width: min(17rem, calc(100vw - 2rem));
      padding: 0.5rem;
      border: 1px solid var(--studio-border-hover);
      border-radius: var(--radius-theme-sm);
      background: var(--studio-surface);
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.35);
    }
    .editor-more-menu > a,
    .editor-more-menu > button {
      width: 100%;
      text-align: left;
    }
    .editor-help {
      margin-bottom: 0.75rem;
      color: var(--studio-text-muted);
      font-size: 0.8rem;
    }
    .editor-help summary {
      width: fit-content;
      padding: 0.35rem 0;
      color: var(--studio-text-muted);
      cursor: pointer;
      font-weight: 500;
    }
    .editor-help p {
      max-width: 42rem;
      margin: 0.35rem 0 0.75rem;
      padding-left: 1rem;
      border-left: 2px solid var(--studio-border-hover);
      color: var(--studio-text-muted);
      line-height: 1.6;
    }
    @media (max-width: 640px) {
      .editor-action-bar {
        flex-wrap: wrap;
        padding: 0.625rem 0;
      }
      .editor-heading { flex-basis: 100%; }
      .editor-action-bar h1 {
        display: -webkit-box;
        font-size: 1rem;
        white-space: normal;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
      }
      .editor-actions { width: 100%; }
      .editor-more-menu {
        right: auto;
        left: 0;
      }
      #btn-save {
        min-width: auto;
        margin-left: auto;
        padding-inline: 0.75rem;
      }
    }
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
      max-width: 24rem;
      background: var(--studio-bg);
      border: 1px solid var(--studio-border);
      padding: 1.5rem;
      text-align: center;
    }
    .modal-card .icon-wrap {
      width: 48px;
      height: 48px;
      margin: 0 auto 1rem;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(239, 68, 68, 0.12);
      border-radius: 50%;
    }
    .modal-card h2 { font-size: 0.875rem; font-weight: 600; margin: 0 0 0.5rem; color: var(--studio-text); }
    .modal-card p { font-size: 0.75rem; color: var(--studio-text-muted); margin: 0 0 1.5rem; }
    .history-panel {
      margin-bottom: 1.5rem;
      border: 1px solid var(--studio-border);
      background: var(--studio-surface);
    }
    .history-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--studio-border);
    }
    .history-panel-body { padding: 1rem; }
  `;

  const body = `<div class="studio-fade-in" style="max-width:48rem;margin:0 auto;" id="cms-entry-page" data-collection="${escapeHtml(collection)}" data-id="${escapeHtml(id)}">
    <div id="loading" style="display:flex;justify-content:center;padding:5rem 0;">
      <div class="studio-spinner" style="width:24px;height:24px;"></div>
    </div>

    <div id="load-error" hidden role="alert" style="text-align:center;padding:5rem 0;">
      <p id="load-error-message">${escapeHtml(messages["entry.loadFailed"])}</p>
      <button id="load-error-retry" type="button" class="studio-btn-ghost">${escapeHtml(messages["common.retry"])}</button>
    </div>

    <div id="not-found" hidden style="text-align:center;padding:5rem 0;color:var(--studio-text-dim);">
      <p>${escapeHtml(messages["entry.notFound"])}</p>
      <a href="${escapeHtml(`${runtime.mountPath}/cms/${collection}`)}" style="margin-top:1rem;display:inline-block;font-size:0.75rem;color:var(--studio-accent);text-decoration:underline;">${escapeHtml(messages["entry.goBack"])}</a>
    </div>

    <div id="editor" hidden>
      <div class="editor-action-bar">
        <div class="editor-heading">
          <h1 id="entry-title">…</h1>
          <span id="status-msg" hidden></span>
          ${publicationFieldName ? `<span id="visibility-status" class="entry-visibility" aria-live="polite"></span>` : ""}
        </div>
        <div class="editor-actions">
          <details id="entry-more" class="editor-more">
            <summary class="studio-btn-ghost">${escapeHtml(messages["common.more"])}</summary>
            <div class="editor-more-menu">
              <div class="editor-context">
                <p class="meta">${escapeHtml(collection)} / ${escapeHtml(id)}</p>
                <span id="save-target">${escapeHtml(savingToPreview ? messages["entry.savingPreview"] : messages["entry.savingLive"])}</span>
              </div>
              ${previewPath ? `<a id="btn-preview" class="studio-btn-ghost" href="${escapeHtml(previewPath)}" target="_blank" rel="noopener">${escapeHtml(messages["entry.preview"])}</a>` : ""}
              <button id="btn-history" ${canRestore ? "" : "hidden"} type="button" class="studio-btn-ghost" aria-controls="history-panel" aria-expanded="false">${escapeHtml(messages["entry.history"])}</button>
              ${deletable ? `<button id="btn-delete" type="button" class="studio-btn-danger">${escapeHtml(messages["entry.delete"])}</button>` : ""}
            </div>
          </details>
          <button id="btn-save" ${editable ? "" : "hidden"} type="button" class="studio-save-clean" disabled>${escapeHtml(savingToPreview ? messages["entry.saveDraft"] : messages["entry.saveLive"])}</button>
        </div>
      </div>

      <details class="editor-help" id="editor-guide"${isNew ? " open" : ""}>
        <summary id="editor-guide-title">${escapeHtml(messages["entry.guideTitle"])}</summary>
        <p id="editor-guide-copy">${escapeHtml(messages["entry.guideCopy"])}</p>
      </details>

      <div id="validation-warning" role="alert" hidden style="margin-bottom:1.5rem;padding:1rem;border:1px solid var(--studio-red);background:rgba(239,68,68,0.08);color:var(--studio-text);font-size:0.75rem;"></div>

      <div id="history-panel" class="history-panel" role="region" aria-labelledby="history-panel-title" hidden>
        <div class="history-panel-header">
          <span id="history-panel-title" class="studio-label" style="margin:0;">${escapeHtml(messages["entry.versionHistory"])}</span>
          <button id="btn-history-close" type="button" class="studio-btn-ghost">${escapeHtml(messages["common.close"])}</button>
        </div>
        <div id="history-list" class="history-panel-body">
          <p style="font-size:0.75rem;color:var(--studio-text-dim);margin:0;">Loading…</p>
        </div>
      </div>

      <div id="fields"></div>
    </div>
  </div>

  <div id="delete-dialog" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title" aria-describedby="delete-dialog-copy" hidden>
    <div class="modal-card">
      <div class="icon-wrap">
        <svg style="width:24px;height:24px;color:var(--studio-red);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
        </svg>
      </div>
      <h2 id="delete-dialog-title">${escapeHtml(messages["entry.deleteTitle"])}</h2>
      <p id="delete-dialog-copy">${escapeHtml(messages["entry.deleteCopy"])} <strong id="delete-entry-name" style="color:var(--studio-text);"></strong></p>
      <div style="display:flex;justify-content:center;gap:0.75rem;">
        <button id="btn-delete-cancel" type="button" class="studio-btn-ghost">${escapeHtml(messages["common.cancel"])}</button>
        <button id="btn-delete-confirm" type="button" class="studio-btn-danger studio-btn-danger-confirm">${escapeHtml(messages["entry.delete"])}</button>
      </div>
    </div>
  </div>

  <div id="confirm-dialog" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-copy" hidden>
    <div class="modal-card">
      <h2 id="confirm-dialog-title"></h2>
      <p id="confirm-dialog-copy"></p>
      <div style="display:flex;justify-content:flex-end;gap:0.75rem;">
        <button id="btn-confirm-cancel" type="button" class="studio-btn-ghost">${escapeHtml(messages["common.cancel"])}</button>
        <button id="btn-confirm-action" type="button" class="studio-btn-primary"></button>
      </div>
    </div>
  </div>

  <div id="conflict-dialog" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="conflict-dialog-title" aria-describedby="conflict-dialog-copy" hidden>
    <div class="modal-card">
      <h2 id="conflict-dialog-title">${escapeHtml(messages["entry.conflictTitle"])}</h2>
      <p id="conflict-dialog-copy">${escapeHtml(messages["entry.conflictCopy"])}</p>
      <ul id="conflict-fields" class="conflict-fields"></ul>
      <div style="display:flex;justify-content:flex-end;gap:0.75rem;flex-wrap:wrap;">
        <button id="btn-conflict-cancel" type="button" class="studio-btn-ghost">${escapeHtml(messages["common.cancel"])}</button>
        <button id="btn-conflict-latest" type="button" class="studio-btn-ghost">${escapeHtml(messages["entry.loadLatest"])}</button>
        <button id="btn-conflict-keep" type="button" class="studio-btn-primary">${escapeHtml(messages["entry.keepMine"])}</button>
      </div>
    </div>
  </div>

  <script type="application/json" id="caret-entry-config">${JSON.stringify(config).replace(/</g, "\\u003c")}</script>
  <script type="module" src="/__caret/admin-entry.js?v=studio-ux-20260913"></script>`;

  return htmlResponse(
    renderStudioPage({
      runtime,
      title: `Edit ${id}`,
      breadcrumb: [
        { label: messages["nav.entries"], href: `${runtime.mountPath}/cms/${encodeURIComponent(collection)}` },
        { label: id },
      ],
      collectionSwitcher,
      body,
      extraStyles,
    }),
  );
}
