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

function humanizeCollection(name: string): string {
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function pickIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("page")) return "📄";
  if (lower.includes("post") || lower.includes("blog")) return "✍️";
  if (lower.includes("product")) return "💎";
  if (lower.includes("testimonial") || lower.includes("review")) return "⭐";
  if (lower.includes("faq") || lower.includes("question")) return "❓";
  if (lower.includes("site") || lower.includes("setting") || lower.includes("config")) return "⚙️";
  if (lower.includes("team") || lower.includes("author") || lower.includes("user")) return "👤";
  if (lower.includes("event")) return "📅";
  return "📁";
}

export async function GET(context: APIContext): Promise<Response> {
  const runtime = getRuntimeConfig();
  const loginRedirect = `${runtime.mountPath}?redirect=${encodeURIComponent(`${runtime.mountPath}/cms`)}`;

  if (!isEditorAuthenticated(context)) {
    return redirectResponse(loginRedirect);
  }

  const adapter = getAdapter();
  const collections = await adapter.discoverCollections();

  const cards = collections
    .map((name) => {
      const label = humanizeCollection(name);
      const icon = pickIcon(name);
      const href = `${runtime.mountPath}/cms/${encodeURIComponent(name)}`;
      return `<a href="${escapeHtml(href)}" class="studio-card-interactive" data-collection="${escapeHtml(name)}">
        <div style="font-size:1.5rem;margin-bottom:0.75rem;">${icon}</div>
        <h3 style="font-size:0.875rem;font-weight:600;margin:0 0 0.25rem;color:var(--studio-text);">${escapeHtml(label)}</h3>
        <p style="font-size:0.7rem;margin:0 0 0.5rem;color:var(--studio-text-dim);font-family:var(--studio-font-mono);">${escapeHtml(name)}</p>
        <span class="studio-count-label" data-collection="${escapeHtml(name)}" style="font-size:0.7rem;color:var(--studio-accent);font-weight:500;">…</span>
      </a>`;
    })
    .join("");

  // Adapter-agnostic copy: where entries live depends on the configured
  // storage (.caret/data for the filesystem adapter, src/content for markdown,
  // KV for Cloudflare) — naming one path here misleads every other setup.
  const emptyState = `<div class="studio-card" style="padding:2rem;text-align:center;color:var(--studio-text-dim);font-size:0.85rem;">
    No collections yet. Create one from Studio, edit any <code style="font-family:var(--studio-font-mono);">data-caret</code> element on your site, or run <code style="font-family:var(--studio-font-mono);">npx @caretcms/caretize</code> to make existing pages editable.
  </div>`;

  const body = `<div class="studio-fade-in" style="max-width:64rem;margin:0 auto;">
    <div style="text-align:center;margin-bottom:2.5rem;">
      <h1 style="font-family:var(--studio-font-heading);font-size:1.875rem;font-weight:500;margin:0 0 0.5rem;color:var(--studio-text);">Content Studio</h1>
      <p style="font-size:0.85rem;color:var(--studio-text-dim);margin:0;">Manage your collections and entries.</p>
    </div>

    ${
      collections.length === 0
        ? emptyState
        : `<div style="display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));">${cards}</div>`
    }
  </div>`;

  const inlineScript = `(function(){
    var apiBase = ${JSON.stringify(runtime.apiBasePath)};
    var labels = document.querySelectorAll('.studio-count-label');
    labels.forEach(function (el) {
      var collection = el.getAttribute('data-collection');
      if (!collection) return;
      fetch(apiBase + '/entries?collection=' + encodeURIComponent(collection))
        .then(function (res) {
          if (res.status === 401) {
            window.location.href = ${JSON.stringify(runtime.mountPath)} + '?redirect=' + encodeURIComponent(window.location.pathname);
            return null;
          }
          if (!res.ok) throw new Error('failed');
          return res.json();
        })
        .then(function (data) {
          if (!data) return;
          var entries = Array.isArray(data.entries) ? data.entries : [];
          var n = entries.length;
          el.textContent = n + ' ' + (n === 1 ? 'entry' : 'entries');
        })
        .catch(function () {
          el.textContent = 'error';
          el.style.color = 'var(--studio-red)';
        });
    });
  })();`;

  return htmlResponse(
    renderStudioPage({
      runtime,
      title: "Content Studio",
      breadcrumb: [],
      body,
      inlineScript,
    }),
  );
}
