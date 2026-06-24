/** Runtime config injected by the integration bootstrap script. */
const defaults = {
  mode: 'embedded',
  mountPath: '/admin',
  apiBasePath: '/api/cms',
  cloud: null,
};

const cfg = (typeof window !== 'undefined' && window.__CARET__) || defaults;

function normalizePath(value, fallback) {
  if (!value || typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/')
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
}

function normalizeEndpoint(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().replace(/\/$/, '');
}

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

function getStorageKey(cloud) {
  return `caretcms:cloud-session:${cloud.endpoint}:${cloud.projectId}`;
}

export const CMS_CONFIG = cfg;
export const CMS_MODE = cfg.mode === 'cloud' || cfg.mode === 'hybrid' ? cfg.mode : 'embedded';
export const DELIVERY_MODE =
  cfg.delivery && cfg.delivery.mode === 'static' ? 'static' : 'server';

export function isStaticDelivery() {
  return DELIVERY_MODE === 'static';
}

export function isServerDelivery() {
  return !isStaticDelivery();
}
export const MOUNT_PATH = normalizePath(cfg.mountPath, defaults.mountPath);
export const API_BASE = normalizePath(cfg.apiBasePath, defaults.apiBasePath);
export const CLOUD = getCloudConfig();
export const STUDIO_PATH = CLOUD ? null : `${MOUNT_PATH}/cms`;

export function isCloudMode() {
  return CMS_MODE === 'cloud' && CLOUD !== null;
}

export function getCloudSessionToken() {
  if (!isCloudMode() || typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(getStorageKey(CLOUD));
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function clearCloudSessionToken() {
  if (!isCloudMode() || typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(getStorageKey(CLOUD));
  } catch {
    // Ignore localStorage failures.
  }
}

export function buildCmsUrl(path, search) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  let url;

  if (isCloudMode()) {
    url = new URL(`${CLOUD.contentPath}${normalizedPath}`, `${CLOUD.endpoint}/`);
    url.searchParams.set('projectId', CLOUD.projectId);
    if (CLOUD.environment) {
      url.searchParams.set('environment', CLOUD.environment);
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
  if (isCloudMode()) {
    const url = new URL(`${CLOUD.contentPath}/admin`, `${CLOUD.endpoint}/`);
    url.searchParams.set('projectId', CLOUD.projectId);
    url.searchParams.set('redirect', redirectTo);
    return url.toString();
  }

  return `${MOUNT_PATH}?redirect=${encodeURIComponent(redirectTo)}`;
}
