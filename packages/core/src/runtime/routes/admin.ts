import type { APIContext } from "astro";
import {
  hasConfiguredEditorPassword,
  isEditorAuthenticated,
} from "../auth/session.js";
import { sanitizeRedirect } from "../auth/cookie-utils.js";
import { getRuntimeConfig } from "../config.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderBrandMark(logoUrl: string | null): string {
  if (logoUrl) {
    return `<img src="${escapeHtml(logoUrl)}" alt="" class="studio-login-mark" style="object-fit: contain;" />`;
  }
  return `<div class="studio-login-mark" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2L2 9l10 13 10-13L12 2zm0 3.84L18.26 9 12 17.65 5.74 9 12 5.84z"/>
    </svg>
  </div>`;
}

function renderLogin(opts: {
  hasPassword: boolean;
  apiBasePath: string;
  redirectTo: string;
  brandName: string;
  brandLogo: string | null;
  faviconUrl: string | null;
  themeCssHref: string;
  studioCssHref: string;
  loginCssHref: string;
}): string {
  const {
    hasPassword,
    apiBasePath,
    redirectTo,
    brandName,
    brandLogo,
    faviconUrl,
    themeCssHref,
    studioCssHref,
    loginCssHref,
  } = opts;

  const safeBrand = escapeHtml(brandName);
  const safeRedirect = escapeHtml(redirectTo);
  const statusNote = hasPassword
    ? "Sign in to manage content."
    : "Set CARET_EDIT_PASSWORD (or EDIT_PASSWORD) to enable login.";

  const favicon = faviconUrl
    ? `<link rel="icon" href="${escapeHtml(faviconUrl)}" />`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${safeBrand} — Sign In</title>
    ${favicon}
    <link rel="stylesheet" href="${themeCssHref}" />
    <link rel="stylesheet" href="${studioCssHref}" />
    <link rel="stylesheet" href="${loginCssHref}" />
  </head>
  <body class="studio-login-page">
    <div class="studio-login-bg"></div>
    <div class="studio-login-grid"></div>
    <div class="studio-login-accent-top"></div>

    <div class="studio-login-card">
      <div class="studio-login-card-glow"></div>

      <div class="studio-login-card-body">
        <span class="studio-corner studio-corner-h studio-corner-tl-h"></span>
        <span class="studio-corner studio-corner-v studio-corner-tl-v"></span>
        <span class="studio-corner studio-corner-h studio-corner-tr-h"></span>
        <span class="studio-corner studio-corner-v studio-corner-tr-v"></span>
        <span class="studio-corner studio-corner-h studio-corner-bl-h"></span>
        <span class="studio-corner studio-corner-v studio-corner-bl-v"></span>
        <span class="studio-corner studio-corner-h studio-corner-br-h"></span>
        <span class="studio-corner studio-corner-v studio-corner-br-v"></span>

        <div class="studio-login-header">
          ${renderBrandMark(brandLogo)}
          <h1 class="studio-login-title">${safeBrand}</h1>
          <p class="studio-login-tagline">${escapeHtml(statusNote)}</p>
        </div>

        <div id="login-error" class="studio-login-error" hidden>
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
          </svg>
          <span id="login-error-text">Invalid password.</span>
        </div>

        <form id="login-form" class="studio-login-form" method="POST" action="${escapeHtml(`${apiBasePath}/auth/login`)}">
          <input type="hidden" name="redirect" value="${safeRedirect}" />

          <div class="studio-login-field">
            <label for="password">Password</label>
            <div class="studio-login-input-wrap">
              <input
                type="password"
                id="password"
                name="password"
                required
                autocomplete="current-password"
                class="studio-login-input"
                placeholder="Enter editor password"
                ${hasPassword ? "" : "disabled"}
              />
              <svg class="studio-login-input-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/>
              </svg>
            </div>
          </div>

          <button type="submit" class="studio-login-submit" ${hasPassword ? "" : "disabled"}>
            <span class="studio-login-submit-content">
              <span>Sign In</span>
              <svg class="studio-login-submit-arrow" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3"/>
              </svg>
            </span>
          </button>
        </form>

        <div class="studio-login-footer">
          <a href="/">&larr; Back to site</a>
        </div>
      </div>
    </div>

    <script>
      (function () {
        var form = document.getElementById('login-form');
        var error = document.getElementById('login-error');
        var errorText = document.getElementById('login-error-text');
        if (!form) return;

        form.addEventListener('submit', function (e) {
          e.preventDefault();
          if (error) error.hidden = true;

          var btn = form.querySelector('button[type="submit"]');
          if (btn) btn.disabled = true;

          var fd = new FormData(form);
          var headers = { 'Accept': 'application/json', 'x-caret-request': '1' };

          fetch(form.action, {
            method: 'POST',
            body: fd,
            headers: headers,
            credentials: 'same-origin'
          })
            .then(function (res) {
              return res.json().catch(function () { return { error: 'Login failed' }; })
                .then(function (data) { return { ok: res.ok, data: data }; });
            })
            .then(function (result) {
              if (result.ok && result.data && result.data.redirect) {
                try { sessionStorage.setItem('caret:welcome', '1'); } catch (e) {}
                window.location.href = result.data.redirect;
                return;
              }
              if (errorText && result.data && result.data.error) {
                errorText.textContent = result.data.error;
              }
              if (error) error.hidden = false;
              if (btn) btn.disabled = false;
            })
            .catch(function () {
              if (error) error.hidden = false;
              if (btn) btn.disabled = false;
            });
        });
      })();
    </script>
  </body>
</html>`;
}

function html(content: string, status = 200, setCookie?: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
  };
  if (setCookie) headers["Set-Cookie"] = setCookie;

  return new Response(content, { status, headers });
}

export async function GET(context: APIContext): Promise<Response> {
  const runtime = getRuntimeConfig();
  const redirectTarget = sanitizeRedirect(
    context.url.searchParams.get("redirect"),
    runtime.editorHome,
  );

  if (isEditorAuthenticated(context)) {
    return new Response(null, {
      status: 302,
      headers: { Location: redirectTarget },
    });
  }

  return html(
    renderLogin({
      hasPassword: hasConfiguredEditorPassword(),
      apiBasePath: runtime.apiBasePath,
      redirectTo: redirectTarget,
      brandName: runtime.brand.name,
      brandLogo: runtime.brand.logo,
      faviconUrl: runtime.brand.faviconUrl,
      themeCssHref: `${runtime.apiBasePath}/theme.css`,
      studioCssHref: "/__caret/studio.css",
      loginCssHref: "/__caret/studio-login.css",
    }),
  );
}
