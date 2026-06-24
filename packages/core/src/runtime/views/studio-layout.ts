/**
 * Shared HTML chrome for studio pages (dashboard, collection list, entry editor).
 * Renders the document, theme stylesheet links, sticky header with brand mark,
 * breadcrumb trail, and slots in the page-specific body content.
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

export type Crumb = { label: string; href?: string };

export type StudioLayoutOptions = {
  runtime: CaretRuntimeConfig;
  title: string;
  breadcrumb?: Crumb[];
  body: string;
  /** Extra inline <style> block for page-specific tweaks. */
  extraStyles?: string;
  /** Inline <script> body executed at end of <body>. */
  inlineScript?: string;
};

function renderBrandMark(logo: string | null): string {
  if (logo) {
    return `<img src="${escapeHtml(logo)}" alt="" class="studio-brand-mark" style="object-fit: contain;" />`;
  }
  return `<svg class="studio-brand-mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2L2 9l10 13 10-13L12 2zm0 3.84L18.26 9 12 17.65 5.74 9 12 5.84z"/>
  </svg>`;
}

function renderBreadcrumb(crumbs: Crumb[]): string {
  if (crumbs.length === 0) return "";
  const items = crumbs
    .map((crumb, idx) => {
      const isLast = idx === crumbs.length - 1;
      const sep = idx === 0 ? "" : `<span class="studio-breadcrumb-sep">/</span>`;
      if (isLast || !crumb.href) {
        return `${sep}<span class="studio-breadcrumb-current">${escapeHtml(crumb.label)}</span>`;
      }
      return `${sep}<a href="${escapeHtml(crumb.href)}">${escapeHtml(crumb.label)}</a>`;
    })
    .join("");

  return `<nav class="studio-breadcrumb" aria-label="Breadcrumb">${items}</nav>`;
}

function renderHeaderNav(mountPath: string, studioActive: boolean): string {
  const activeClass = studioActive ? " active" : "";
  return `<nav class="studio-header-nav" aria-label="Studio navigation">
          <a href="${escapeHtml(`${mountPath}/cms`)}" class="studio-nav-link${activeClass}">Studio</a>
          <button id="studio-logout-btn" class="studio-nav-link" type="button">Sign out</button>
        </nav>`;
}

export function renderStudioPage(opts: StudioLayoutOptions): string {
  const { runtime, title, breadcrumb = [], body, extraStyles = "", inlineScript = "" } = opts;
  const brand = runtime.brand;
  const themeCss = `${runtime.apiBasePath}/theme.css`;
  const studioCss = "/__caret/studio.css";

  const favicon = brand.faviconUrl
    ? `<link rel="icon" href="${escapeHtml(brand.faviconUrl)}" />`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(title)} — ${escapeHtml(brand.name)}</title>
    ${favicon}
    <link rel="stylesheet" href="${themeCss}" />
    <link rel="stylesheet" href="${studioCss}" />
    ${extraStyles ? `<style>${extraStyles}</style>` : ""}
  </head>
  <body>
    <div class="studio-shell">
      <header class="studio-header">
        <a href="${escapeHtml(`${runtime.mountPath}/cms`)}" class="studio-brand">
          ${renderBrandMark(brand.logo)}
          <span>${escapeHtml(brand.name)}</span>
        </a>
        ${renderBreadcrumb(breadcrumb)}
        ${renderHeaderNav(runtime.mountPath, breadcrumb.length === 0)}
      </header>
      <main class="studio-main studio-scroll">
        ${body}
      </main>
    </div>

    <script>
      (function () {
        var btn = document.getElementById('studio-logout-btn');
        if (!btn) return;
        btn.addEventListener('click', function () {
          fetch(${JSON.stringify(`${runtime.apiBasePath}/auth/logout`)}, {
            method: 'POST',
            headers: { 'x-caret-request': '1' },
            credentials: 'same-origin'
          }).finally(function () {
            window.location.href = ${JSON.stringify(runtime.mountPath)};
          });
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
