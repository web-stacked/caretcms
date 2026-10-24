export const prerender = false;

import type { APIContext } from "astro";
import { isEditorAuthenticated } from "../auth/session.js";
import { getRuntimeConfig } from "../config.js";
import { resolveAdapter } from "./_helpers.js";
import {
  getStudioCollections,
  resolveCollectionStudioConfig,
} from "../schema-registry.js";
import { COLLECTION_NAME_RE, ENTRY_ID_RE } from "../storage/id-contracts.js";
import type { StorageAdapter } from "../../types.js";
import { allUnpublishedEntries } from "../unpublished.js";
import {
  escapeHtml,
  htmlResponse,
  humanizeCollection,
  redirectResponse,
  renderCollectionIcon,
  renderStudioPage,
  serializeJsonForScript,
} from "../views/studio-layout.js";
import { studioNavigation } from "../views/studio-navigation.js";

/** The on-page drawer lists at most this many entries from the page it covers. */
const MAX_PAGE_ENTRIES = 8;
const TITLE_KEYS = ["title", "name", "headline", "label", "question"];

/** "about-us" -> "About us". */
function humanizeId(id: string): string {
  const text = id.replace(/[-_]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The entries the on-page drawer found on the page it covers, passed as
 * repeated `on=collection::id` parameters. Malformed keys are dropped.
 */
function readPageEntryKeys(url: URL): Array<{ collection: string; id: string }> {
  const seen = new Set<string>();
  const keys: Array<{ collection: string; id: string }> = [];
  for (const raw of url.searchParams.getAll("on")) {
    const [collection, id, extra] = raw.split("::");
    if (extra !== undefined || !collection || !id) continue;
    if (!COLLECTION_NAME_RE.test(collection) || !ENTRY_ID_RE.test(id)) continue;
    const key = `${collection}::${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push({ collection, id });
    if (keys.length === MAX_PAGE_ENTRIES) break;
  }
  return keys;
}

async function describePageEntry(
  adapter: StorageAdapter,
  collection: string,
  id: string,
): Promise<{ title: string; collectionLabel: string; icon: string | undefined }> {
  const [config, entry] = await Promise.all([
    resolveCollectionStudioConfig(adapter, collection),
    adapter.getEntry(collection, id).catch(() => null),
  ]);
  const data = entry?.data ?? {};
  const titleKeys = config.titleField ? [config.titleField, ...TITLE_KEYS] : TITLE_KEYS;
  const titleKey = titleKeys.find((key) => typeof data[key] === "string" && String(data[key]).trim());
  return {
    title: titleKey ? String(data[titleKey]).trim() : humanizeId(id),
    collectionLabel: config.label || humanizeCollection(collection),
    icon: config.icon,
  };
}

export async function GET(context: APIContext): Promise<Response> {
  const runtime = getRuntimeConfig();
  const loginRedirect = `${runtime.mountPath}?redirect=${encodeURIComponent(`${runtime.mountPath}/cms`)}`;

  if (!isEditorAuthenticated(context)) {
    return redirectResponse(loginRedirect);
  }

  const adapter = await resolveAdapter();
  const configuredCollections = await getStudioCollections(adapter);

  const navigation = await studioNavigation(runtime, adapter);

  const pageEntryKeys = readPageEntryKeys(context.url);
  const pageEntries = await Promise.all(pageEntryKeys.map(async ({ collection, id }) => {
    const { title, collectionLabel, icon } = await describePageEntry(adapter, collection, id);
    const href = `${runtime.mountPath}/cms/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;
    return `<a href="${escapeHtml(href)}" class="studio-card-interactive studio-collection-card studio-page-entry" data-entry="${escapeHtml(`${collection}::${id}`)}">
        <span class="studio-collection-icon">${renderCollectionIcon(icon, collection)}</span>
        <span class="studio-collection-body">
          <h3 class="studio-collection-name">${escapeHtml(title)}</h3>
          <p class="studio-collection-description">${escapeHtml(collectionLabel)}</p>
        </span>
      </a>`;
  }));
  const onThisPage = pageEntries.length === 0 ? "" : `<section class="studio-home-section" aria-labelledby="studio-on-this-page">
      <h2 id="studio-on-this-page" class="studio-home-section-title">${escapeHtml(runtime.messages["home.onThisPage"])}</h2>
      <div class="studio-home-grid">${pageEntries.join("")}</div>
    </section>`;

  // Draft modes: everything this editor hasn't published yet, with Publish all.
  const unpublished = await allUnpublishedEntries();
  const unpublishedCards = await Promise.all(unpublished.map(async ({ collection, id, deleted }) => {
    const { title, collectionLabel, icon } = await describePageEntry(adapter, collection, id);
    const detail = deleted ? `${collectionLabel} · ${runtime.messages["entry.deleteNotPublished"]}` : collectionLabel;
    const card = `<span class="studio-collection-icon">${renderCollectionIcon(icon, collection)}</span>
        <span class="studio-collection-body">
          <h3 class="studio-collection-name">${escapeHtml(title)}</h3>
          <p class="studio-collection-description">${escapeHtml(detail)}</p>
        </span>`;
    // A deleted entry has no page to open.
    return deleted
      ? `<div class="studio-card studio-collection-card studio-page-entry" data-entry="${escapeHtml(`${collection}::${id}`)}">${card}</div>`
      : `<a href="${escapeHtml(`${runtime.mountPath}/cms/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`)}" class="studio-card-interactive studio-collection-card studio-page-entry" data-entry="${escapeHtml(`${collection}::${id}`)}">${card}</a>`;
  }));
  const notPublished = unpublishedCards.length === 0 ? "" : `<section class="studio-home-section" aria-labelledby="studio-not-published">
      <div class="studio-home-section-header">
        <h2 id="studio-not-published" class="studio-home-section-title">${escapeHtml(runtime.messages["home.notPublished"])}</h2>
        <button type="button" id="studio-publish-all" class="studio-btn-primary" hidden>${escapeHtml(runtime.messages["home.publishAll"])}</button>
      </div>
      <p id="studio-publish-status" class="studio-home-publish-status" role="status" aria-live="polite"></p>
      <div class="studio-home-grid">${unpublishedCards.join("")}</div>
    </section>`;

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

    ${notPublished}
    ${onThisPage}
    ${
      configuredCollections.length === 0
        ? emptyState
        : onThisPage || notPublished
          ? `<section class="studio-home-section" aria-labelledby="studio-all-collections">
      <h2 id="studio-all-collections" class="studio-home-section-title">${escapeHtml(runtime.messages["nav.collections"])}</h2>
      <div class="studio-home-grid">${cards}</div>
    </section>`
          : `<div class="studio-home-grid">${cards}</div>`
    }
  </div>`;


  const inlineScript = `(function(){
    var apiBase = ${serializeJsonForScript(runtime.apiBasePath)};
    var messages = ${serializeJsonForScript(runtime.messages)};

    // Publish all: everything this editor hasn't published yet. With an
    // authorization policy the button shows only for editors who may publish.
    var publishAll = document.getElementById('studio-publish-all');
    var publishStatus = document.getElementById('studio-publish-status');
    if (publishAll && publishStatus) {
      fetch(apiBase + '/draft', { headers: { 'x-caret-request': '1' }, credentials: 'same-origin' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (body) { publishAll.hidden = Boolean(body && body.canPublish === false); })
        .catch(function () { publishAll.hidden = false; });
      publishAll.addEventListener('click', function () {
        publishAll.disabled = true;
        publishStatus.textContent = messages['entry.publishing'];
        Promise.all([
          fetch(apiBase + '/publish', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-caret-request': '1' }, credentials: 'same-origin', body: '{}' })
            .then(function (res) { return res.json().catch(function () { return {}; }).then(function (body) { return { ok: res.ok, body: body }; }); }),
          import('/__caret/editor/publish-result.js'),
        ]).then(function (done) {
          var response = done[0];
          if (!response.ok) throw new Error(typeof response.body.error === 'string' ? response.body.error : messages['common.error']);
          var result = done[1].presentPublishResult(response.body);
          publishStatus.textContent = result.toast.message;
          publishStatus.dataset.kind = result.toast.kind;
          if (result.completed) {
            var section = publishAll.closest('section');
            var grid = section && section.querySelector('.studio-home-grid');
            var heading = document.getElementById('studio-not-published');
            if (grid) grid.remove();
            if (heading) heading.textContent = messages['home.allPublished'];
            publishAll.hidden = true;
          } else {
            publishAll.disabled = false;
          }
        }).catch(function (error) {
          publishStatus.textContent = error && error.message ? error.message : messages['common.error'];
          publishStatus.dataset.kind = 'error';
          publishAll.disabled = false;
        });
      });
    }
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
