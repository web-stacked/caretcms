import { CLOUD, getCloudSessionToken, isCloudMode } from './config.js';

/**
 * @param {string} action
 * @returns {Promise<string | null>}
 */
async function getTurnstileToken(action) {
  const getToken = /** @type {Window & { cmsGetTurnstileToken?: (action: string) => unknown }} */ (
    window
  ).cmsGetTurnstileToken;
  if (typeof getToken !== 'function') return null;
  try {
    const token = await getToken(action);
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

export async function mutateHeaders() {
  /** @type {Record<string, string>} */
  const headers = { 'Content-Type': 'application/json', 'x-caret-request': '1' };
  if (isCloudMode()) {
    if (CLOUD?.publicToken) headers['x-caret-token'] = CLOUD.publicToken;
    const sessionToken = getCloudSessionToken();
    if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  }
  const token = await getTurnstileToken('cms_mutate');
  if (token) {
    headers['x-cms-turnstile-token'] = token;
  }
  return headers;
}

export function readHeaders() {
  /** @type {Record<string, string>} */
  const headers = {};
  if (isCloudMode()) {
    if (CLOUD?.publicToken) headers['x-caret-token'] = CLOUD.publicToken;
    const sessionToken = getCloudSessionToken();
    if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export async function uploadHeaders() {
  /** @type {Record<string, string>} */
  const headers = { 'x-caret-request': '1' };
  if (isCloudMode()) {
    if (CLOUD?.publicToken) headers['x-caret-token'] = CLOUD.publicToken;
    const sessionToken = getCloudSessionToken();
    if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  }
  const token = await getTurnstileToken('cms_upload');
  if (token) {
    headers['x-cms-turnstile-token'] = token;
  }
  return headers;
}
