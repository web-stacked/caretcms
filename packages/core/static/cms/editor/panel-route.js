import { STUDIO_PATH } from './config.js';
import { parseCaretAttr, resolveBinding } from './helpers.js';

/**
 * Which Studio route the on-page drawer shows. The drawer opens on what the
 * page shows: the entry that owns the page heading, the only entry on the
 * page, or an overview listing the page's entries. A route the editor chose
 * in the drawer is remembered for the page it was chosen on, so reloading
 * stays in place and another page never inherits it.
 */

const ROUTE_KEY = 'cms-panel-route';
/** Site chrome: entries bound only here (site settings) rank after the page's own. */
const CHROME = 'header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]';
const MAX_LISTED = 8;
/** Only called when a Studio is configured. */
const STUDIO = STUDIO_PATH ?? '';

/** @param {string} path */
function isStudioRoute(path) {
  return Boolean(STUDIO) && (path === STUDIO || path.startsWith(`${STUDIO}/`) || path.startsWith(`${STUDIO}?`));
}

/** @param {string} collection @param {string} id */
export function entryRoute(collection, id) {
  return `${STUDIO}/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;
}

/** @param {Element} element @returns {{ collection: string, id: string } | null} */
function bindingEntry(element) {
  const md = element.getAttribute('data-caret-md');
  if (md !== null) {
    const [collection, id] = md.split('::');
    return collection && id ? { collection, id } : null;
  }
  const resolved = resolveBinding(element, parseCaretAttr(element.getAttribute('data-caret') || ''));
  return resolved ? { collection: resolved.collection, id: resolved.id } : null;
}

/**
 * The entries bound on this page in page order, the page's own before site
 * chrome, and the one the page is about if it can tell.
 * @param {ParentNode} [root]
 * @returns {{ primary: string | null, entries: string[] }} keys are `collection::id`
 */
export function readPageEntries(root = document) {
  /** @type {string[]} */
  const own = [];
  /** @type {string[]} */
  const chrome = [];
  /** @type {string | null} */
  let heading = null;
  root.querySelectorAll('[data-caret], [data-caret-md]').forEach((element) => {
    const entry = bindingEntry(element);
    if (!entry) return;
    const key = `${entry.collection}::${entry.id}`;
    const inChrome = Boolean(element.closest(CHROME));
    if (!inChrome && !heading && (element.matches('h1') || element.closest('h1'))) heading = key;
    const list = inChrome ? chrome : own;
    if (!list.includes(key)) list.push(key);
  });
  const entries = [...own, ...chrome.filter((key) => !own.includes(key))];
  const primary = heading ?? (own.length === 1 ? own[0] : own.length === 0 && chrome.length === 1 ? chrome[0] : null);
  return { primary, entries };
}

/** The route for what this page shows, ignoring anything remembered. */
export function pageRoute() {
  const { primary, entries } = readPageEntries();
  if (primary) {
    const [collection, id] = primary.split('::');
    return entryRoute(collection, id);
  }
  if (entries.length === 0) return STUDIO;
  const query = new URLSearchParams();
  entries.slice(0, MAX_LISTED).forEach((key) => query.append('on', key));
  return `${STUDIO}?${query}`;
}

/** The entry route this page's drawer is on, else the page's own entry. */
export function pageEntryRoute() {
  const path = (rememberedRoute() ?? '').split(/[?#]/)[0];
  if (path.startsWith(`${STUDIO}/`) && /^\/[^/]+\/[^/]+$/.test(path.slice(STUDIO.length))) return path;
  const route = pageRoute();
  return route.includes('?') || route === STUDIO ? null : route;
}

/** @returns {string | null} */
function rememberedRoute() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(ROUTE_KEY) || 'null');
    if (stored && stored.page === window.location.pathname && typeof stored.path === 'string' && isStudioRoute(stored.path)) {
      return stored.path;
    }
  } catch {
    // Session storage is optional.
  }
  return null;
}

/** Remember the drawer's route for this page. @param {string} path */
export function rememberPanelRoute(path) {
  if (!isStudioRoute(path)) return;
  try {
    sessionStorage.setItem(ROUTE_KEY, JSON.stringify({ page: window.location.pathname, path }));
  } catch {
    // Session storage is optional.
  }
}

/** Where the drawer opens on this page. */
export function initialPanelRoute() {
  return rememberedRoute() ?? pageRoute();
}
