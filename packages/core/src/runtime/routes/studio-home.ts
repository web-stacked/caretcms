export const prerender = false;

import type { APIContext } from "astro";
import { isEditorAuthenticated } from "../auth/session.js";
import { getRuntimeConfig } from "../config.js";
import { resolveAdapter } from "./_helpers.js";
import {
  getStudioCollections,
} from "../schema-registry.js";
import {
  escapeHtml,
  htmlResponse,
  redirectResponse,
  renderStudioPage,
  serializeJsonForScript,
} from "../views/studio-layout.js";

function humanizeCollection(name: string): string {
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function pickIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("image") || lower.includes("gallery")) return "image";
  if (lower.includes("site") || lower.includes("setting") || lower.includes("config")) return "settings";
  if (lower.includes("team") || lower.includes("author") || lower.includes("user")) return "person";
  return "document";
}

function renderIcon(icon: string | undefined, name: string): string {
  const key = icon || pickIcon(name);
  const paths: Record<string, string> = {
    document: '<path d="M7 3.75h6.5L17 7.25v13H7z"/><path d="M13.5 3.75v3.5H17M9.5 11h5M9.5 14h5M9.5 17h3.5"/>',
    image: '<rect x="3.75" y="5" width="16.5" height="14" rx="1.5"/><circle cx="9" cy="10" r="1.5"/><path d="m5.5 17 4.25-4 3 2.5 2.25-2 3.5 3.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.55-2-3.45-2.5 1a7 7 0 0 0-1.75-1L14.25 3h-4.5l-.4 3A7 7 0 0 0 7.6 7L5.1 6l-2 3.45L5.1 11a7 7 0 0 0 0 2l-2 1.55 2 3.45 2.5-1a7 7 0 0 0 1.75 1l.4 3h4.5l.4-3a7 7 0 0 0 1.75-1l2.5 1 2-3.45-2-1.55a7 7 0 0 0 .1-1Z"/>',
    person: '<circle cx="12" cy="8" r="3.25"/><path d="M5.5 20c.6-4 2.75-6 6.5-6s5.9 2 6.5 6"/>',
    collection: '<path d="M3.5 7.5h6l1.5 2h9.5v10h-17z"/><path d="M3.5 7.5v-3h6l1.5 2h7v3"/>',
  };
  if (!paths[key]) return `<span aria-hidden="true">${escapeHtml(key)}</span>`;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[key]}</svg>`;
}

export async function GET(context: APIContext): Promise<Response> {
  const runtime = getRuntimeConfig();
  const loginRedirect = `${runtime.mountPath}?redirect=${encodeURIComponent(`${runtime.mountPath}/cms`)}`;

  if (!isEditorAuthenticated(context)) {
    return redirectResponse(loginRedirect);
  }

  const adapter = await resolveAdapter();
  const configuredCollections = await getStudioCollections(adapter);

  const cards = configuredCollections
    .map(({ name, config }) => {
      const label = config.label || humanizeCollection(name);
      const icon = renderIcon(config.icon, name);
      const href = config.singletonId
        ? `${runtime.mountPath}/cms/${encodeURIComponent(name)}/${encodeURIComponent(config.singletonId)}`
        : `${runtime.mountPath}/cms/${encodeURIComponent(name)}`;
      return `<a href="${escapeHtml(href)}" class="studio-card-interactive" data-collection="${escapeHtml(name)}">
        <div class="studio-collection-icon">${icon}</div>
        <h2 style="font-size:0.875rem;font-weight:600;margin:0 0 0.25rem;color:var(--studio-text);">${escapeHtml(label)}</h2>
        ${config.description ? `<p class="studio-collection-description">${escapeHtml(config.description)}</p>` : ""}
        ${config.singletonId ? "" : `<span class="studio-count-label" data-collection="${escapeHtml(name)}">…</span>`}
      </a>`;
    })
    .join("");

  // Adapter-agnostic copy: where entries live depends on the configured
  // storage (.caret/data for the filesystem adapter, src/content for markdown,
  // KV for Cloudflare) — naming one path here misleads every other setup.
  const emptyState = `<div class="studio-card" style="padding:2rem;text-align:center;color:var(--studio-text-dim);font-size:0.85rem;">${escapeHtml(runtime.messages["home.empty"])}</div>`;

  const body = `<div class="studio-fade-in studio-home">
    <h1 class="studio-home-title">${escapeHtml(runtime.messages["home.title"])}</h1>
    <p class="studio-page-intro">${escapeHtml(runtime.messages["home.intro"])}</p>

    ${
      configuredCollections.length === 0
        ? emptyState
        : `<div class="studio-home-grid">${cards}</div>`
    }
  </div>`;

  const extraStyles = `
    .studio-home-title {
      margin: 0 0 0.4rem; color: var(--studio-text); font-size: clamp(1.35rem, 3vw, 1.8rem); font-weight: 650;
      letter-spacing: -0.025em;
    }
    .studio-card-interactive { min-height: 9.5rem; display: flex; flex-direction: column; }
    .studio-collection-icon {
      width: 2rem; height: 2rem; margin-bottom: 1rem; color: var(--studio-accent);
      display: grid; place-items: center;
    }
    .studio-collection-icon svg { width: 1.5rem; height: 1.5rem; }
    .studio-collection-description {
      margin: 0.15rem 0 0.65rem; color: var(--studio-text-dim); font-size: 0.78rem; line-height: 1.45;
    }
    .studio-count-label {
      margin-top: auto; color: var(--studio-text-muted); font-size: 0.75rem; font-weight: 500;
    }
  `;

  const inlineScript = `(function(){
    var apiBase = ${serializeJsonForScript(runtime.apiBasePath)};
    var messages = ${serializeJsonForScript(runtime.messages)};
    var labels = document.querySelectorAll('.studio-count-label');
    labels.forEach(function (el) {
      var collection = el.getAttribute('data-collection');
      if (!collection) return;
      fetch(apiBase + '/entries?collection=' + encodeURIComponent(collection))
        .then(function (res) {
          if (res.status === 401) {
            window.location.href = ${serializeJsonForScript(runtime.mountPath)} + '?redirect=' + encodeURIComponent(window.location.pathname);
            return null;
          }
          if (!res.ok) throw new Error('failed');
          return res.json();
        })
        .then(function (data) {
          if (!data) return;
          var entries = Array.isArray(data.entries) ? data.entries : [];
          var pagination = data && typeof data.pagination === 'object' ? data.pagination : null;
          var total = pagination && pagination.total;
          var n = Number.isSafeInteger(total) && total >= 0 ? total : entries.length;
          el.textContent = n + ' ' + (n === 1 ? messages['count.entry'] : messages['count.entries']);
        })
        .catch(function () {
          el.textContent = messages['common.error'];
          el.style.color = 'var(--studio-red)';
        });
    });
  })();`;

  return htmlResponse(
    renderStudioPage({
      runtime,
      title: runtime.messages["home.title"],
      breadcrumb: [],
      body,
      inlineScript,
      extraStyles,
    }),
  );
}
