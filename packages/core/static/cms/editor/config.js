/** Runtime config injected by the integration bootstrap script. */
/** @typedef {{ endpoint?: unknown, projectId?: unknown, contentPath?: unknown, publicToken?: unknown, environment?: unknown }} RawCloudConfig */
/** @typedef {{ endpoint: string, projectId: string, contentPath: string, publicToken: string | null, environment: string | null }} CloudConfig */
/** @typedef {{ mode?: unknown, mountPath?: unknown, apiBasePath?: unknown, cloud?: RawCloudConfig | null, delivery?: { mode?: unknown } | null, draftMode?: unknown }} RuntimeConfig */

/** @type {RuntimeConfig} */
const defaults = {
  mode: 'embedded',
  mountPath: '/admin',
  apiBasePath: '/api/cms',
  cloud: null,
};

const injected = typeof window !== 'undefined'
  ? /** @type {Window & { __CARET__?: RuntimeConfig }} */ (window).__CARET__
  : undefined;
/** @type {RuntimeConfig} */
const cfg = injected || defaults;

/** @param {unknown} value @param {string} fallback */
function normalizePath(value, fallback) {
  if (!value || typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/')
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
}

/** @param {unknown} value */
function normalizeEndpoint(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().replace(/\/$/, '');
}

/** @returns {CloudConfig | null} */
function getCloudConfig() {
  if (!cfg || cfg.mode !== 'cloud' || !cfg.cloud || typeof cfg.cloud !== 'object') {
    return null;
  }

  const endpoint = normalizeEndpoint(cfg.cloud.endpoint);
  const projectId =
    typeof cfg.cloud.projectId === 'string' ? cfg.cloud.projectId.trim() : '';
  if (!endpoint || !projectId) return null;

  return {
    endpoint,
    projectId,
    contentPath: normalizePath(cfg.cloud.contentPath, '/content'),
    publicToken:
      typeof cfg.cloud.publicToken === 'string' && cfg.cloud.publicToken.trim()
        ? cfg.cloud.publicToken.trim()
        : null,
    environment:
      typeof cfg.cloud.environment === 'string' && cfg.cloud.environment.trim()
        ? cfg.cloud.environment.trim()
        : null,
  };
}

/** @param {CloudConfig} cloud */
function getStorageKey(cloud) {
  return `caretcms:cloud-session:${cloud.endpoint}:${cloud.projectId}`;
}

export const CMS_CONFIG = cfg;
export const CMS_MODE = cfg.mode === 'cloud' || cfg.mode === 'hybrid' ? cfg.mode : 'embedded';
export const DELIVERY_MODE =
  cfg.delivery && cfg.delivery.mode === 'static' ? 'static' : 'server';

export function isPolicyDraftMode() { return cfg.draftMode === true; }

export function isStaticDelivery() {
  return DELIVERY_MODE === 'static';
}

export function isServerDelivery() {
  return !isStaticDelivery();
}
export const MOUNT_PATH = normalizePath(cfg.mountPath, '/admin');
export const API_BASE = normalizePath(cfg.apiBasePath, '/api/cms');
export const CLOUD = getCloudConfig();
export const STUDIO_PATH = CLOUD ? null : `${MOUNT_PATH}/cms`;

export function isCloudMode() {
  return CMS_MODE === 'cloud' && CLOUD !== null;
}

export function getCloudSessionToken() {
  const cloud = CLOUD;
  if (!cloud || CMS_MODE !== 'cloud' || typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(getStorageKey(cloud));
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function clearCloudSessionToken() {
  const cloud = CLOUD;
  if (!cloud || CMS_MODE !== 'cloud' || typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(getStorageKey(cloud));
  } catch {
    // Ignore localStorage failures.
  }
}

/** @param {string} path @param {URLSearchParams | Record<string, string> | undefined} [search] */
export function buildCmsUrl(path, search) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  let url;

  const cloud = CLOUD;
  if (CMS_MODE === 'cloud' && cloud) {
    url = new URL(`${cloud.contentPath}${normalizedPath}`, `${cloud.endpoint}/`);
    url.searchParams.set('projectId', cloud.projectId);
    if (cloud.environment) {
      url.searchParams.set('environment', cloud.environment);
    }
  } else {
    url = new URL(`${API_BASE}${normalizedPath}`, window.location.origin);
  }

  if (search) {
    const params = search instanceof URLSearchParams ? search : new URLSearchParams(search);
    for (const [key, value] of params.entries()) {
      if (value) url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

export function getEditorLoginUrl(redirectTo = window.location.href) {
  const cloud = CLOUD;
  if (CMS_MODE === 'cloud' && cloud) {
    const url = new URL(`${cloud.contentPath}/admin`, `${cloud.endpoint}/`);
    url.searchParams.set('projectId', cloud.projectId);
    url.searchParams.set('redirect', redirectTo);
    return url.toString();
  }

  return `${MOUNT_PATH}?redirect=${encodeURIComponent(redirectTo)}`;
}
