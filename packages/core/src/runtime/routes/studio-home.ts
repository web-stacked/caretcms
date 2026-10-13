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
  humanizeCollection,
  redirectResponse,
  renderCollectionIcon,
  renderStudioPage,
  serializeJsonForScript,
} from "../views/studio-layout.js";

export async function GET(context: APIContext): Promise<Response> {
  const runtime = getRuntimeConfig();
  const loginRedirect = `${runtime.mountPath}?redirect=${encodeURIComponent(`${runtime.mountPath}/cms`)}`;

  if (!isEditorAuthenticated(context)) {
    return redirectResponse(loginRedirect);
  }

  const adapter = await resolveAdapter();
  const configuredCollections = await getStudioCollections(adapter);

  const navigation = configuredCollections.map(({ name, config }) => ({
    name,
    icon: config.icon,
    label: config.label || humanizeCollection(name),
    href: config.singletonId
      ? `${runtime.mountPath}/cms/${encodeURIComponent(name)}/${encodeURIComponent(config.singletonId)}`
      : `${runtime.mountPath}/cms/${encodeURIComponent(name)}`,
  }));

  const cards = configuredCollections
    .map(({ name, config }, index) => {
      const { label, href } = navigation[index];
      return `<a href="${escapeHtml(href)}" class="studio-card-interactive studio-collection-card" data-collection="${escapeHtml(name)}">
        <span class="studio-collection-icon">${renderCollectionIcon(config.icon, name)}</span>
        <span class="studio-collection-body">
          <h2 class="studio-collection-name">${escapeHtml(label)}</h2>
          ${config.description ? `<p class="studio-collection-description">${escapeHtml(config.description)}</p>` : ""}
        </span>
        ${config.singletonId ? "" : `<span class="studio-count-label" data-collection="${escapeHtml(name)}">…</span>`}
      </a>`;
    })
    .join("");

  // Adapter-agnostic copy: where entries live depends on the configured
  // storage (.caret/data for the filesystem adapter, src/content for markdown,
  // KV for Cloudflare) — naming one path here misleads every other setup.
  const emptyState = `<div class="studio-card" style="padding:2rem;text-align:center;color:var(--studio-text-dim);font-size:0.85rem;">${escapeHtml(runtime.messages["home.empty"])}</div>`;

  const body = `<div class="studio-fade-in studio-page studio-home">
    <header class="studio-page-header">
      <div>
        <h1 class="studio-page-title">${escapeHtml(runtime.messages["home.title"])}</h1>
        <p class="studio-page-intro">${escapeHtml(runtime.messages["home.intro"])}</p>
      </div>
    </header>

    ${
      configuredCollections.length === 0
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
      breadcrumb: [{ label: runtime.messages["nav.overview"] }],
      navigation,
      body,
      inlineScript,
    }),
  );
}
