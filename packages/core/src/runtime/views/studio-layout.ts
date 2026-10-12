/**
 * Shared HTML chrome for studio pages (overview, collection list, entry editor).
 * Renders the document, theme stylesheets, the collection sidebar, the top bar
 * with breadcrumbs and search, the command palette, and the page body.
 */

import type { CaretRuntimeConfig } from "../config.js";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Serialize trusted configuration for an inline script without allowing a
 * `</script>` sequence to terminate the surrounding element. */
export function serializeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export type Crumb = { label: string; href?: string };
export type StudioNavItem = { name: string; label: string; href: string; icon?: string; selected?: boolean };

export type StudioLayoutOptions = {
  runtime: CaretRuntimeConfig;
  title: string;
  breadcrumb?: Crumb[];
  /** Every Studio collection, for the sidebar and the command palette. */
  navigation?: StudioNavItem[];
  body: string;
  /** Extra inline <style> block for page-specific tweaks. */
  extraStyles?: string;
  /** Inline <script> body executed at end of <body>. */
  inlineScript?: string;
};

export function humanizeCollection(name: string): string {
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function pickIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("image") || lower.includes("gallery") || lower.includes("photo")) return "image";
  if (lower.includes("site") || lower.includes("setting") || lower.includes("config")) return "settings";
  if (lower.includes("team") || lower.includes("author") || lower.includes("user") || lower.includes("testimonial")) return "person";
  if (lower.includes("product") || lower.includes("shop")) return "tag";
  if (lower.includes("faq") || lower.includes("question")) return "help";
  return "document";
}

const ICON_PATHS: Record<string, string> = {
  document: '<path d="M7 3.75h6.5L17 7.25v13H7z"/><path d="M13.5 3.75v3.5H17M9.5 11h5M9.5 14h5M9.5 17h3.5"/>',
  image: '<rect x="3.75" y="5" width="16.5" height="14" rx="1.5"/><circle cx="9" cy="10" r="1.5"/><path d="m5.5 17 4.25-4 3 2.5 2.25-2 3.5 3.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.55-2-3.45-2.5 1a7 7 0 0 0-1.75-1L14.25 3h-4.5l-.4 3A7 7 0 0 0 7.6 7L5.1 6l-2 3.45L5.1 11a7 7 0 0 0 0 2l-2 1.55 2 3.45 2.5-1a7 7 0 0 0 1.75 1l.4 3h4.5l.4-3a7 7 0 0 0 1.75-1l2.5 1 2-3.45-2-1.55a7 7 0 0 0 .1-1Z"/>',
  person: '<circle cx="12" cy="8" r="3.25"/><path d="M5.5 20c.6-4 2.75-6 6.5-6s5.9 2 6.5 6"/>',
  collection: '<path d="M3.5 7.5h6l1.5 2h9.5v10h-17z"/><path d="M3.5 7.5v-3h6l1.5 2h7v3"/>',
  tag: '<path d="M3.75 12.5V4.75h7.75l8.75 8.75-7.75 7.75z"/><circle cx="8" cy="9" r="1.25"/>',
  help: '<circle cx="12" cy="12" r="8.25"/><path d="M9.75 9.5a2.25 2.25 0 1 1 3.4 1.95c-.7.4-1.15.9-1.15 1.7v.35M12 16.75h.01"/>',
  overview: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.25"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.25"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.25"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.25"/>',
  search: '<circle cx="11" cy="11" r="6.25"/><path d="m20 20-4.5-4.5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  external: '<path d="M13.5 4.5h6v6M19.5 4.5 11 13M17 14v5.5H4.5V7H10"/>',
  signOut: '<path d="M14 4.5h4.5v15H14M10 8l-4 4 4 4M6 12h9"/>',
  sun: '<circle cx="12" cy="12" r="3.75"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10Z"/>',
  system: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="1.5"/><path d="M8.5 19.5h7M12 16v3.5"/>',
};

export function renderIcon(key: string, className = "studio-icon"): string {
  const paths = ICON_PATHS[key];
  if (!paths) return `<span class="${className}" aria-hidden="true">${escapeHtml(key)}</span>`;
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

/** A configured collection icon, or one inferred from the collection name. */
export function renderCollectionIcon(icon: string | undefined, name: string, className = "studio-icon"): string {
  return renderIcon(icon || pickIcon(name), className);
}

function renderBrandMark(logo: string | null): string {
  if (logo) {
    return `<img src="${escapeHtml(logo)}" alt="" class="studio-brand-mark" style="object-fit: contain;" />`;
  }
  return `<svg class="studio-brand-mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2L2 9l10 13 10-13L12 2zm0 3.84L18.26 9 12 17.65 5.74 9 12 5.84z"/>
  </svg>`;
}

function renderBreadcrumb(crumbs: Crumb[], label: string): string {
  if (crumbs.length === 0) return `<span class="studio-breadcrumb" aria-hidden="true"></span>`;
  const items = crumbs
    .map((crumb, idx) => {
      const isLast = idx === crumbs.length - 1;
      const sep = idx === 0 ? "" : `<span class="studio-breadcrumb-sep" aria-hidden="true">/</span>`;
      if (isLast || !crumb.href) {
        return `${sep}<span class="studio-breadcrumb-current"${isLast ? ' aria-current="page"' : ""}>${escapeHtml(crumb.label)}</span>`;
      }
      return `${sep}<a href="${escapeHtml(crumb.href)}">${escapeHtml(crumb.label)}</a>`;
    })
    .join("");

  return `<nav class="studio-breadcrumb" aria-label="${escapeHtml(label)}">${items}</nav>`;
}

function renderSidebar(runtime: CaretRuntimeConfig, navigation: StudioNavItem[], overviewActive: boolean): string {
  const m = runtime.messages;
  const overviewHref = `${runtime.mountPath}/cms`;
  const links = navigation.map((item) => `<a href="${escapeHtml(item.href)}" class="studio-sidebar-link${item.selected ? " active" : ""}"${item.selected ? ' aria-current="page"' : ""} data-collection="${escapeHtml(item.name)}">
          ${renderCollectionIcon(item.icon, item.name)}<span>${escapeHtml(item.label)}</span>
        </a>`).join("");
  return `<aside class="studio-sidebar" id="studio-sidebar" aria-label="${escapeHtml(m["nav.studio"])}">
      <a href="${escapeHtml(overviewHref)}" class="studio-brand">
        ${renderBrandMark(runtime.brand.logo)}
        <span>${escapeHtml(runtime.brand.name)}</span>
      </a>
      <nav class="studio-sidebar-nav" aria-label="${escapeHtml(m["nav.collections"])}">
        <a href="${escapeHtml(overviewHref)}" class="studio-sidebar-link${overviewActive ? " active" : ""}"${overviewActive ? ' aria-current="page"' : ""}>
          ${renderIcon("overview")}<span>${escapeHtml(m["nav.overview"])}</span>
        </a>
        ${navigation.length ? `<p class="studio-sidebar-heading">${escapeHtml(m["nav.collections"])}</p>${links}` : ""}
      </nav>
      <div class="studio-sidebar-footer">
        <a href="${escapeHtml(runtime.editorHome)}" class="studio-sidebar-link">${renderIcon("external")}<span>${escapeHtml(m["nav.viewSite"])}</span></a>
        <button type="button" class="studio-sidebar-link" id="studio-theme-btn" aria-label="${escapeHtml(m["theme.label"])}: ${escapeHtml(m["theme.system"])}">
          <span class="studio-theme-icon" data-theme-icon="system">${renderIcon("system")}</span>
          <span class="studio-theme-icon" data-theme-icon="light">${renderIcon("sun")}</span>
          <span class="studio-theme-icon" data-theme-icon="dark">${renderIcon("moon")}</span>
          <span>${escapeHtml(m["theme.label"])}</span>
          <span class="studio-sidebar-value" id="studio-theme-label">${escapeHtml(m["theme.system"])}</span>
        </button>
        <div class="studio-account">
          <span class="studio-avatar" id="studio-avatar" aria-hidden="true"></span>
          <span class="studio-account-text">
            <span id="studio-editor-identity" class="studio-editor-identity">${escapeHtml(m["nav.signedInAs"])}</span>
          </span>
          <button id="studio-logout-btn" class="studio-icon-btn" type="button" aria-label="${escapeHtml(m["nav.signOut"])}" title="${escapeHtml(m["nav.signOut"])}">${renderIcon("signOut")}</button>
        </div>
      </div>
    </aside>`;
}

function renderPalette(runtime: CaretRuntimeConfig): string {
  const m = runtime.messages;
  return `<div class="studio-palette" id="studio-palette" hidden>
      <div class="studio-palette-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(m["nav.goTo"])}">
        <div class="studio-palette-field">
          ${renderIcon("search")}
          <input id="studio-palette-input" type="text" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="studio-palette-results" aria-autocomplete="list" aria-label="${escapeHtml(m["nav.goToLabel"])}" placeholder="${escapeHtml(m["nav.searchPlaceholder"])}" />
          <kbd>Esc</kbd>
        </div>
        <ul class="studio-palette-results" id="studio-palette-results" role="listbox" aria-label="${escapeHtml(m["nav.results"])}"></ul>
      </div>
    </div>`;
}

export function renderStudioPage(opts: StudioLayoutOptions): string {
  const { runtime, title, breadcrumb = [], navigation = [], body, extraStyles = "", inlineScript = "" } = opts;
  const brand = runtime.brand;
  const m = runtime.messages;
  const themeCss = `${runtime.apiBasePath}/theme.css`;
  const studioCss = "/__caret/studio.css";
  const overviewActive = !navigation.some((item) => item.selected);

  const favicon = brand.faviconUrl
    ? `<link rel="icon" href="${escapeHtml(brand.faviconUrl)}" />`
    : "";

  return `<!doctype html>
<html lang="${escapeHtml(runtime.locale)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(title)} — ${escapeHtml(brand.name)}</title>
    ${favicon}
    <script>
      (function () {
        try {
          var theme = localStorage.getItem('caret-studio-theme');
          if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
        } catch (e) { /* storage may be blocked; follow the system */ }
        if (window.parent !== window) document.documentElement.classList.add('studio-embedded');
      })();
    </script>
    <link rel="stylesheet" href="${themeCss}" />
    <link rel="stylesheet" href="${studioCss}" />
    ${extraStyles ? `<style>${extraStyles}</style>` : ""}
  </head>
  <body>
    <div class="studio-app">
      ${renderSidebar(runtime, navigation, overviewActive)}
      <div class="studio-sidebar-scrim" id="studio-sidebar-scrim" hidden></div>
      <div class="studio-shell">
        <header class="studio-header">
          <button type="button" class="studio-icon-btn studio-menu-btn" id="studio-menu-btn" aria-label="${escapeHtml(m["nav.menu"])}" aria-controls="studio-sidebar" aria-expanded="false">${renderIcon("menu")}</button>
          ${renderBreadcrumb(breadcrumb, runtime.locale === "es" ? "Navegación jerárquica" : "Breadcrumb")}
          <button type="button" class="studio-search-btn" id="studio-search-btn" aria-haspopup="dialog" aria-controls="studio-palette">
            ${renderIcon("search")}<span>${escapeHtml(m["nav.search"])}</span><kbd>⌘K</kbd>
          </button>
        </header>
        <main class="studio-main studio-scroll">
          ${body}
        </main>
      </div>
    </div>
    ${renderPalette(runtime)}

    <script>
      (function () {
        var apiBase = ${serializeJsonForScript(runtime.apiBasePath)};
        var mountPath = ${serializeJsonForScript(runtime.mountPath)};
        var messages = ${serializeJsonForScript({
          system: m["theme.system"], light: m["theme.light"], dark: m["theme.dark"], label: m["theme.label"],
          empty: m["nav.searchEmpty"], collections: m["nav.collections"], entries: m["nav.searchEntries"],
          overview: m["nav.overview"], untitled: m["collection.untitled"],
        })};
        var navigation = ${serializeJsonForScript(navigation.map(({ name, label, href }) => ({ name, label, href })))};
        var root = document.documentElement;

        // ── Theme: System → Light → Dark ───────────────────────────────
        var themeBtn = document.getElementById('studio-theme-btn');
        var themeLabel = document.getElementById('studio-theme-label');
        function currentTheme() { return root.dataset.theme === 'light' || root.dataset.theme === 'dark' ? root.dataset.theme : 'system'; }
        function showTheme() {
          var theme = currentTheme();
          root.dataset.themeChoice = theme;
          if (themeLabel) themeLabel.textContent = messages[theme];
          if (themeBtn) themeBtn.setAttribute('aria-label', messages.label + ': ' + messages[theme]);
        }
        showTheme();
        if (themeBtn) themeBtn.addEventListener('click', function () {
          var next = { system: 'light', light: 'dark', dark: 'system' }[currentTheme()];
          if (next === 'system') delete root.dataset.theme; else root.dataset.theme = next;
          try {
            if (next === 'system') localStorage.removeItem('caret-studio-theme');
            else localStorage.setItem('caret-studio-theme', next);
          } catch (e) { /* the choice still applies to this page */ }
          showTheme();
        });

        // ── Mobile sidebar ─────────────────────────────────────────────
        var menuBtn = document.getElementById('studio-menu-btn');
        var scrim = document.getElementById('studio-sidebar-scrim');
        function setMenu(open) {
          root.classList.toggle('studio-menu-open', open);
          if (menuBtn) menuBtn.setAttribute('aria-expanded', String(open));
          if (scrim) scrim.hidden = !open;
        }
        if (menuBtn) menuBtn.addEventListener('click', function () { setMenu(!root.classList.contains('studio-menu-open')); });
        if (scrim) scrim.addEventListener('click', function () { setMenu(false); });

        // ── Identity ───────────────────────────────────────────────────
        var identityEl = document.getElementById('studio-editor-identity');
        var avatarEl = document.getElementById('studio-avatar');
        fetch(apiBase + '/auth/session', { credentials: 'same-origin' })
          .then(function (response) { return response.ok ? response.json() : null; })
          .then(function (body) {
            var identity = body && body.identity;
            var label = identity && (identity.name || identity.email);
            if (!label) return;
            if (identityEl) identityEl.textContent = label;
            if (avatarEl) avatarEl.textContent = String(label).trim().charAt(0).toUpperCase();
          }).catch(function () {});

        // ── Sign out ───────────────────────────────────────────────────
        var logoutBtn = document.getElementById('studio-logout-btn');
        if (logoutBtn) logoutBtn.addEventListener('click', function () {
          fetch(apiBase + '/auth/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-caret-request': '1' },
            body: '{}',
            credentials: 'same-origin'
          }).then(function (response) {
            return response.json().catch(function () { return null; });
          }).then(function (body) {
            window.location.href = body && body.redirect ? body.redirect : mountPath;
          }).catch(function () {
            window.location.href = mountPath;
          });
        });

        // ── Command palette ────────────────────────────────────────────
        var palette = document.getElementById('studio-palette');
        var input = document.getElementById('studio-palette-input');
        var list = document.getElementById('studio-palette-results');
        var searchBtn = document.getElementById('studio-search-btn');
        if (!palette || !input || !list) return;
        var results = [];
        var active = 0;
        var searchToken = 0;
        var restoreFocus = null;
        var searchTimer = 0;

        function staticResults(query) {
          var q = query.toLowerCase();
          var items = [{ group: messages.collections, label: messages.overview, href: mountPath + '/cms' }]
            .concat(navigation.map(function (item) { return { group: messages.collections, label: item.label, href: item.href }; }));
          return q ? items.filter(function (item) { return item.label.toLowerCase().indexOf(q) >= 0; }) : items;
        }
        function render() {
          list.innerHTML = '';
          if (!results.length) {
            var empty = document.createElement('li');
            empty.className = 'studio-palette-empty';
            empty.textContent = messages.empty;
            list.appendChild(empty);
            input.removeAttribute('aria-activedescendant');
            return;
          }
          var lastGroup = '';
          results.forEach(function (item, index) {
            if (item.group !== lastGroup) {
              lastGroup = item.group;
              var heading = document.createElement('li');
              heading.className = 'studio-palette-group';
              heading.setAttribute('role', 'presentation');
              heading.textContent = item.group;
              list.appendChild(heading);
            }
            var option = document.createElement('li');
            option.id = 'studio-palette-option-' + index;
            option.className = 'studio-palette-option' + (index === active ? ' active' : '');
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(index === active));
            var label = document.createElement('span');
            label.textContent = item.label;
            option.appendChild(label);
            if (item.detail) {
              var detail = document.createElement('span');
              detail.className = 'studio-palette-detail';
              detail.textContent = item.detail;
              option.appendChild(detail);
            }
            option.addEventListener('mousemove', function () { if (active !== index) { active = index; render(); } });
            option.addEventListener('click', function () { go(index); });
            list.appendChild(option);
          });
          input.setAttribute('aria-activedescendant', 'studio-palette-option-' + active);
          var current = document.getElementById('studio-palette-option-' + active);
          if (current) current.scrollIntoView({ block: 'nearest' });
        }
        function entryTitle(data, id) {
          var keys = ['title', 'name', 'headline', 'question', 'label', 'company_name'];
          for (var i = 0; i < keys.length; i++) if (data && typeof data[keys[i]] === 'string' && data[keys[i]]) return data[keys[i]];
          return id || messages.untitled;
        }
        function search(query) {
          results = staticResults(query);
          active = 0;
          render();
          window.clearTimeout(searchTimer);
          if (query.length < 2) return;
          var token = ++searchToken;
          searchTimer = window.setTimeout(function () {
            Promise.all(navigation.map(function (item) {
              return fetch(apiBase + '/entries?collection=' + encodeURIComponent(item.name) + '&q=' + encodeURIComponent(query) + '&pageSize=5', { credentials: 'same-origin' })
                .then(function (response) { return response.ok ? response.json() : null; })
                .then(function (body) {
                  var entries = body && Array.isArray(body.entries) ? body.entries : [];
                  return entries.map(function (entry) {
                    return { group: messages.entries, label: entryTitle(entry.data, entry.id), detail: item.label, href: mountPath + '/cms/' + encodeURIComponent(item.name) + '/' + encodeURIComponent(entry.id) };
                  });
                }).catch(function () { return []; });
            })).then(function (groups) {
              if (token !== searchToken) return;
              results = staticResults(query).concat([].concat.apply([], groups));
              render();
            });
          }, 180);
        }
        function go(index) {
          var item = results[index];
          if (item) window.location.href = item.href;
        }
        function openPalette() {
          if (!palette.hidden) return;
          restoreFocus = document.activeElement;
          palette.hidden = false;
          input.value = '';
          search('');
          input.focus();
        }
        function closePalette() {
          if (palette.hidden) return;
          palette.hidden = true;
          if (restoreFocus && restoreFocus.focus) restoreFocus.focus();
        }
        if (searchBtn) {
          searchBtn.addEventListener('click', openPalette);
          var hint = searchBtn.querySelector('kbd');
          if (hint && !/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) hint.textContent = 'Ctrl K';
        }
        palette.addEventListener('click', function (event) { if (event.target === palette) closePalette(); });
        input.addEventListener('input', function () { search(input.value.trim()); });
        input.addEventListener('keydown', function (event) {
          if (event.key === 'ArrowDown') { event.preventDefault(); if (results.length) { active = (active + 1) % results.length; render(); } }
          else if (event.key === 'ArrowUp') { event.preventDefault(); if (results.length) { active = (active - 1 + results.length) % results.length; render(); } }
          else if (event.key === 'Enter') { event.preventDefault(); go(active); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePalette(); }
          else if (event.key === 'Tab') { event.preventDefault(); }
        });
        document.addEventListener('keydown', function (event) {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            if (palette.hidden) openPalette(); else closePalette();
          } else if (event.key === 'Escape' && root.classList.contains('studio-menu-open')) {
            setMenu(false);
            if (menuBtn) menuBtn.focus();
          }
        });
      })();
    </script>
    ${inlineScript ? `<script>${inlineScript}</script>` : ""}
  </body>
</html>`;
}

export function htmlResponse(content: string, status = 200): Response {
  return new Response(content, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location },
  });
}
