import { defineToolbarApp } from "astro/toolbar";
// Dependency-free, and resolved by Vite from the package, so it works where
// /__caret/ isn't served.
import { unsupportedTags } from "../editor/sanitize.js";

// CaretCMS Dev Toolbar app — a login-free, dev-only view of the data-caret
// bindings on the current page. It complements the in-editor "Show All" button
// (static/cms/editor/toolbar.js), which only works once an editor session is
// authenticated. This runs in `astro dev` for anyone, with no login.
//
// The binding resolver below mirrors static/cms/editor/helpers.js. It is
// inlined (rather than imported from /__caret/editor/helpers.js) so the toolbar
// keeps working in `output: 'static'` projects where /__caret/ is not served.
// If helpers.js changes, keep these two in sync.

/**
 * @typedef {{ collection: string | null, id: string | null, field: string }} ParsedBinding
 * @typedef {{ collection: string, id: string, field: string }} ResolvedBinding
 * @typedef {"text" | "image" | "rich" | "locked"} BindingKind
 * @typedef {{ el: Element, index: number, collection: string, id: string, field: string, key: string, kind: BindingKind, blockedBy: string[] }} PageBinding
 * @typedef {{ el: Element, attr: string, kind: BindingKind, index: number }} OrphanBinding
 * @typedef {{ bindings: PageBinding[], orphans: OrphanBinding[], duplicates: PageBinding[], locked: PageBinding[], stega: boolean, total: number }} BindingScan
 */

/**
 * @param {string} attr
 * @returns {ParsedBinding | null}
 */
function parseCaretAttr(attr) {
  const parts = attr.split("::");
  if (parts.length === 3) return { collection: parts[0], id: parts[1], field: parts[2] };
  if (parts.length === 1 && !attr.includes("::")) return { collection: null, id: null, field: attr };
  return null;
}

/**
 * @param {Element} el
 * @param {ParsedBinding | null} parsed
 * @returns {ResolvedBinding | null}
 */
function resolveBinding(el, parsed) {
  if (!parsed) return null;
  // Explicit null check, not truthiness — mirrors helpers.js; see the parity
  // test (tests/unit/caret-parser-parity.test.ts).
  if (parsed.collection !== null && parsed.id !== null) {
    return { collection: parsed.collection, id: parsed.id, field: parsed.field };
  }
  let node = el.parentElement;
  while (node) {
    const scope = node.getAttribute("data-caret-scope");
    if (scope) {
      const parts = scope.split("::");
      if (parts.length === 2) return { collection: parts[0], id: parts[1], field: parsed.field };
    }
    node = node.parentElement;
  }
  return null;
}

function devConfig() {
  const c =
    (typeof window !== "undefined" &&
      /** @type {Window & { __CARET_DEV__?: { mountPath?: unknown, apiBasePath?: unknown } }} */ (window)
        .__CARET_DEV__) ||
    {};
  return {
    mountPath: typeof c.mountPath === "string" ? c.mountPath : "/admin",
    apiBasePath: typeof c.apiBasePath === "string" ? c.apiBasePath : "/api/cms",
  };
}

/**
 * @param {Element} el
 * @returns {BindingKind}
 */
function classify(el) {
  if (el.tagName.toLowerCase() === "img") return "image";
  if (el.hasAttribute("data-caret-rich")) return "rich";
  // As the editor decides (text-edit.js): inline formatting makes a plain
  // binding rich; any other markup keeps it read-only on the page.
  if (el.hasAttribute("data-caret-raw") || el.children.length === 0) return "text";
  return unsupportedTags(el).length ? "locked" : "rich";
}

// Walk the page and resolve every data-caret element to a full key, splitting
// out orphans (field-only attrs with no resolvable scope) and duplicate keys.
/** @returns {BindingScan} */
function scanBindings() {
  const els = Array.from(document.querySelectorAll("[data-caret]"));
  /** @type {PageBinding[]} */
  const bindings = [];
  /** @type {OrphanBinding[]} */
  const orphans = [];

  els.forEach((el, i) => {
    const attr = el.getAttribute("data-caret") || "";
    const parsed = parseCaretAttr(attr);
    const resolved = resolveBinding(el, parsed);
    const kind = classify(el);
    if (!resolved) {
      orphans.push({ el, attr, kind, index: i });
      return;
    }
    bindings.push({
      el,
      index: i,
      collection: resolved.collection,
      id: resolved.id,
      field: resolved.field,
      key: `${resolved.collection}::${resolved.id}::${resolved.field}`,
      kind,
      blockedBy: kind === "locked" ? unsupportedTags(el) : [],
    });
  });

  /** @type {Map<string, number>} */
  const counts = new Map();
  bindings.forEach((b) => counts.set(b.key, (counts.get(b.key) || 0) + 1));
  const duplicates = bindings.filter((b) => (counts.get(b.key) ?? 0) > 1);
  const locked = bindings.filter((b) => b.kind === "locked");

  // Stega-encoded bindings (live-loader content) only become real data-caret
  // attributes after the editor's stega-hydrate.js runs, which needs auth — so
  // a logged-out scan can undercount. Detect the U+E0000 markers to warn.
  const stega = /\u{E0000}/u.test((document.body && document.body.textContent) || "");

  return { bindings, orphans, duplicates, locked, stega, total: els.length };
}

// --- login-free highlight: our own outline CSS keyed on [data-caret] directly,
// so it does NOT depend on the editor's .cms-editable class or editor.css.
// Colors are deliberately distinct from the editor's blue scheme so the two can
// be told apart when both are active at once.
const HIGHLIGHT_STYLE_ID = "__caret-devtoolbar-highlight__";

/** @param {boolean} active */
function applyHighlight(active) {
  const existing = document.getElementById(HIGHLIGHT_STYLE_ID);
  if (existing) existing.remove();
  if (!active) return;
  const style = document.createElement("style");
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
    [data-caret]{outline:2px solid #6366f1 !important;outline-offset:2px;}
    [data-caret][data-caret-rich]{outline-color:#10b981 !important;}
    img[data-caret]{outline:2px dashed #f59e0b !important;outline-offset:4px;}
  `;
  document.head.appendChild(style);
}

/**
 * Repeated jumps share the first inline style snapshot so overlapping timers
 * cannot restore a temporary outline and leave it stuck on the page.
 * @type {WeakMap<HTMLElement | SVGElement, { outline: string, outlineOffset: string, timer: number }>}
 */
const scrollFlashes = new WeakMap();

/** @param {Element} el */
function scrollTo(el) {
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  if (!(el instanceof HTMLElement || el instanceof SVGElement)) return;

  const active = scrollFlashes.get(el);
  if (active) window.clearTimeout(active.timer);
  const outline = active?.outline ?? el.style.outline;
  const outlineOffset = active?.outlineOffset ?? el.style.outlineOffset;
  el.style.outline = "3px solid #6366f1";
  el.style.outlineOffset = "3px";
  const timer = window.setTimeout(() => {
    const current = scrollFlashes.get(el);
    if (!current || current.timer !== timer) return;
    el.style.outline = current.outline;
    el.style.outlineOffset = current.outlineOffset;
    scrollFlashes.delete(el);
  }, 1500);
  scrollFlashes.set(el, { outline, outlineOffset, timer });
}

/** @type {Record<BindingKind, string>} */
const KIND_LABEL = { text: "text", image: "image", rich: "rich", locked: "read-only" };

/** @type {Record<string, string>} */
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/** @param {string} s */
function esc(s) {
  return s.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c] ?? c);
}

const PANEL_CSS = `
  :host{all:initial;}
  astro-dev-toolbar-window{width:min(440px,100%) !important;height:auto !important;}
  .wrap{font-family:system-ui,-apple-system,sans-serif;color:#e2e8f0;width:100%;max-height:min(70vh,520px);display:flex;flex-direction:column;}
  .head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 2px 10px;border-bottom:1px solid rgba(255,255,255,.1);}
  .title{font-size:13px;font-weight:600;}
  .count{font-size:11px;color:#94a3b8;}
  .actions{display:flex;gap:6px;padding:10px 2px;}
  button.btn{font:inherit;font-size:12px;cursor:pointer;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);color:#e2e8f0;border-radius:6px;padding:5px 10px;}
  button.btn:hover{background:rgba(255,255,255,.12);}
  button.btn.on{background:#6366f1;border-color:#6366f1;color:#fff;}
  .scroll{overflow-y:auto;flex:1;padding-right:2px;}
  .note{font-size:11px;color:#fbbf24;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.2);border-radius:6px;padding:6px 8px;margin:8px 0;}
  .note a{color:inherit;text-decoration:underline;}
  .problem{font-size:11px;color:#f87171;background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.2);border-radius:6px;padding:6px 8px;margin:8px 0;}
  .problem b{color:#fca5a5;}
  .group{margin:10px 0 0;}
  .ghead{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;font-weight:600;color:#cbd5e1;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.06);}
  .ghead a{color:#818cf8;text-decoration:none;font-weight:500;white-space:nowrap;}
  .ghead a:hover{text-decoration:underline;}
  .row{display:flex;align-items:center;gap:8px;padding:5px 2px;border-bottom:1px solid rgba(255,255,255,.04);}
  .field{flex:1;font-size:12px;color:#e2e8f0;font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .kind{font-size:9px;text-transform:uppercase;letter-spacing:.04em;padding:1px 5px;border-radius:4px;font-weight:600;}
  .kind.text{background:rgba(99,102,241,.2);color:#a5b4fc;}
  .kind.image{background:rgba(245,158,11,.2);color:#fcd34d;}
  .kind.rich{background:rgba(16,185,129,.2);color:#6ee7b7;}
  .kind.locked{background:rgba(239,68,68,.2);color:#fca5a5;}
  .jump{font:inherit;font-size:11px;cursor:pointer;border:none;background:transparent;color:#94a3b8;padding:2px 4px;border-radius:4px;}
  .jump:hover{color:#e2e8f0;background:rgba(255,255,255,.08);}
  .empty{font-size:12px;color:#94a3b8;padding:16px 2px;text-align:center;}
  .dup{color:#fca5a5;}
`;

export default defineToolbarApp({
  init(canvas, app) {
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    canvas.appendChild(style);

    const win = document.createElement("astro-dev-toolbar-window");
    const wrap = document.createElement("div");
    wrap.className = "wrap";
    win.appendChild(wrap);
    canvas.appendChild(win);

    let highlightOn = false;
    /** @type {BindingScan} */
    let scan = { bindings: [], orphans: [], duplicates: [], locked: [], stega: false, total: 0 };

    function render() {
      scan = scanBindings();
      const { mountPath } = devConfig();
      const { bindings, orphans, duplicates, locked, stega } = scan;

      // Group bindings by collection::id, preserving first-seen order.
      /** @type {Map<string, PageBinding[]>} */
      const groups = new Map();
      for (const b of bindings) {
        const gk = `${b.collection}::${b.id}`;
        const rows = groups.get(gk);
        if (rows) rows.push(b);
        else groups.set(gk, [b]);
      }

      const dupKeys = new Set(duplicates.map((d) => d.key));

      let html = `
        <div class="head">
          <span class="title">CaretCMS bindings</span>
          <span class="count">${bindings.length} on page${stega ? " · more after sign-in" : ""}${orphans.length ? ` · ${orphans.length} orphan${orphans.length > 1 ? "s" : ""}` : ""}</span>
        </div>
        <div class="actions">
          <button type="button" class="btn ${highlightOn ? "on" : ""}" data-action="highlight" aria-pressed="${highlightOn}">${highlightOn ? "Hide" : "Highlight"} all</button>
          <button type="button" class="btn" data-action="rescan">Rescan</button>
        </div>
        <div class="scroll">`;

      if (stega) {
        const signIn = `${mountPath}?redirect=${encodeURIComponent(location.pathname + location.search)}`;
        html += `<div class="note">Content from live collections becomes bindings once the editor loads. <a href="${esc(signIn)}">Sign in</a> to count and list them here.</div>`;
      }
      if (orphans.length) {
        html += `<div class="problem"><b>${orphans.length} orphan binding${orphans.length > 1 ? "s" : ""}</b> — field-only <code>data-caret</code> with no resolvable <code>data-caret-scope</code> ancestor: ${orphans.map((o) => `<code>${esc(o.attr)}</code>`).join(", ")}</div>`;
      }
      if (duplicates.length) {
        const uniq = Array.from(new Set(duplicates.map((d) => d.key)));
        html += `<div class="problem"><b>${uniq.length} duplicate key${uniq.length > 1 ? "s" : ""}</b> — same binding used more than once: ${uniq.map((k) => `<code>${esc(k)}</code>`).join(", ")}</div>`;
      }

      if (locked.length) {
        const blocked = Array.from(new Set(locked.flatMap((b) => b.blockedBy)));
        html += `<div class="problem"><b>${locked.length} field${locked.length > 1 ? "s" : ""} can't be edited on the page</b> — ${locked.length > 1 ? "they contain" : "it contains"} markup rich text can't hold (${blocked.map((tag) => `<code>&lt;${esc(tag)}&gt;</code>`).join(", ")}), so editors see ${locked.length > 1 ? "them" : "it"} read-only and saved values don't reach the page. Put <code>data-caret</code> on the element that holds just the text: ${locked.map((b) => `<code>${esc(b.key)}</code>`).join(", ")}</div>`;
      }

      if (!bindings.length && !orphans.length) {
        html += `<div class="empty">No <code>data-caret</code> bindings found on this page.<br />Run <code>npx @caretcms/caretize</code> to add some.</div>`;
      }
      // Developer-only: published content whose Git record is pending. Editors
      // aren't asked to fix this; each publish retries it.
      html += `<div class="git-history" hidden></div>`;

      for (const [gk, rows] of groups) {
        const [collection, id] = gk.split("::");
        const studioHref = `${mountPath}/cms/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;
        html += `<div class="group">
          <div class="ghead"><span>${esc(gk)}</span><a href="${esc(studioHref)}" target="_blank" rel="noopener">Open in Studio ↗</a></div>`;
        for (const b of rows) {
          html += `<div class="row">
            <span class="field ${dupKeys.has(b.key) ? "dup" : ""}">${esc(b.field)}</span>
            <span class="kind ${b.kind}">${KIND_LABEL[b.kind]}</span>
            <button type="button" class="jump" data-action="scroll" data-index="${b.index}">scroll to</button>
          </div>`;
        }
        html += `</div>`;
      }

      html += `</div>`;
      wrap.innerHTML = html;
      void showGitHistory();
      const probs = scan.orphans.length + scan.duplicates.length + scan.locked.length;
      app.toggleNotification({ state: probs > 0, level: "warning" });
    }

    /** Pending Git history for the signed-in editor's publications, with Retry. */
    async function showGitHistory(message = "") {
      const box = wrap.querySelector(".git-history");
      if (!(box instanceof HTMLElement)) return;
      /** @type {{ journalPending?: unknown, retryJournal?: unknown } | null} */
      let state = null;
      try {
        const res = await fetch(`${devConfig().apiBasePath}/draft`, { credentials: "same-origin", headers: { "x-caret-request": "1" } });
        state = res.ok ? await res.json() : null;
      } catch { state = null; }
      const pending = state && typeof state.journalPending === "number" ? state.journalPending : 0;
      box.hidden = pending === 0 && !message;
      if (box.hidden) return;
      box.className = pending > 0 ? "git-history problem" : "git-history note";
      box.innerHTML = pending > 0
        ? `<b>Git history pending</b> for ${pending} published ${pending === 1 ? "entry" : "entries"}. Each publish retries; check the repository, then retry here.${message ? ` ${esc(message)}` : ""}` +
          (state && state.retryJournal === true ? ` <button type="button" class="btn" data-action="retry-git">Retry Git history</button>` : "")
        : esc(message);
    }

    async function retryGitHistory() {
      let message = "";
      try {
        const res = await fetch(`${devConfig().apiBasePath}/publish`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "x-caret-request": "1" },
          body: JSON.stringify({ retryJournal: true }),
        });
        const body = res.ok ? await res.json() : null;
        const journal = body && typeof body.journal === "object" ? body.journal : null;
        message = !journal ? "Retry failed; see the server log."
          : journal.pending === 0 ? "Git history recorded."
          : journal.blocked > 0 ? "Some records need review: published content has moved on since."
          : "Still pending; see the server log.";
      } catch {
        message = "Retry failed; see the server log.";
      }
      await showGitHistory(message);
    }

    /** @param {string | null} index */
    function elementByIndex(index) {
      const b = scan.bindings.find((x) => x.index === Number(index));
      return b ? b.el : null;
    }

    wrap.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target.closest("[data-action]");
      if (!target) return;
      const action = target.getAttribute("data-action");
      if (action === "highlight") {
        highlightOn = !highlightOn;
        applyHighlight(highlightOn);
        target.textContent = `${highlightOn ? "Hide" : "Highlight"} all`;
        target.classList.toggle("on", highlightOn);
        target.setAttribute("aria-pressed", String(highlightOn));
      } else if (action === "rescan") {
        render();
      } else if (action === "retry-git") {
        void retryGitHistory();
      } else if (action === "scroll") {
        const el = elementByIndex(target.getAttribute("data-index"));
        if (el) scrollTo(el);
      }
    });

    // Re-render each time the panel opens; flag problems with a notification dot.
    app.onToggled(({ state }) => {
      if (!state) return;
      render();
    });
  },
});
