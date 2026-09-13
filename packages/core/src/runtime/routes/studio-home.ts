export const prerender = false;

import type { APIContext } from "astro";
import { isEditorAuthenticated } from "../auth/session.js";
import { getRuntimeConfig } from "../config.js";
import { resolveAdapter } from "./_helpers.js";
import {
  getStudioCollectionNames,
  resolveCollectionStudioConfig,
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

function configuredIcon(icon: string | undefined, name: string): string {
  const known: Record<string, string> = {
    document: "📄",
    image: "🖼️",
    settings: "⚙️",
    person: "👤",
    collection: "📁",
  };
  return icon ? (known[icon] ?? icon) : pickIcon(name);
}

export async function GET(context: APIContext): Promise<Response> {
  const runtime = getRuntimeConfig();
  const loginRedirect = `${runtime.mountPath}?redirect=${encodeURIComponent(`${runtime.mountPath}/cms`)}`;

  if (!isEditorAuthenticated(context)) {
    return redirectResponse(loginRedirect);
  }

  const adapter = await resolveAdapter();
  const collections = await getStudioCollectionNames(adapter);

  const configuredCollections = await Promise.all(collections.map(async (name) => ({
    name,
    config: await resolveCollectionStudioConfig(adapter, name),
  })));
  configuredCollections.sort((a, b) =>
    (a.config.order ?? 0) - (b.config.order ?? 0)
    || (a.config.label ?? a.name).localeCompare(b.config.label ?? b.name),
  );

  const cards = configuredCollections
    .map(({ name, config }) => {
      const label = config.label || humanizeCollection(name);
      const icon = configuredIcon(config.icon, name);
      const href = config.singletonId
        ? `${runtime.mountPath}/cms/${encodeURIComponent(name)}/${encodeURIComponent(config.singletonId)}`
        : `${runtime.mountPath}/cms/${encodeURIComponent(name)}`;
      return `<a href="${escapeHtml(href)}" class="studio-card-interactive" data-collection="${escapeHtml(name)}">
        <div style="font-size:1.5rem;margin-bottom:0.75rem;">${escapeHtml(icon)}</div>
        <h2 style="font-size:0.875rem;font-weight:600;margin:0 0 0.25rem;color:var(--studio-text);">${escapeHtml(label)}</h2>
        <p style="font-size:0.7rem;margin:0 0 0.5rem;color:var(--studio-text-dim);">${escapeHtml(config.description || name)}</p>
        <span class="studio-count-label" data-collection="${escapeHtml(name)}" style="font-size:0.7rem;color:var(--studio-accent);font-weight:500;">…</span>
      </a>`;
    })
    .join("");

  // Adapter-agnostic copy: where entries live depends on the configured
  // storage (.caret/data for the filesystem adapter, src/content for markdown,
  // KV for Cloudflare) — naming one path here misleads every other setup.
  const emptyState = `<div class="studio-card" style="padding:2rem;text-align:center;color:var(--studio-text-dim);font-size:0.85rem;">${escapeHtml(runtime.messages["home.empty"])}</div>`;

  const body = `<div class="studio-fade-in studio-home">
    <h1 class="studio-sr-only">${escapeHtml(runtime.messages["home.title"])}</h1>
    <p class="studio-page-intro">${escapeHtml(runtime.messages["home.intro"])}</p>

    ${
      collections.length === 0
        ? emptyState
        : `<div class="studio-home-grid">${cards}</div>`
    }
  </div>`;

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
    }),
  );
}
