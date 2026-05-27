import type { APIContext } from "astro";
import { isEditorAuthenticated } from "../auth/session.js";
import { getRuntimeConfig } from "../config.js";
import { getAdapter } from "./_helpers.js";
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

  const adapter = getAdapter();
  const known = await adapter.discoverCollections();
  if (!known.includes(collection)) {
    return redirectResponse(`${runtime.mountPath}/cms`);
  }

  const label = humanize(collection);

  const config = {
    apiBasePath: runtime.apiBasePath,
    mountPath: runtime.mountPath,
    collection,
    id,
  };

  const extraStyles = `@import "/__caret/admin-entry.css";
    .editor-action-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
      margin-bottom: 1.5rem;
    }
    .editor-action-bar h2 {
      font-family: var(--studio-font-heading);
      font-size: 1.25rem;
      font-weight: 500;
      margin: 0;
      color: var(--studio-text);
    }
    .editor-action-bar .meta {
      font-size: 10px;
      margin: 0.25rem 0 0;
      color: var(--studio-text-dim);
      font-family: var(--studio-font-mono);
    }
    .editor-actions {
      display: flex;
      align-items: center;
      gap: 0.75rem;
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
    .modal-card h3 { font-size: 0.875rem; font-weight: 600; margin: 0 0 0.5rem; color: var(--studio-text); }
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

    <div id="not-found" hidden style="text-align:center;padding:5rem 0;color:var(--studio-text-dim);">
      <p>Entry not found.</p>
      <a href="${escapeHtml(`${runtime.mountPath}/cms/${collection}`)}" style="margin-top:1rem;display:inline-block;font-size:0.75rem;color:var(--studio-accent);text-decoration:underline;">Go back</a>
    </div>

    <div id="editor" hidden>
      <div class="editor-action-bar">
        <div>
          <h2 id="entry-title">…</h2>
          <p class="meta">${escapeHtml(collection)} / ${escapeHtml(id)}</p>
        </div>
        <div class="editor-actions">
          <span id="status-msg" hidden style="font-size:0.75rem;"></span>
          <button id="btn-history" type="button" class="studio-btn-ghost">History</button>
          <button id="btn-delete" type="button" class="studio-btn-danger">Delete</button>
          <button id="btn-save" type="button" class="studio-save-clean" disabled style="padding:8px 18px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;border:none;border-radius:var(--radius-theme-xs);font-family:var(--studio-font);">Save</button>
        </div>
      </div>

      <div id="history-panel" class="history-panel" hidden>
        <div class="history-panel-header">
          <span class="studio-label" style="margin:0;">Version History</span>
          <button id="btn-history-close" type="button" class="studio-btn-ghost">Close</button>
        </div>
        <div id="history-list" class="history-panel-body">
          <p style="font-size:0.75rem;color:var(--studio-text-dim);margin:0;">Loading…</p>
        </div>
      </div>

      <div id="fields"></div>
    </div>
  </div>

  <div id="delete-dialog" class="modal-backdrop" hidden>
    <div class="modal-card">
      <div class="icon-wrap">
        <svg style="width:24px;height:24px;color:var(--studio-red);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
        </svg>
      </div>
      <h3>Delete Entry</h3>
      <p>Permanently delete <strong id="delete-entry-name" style="color:var(--studio-text);"></strong>? A snapshot will be saved to history for recovery.</p>
      <div style="display:flex;justify-content:center;gap:0.75rem;">
        <button id="btn-delete-cancel" type="button" class="studio-btn-ghost">Cancel</button>
        <button id="btn-delete-confirm" type="button" class="studio-btn-danger" style="background:var(--studio-red);color:white;">Delete</button>
      </div>
    </div>
  </div>

  <script type="application/json" id="caret-entry-config">${JSON.stringify(config).replace(/</g, "\\u003c")}</script>
  <script src="/__caret/admin-entry.js" defer></script>`;

  return htmlResponse(
    renderStudioPage({
      runtime,
      title: `Edit ${id}`,
      breadcrumb: [
        { label, href: `${runtime.mountPath}/cms/${encodeURIComponent(collection)}` },
        { label: id },
      ],
      body,
      extraStyles,
    }),
  );
}
