import { CLOUD, getCloudSessionToken, isCloudMode } from './config.js';

async function getTurnstileToken(action) {
  if (typeof window.cmsGetTurnstileToken !== 'function') return null;
  try {
    return await window.cmsGetTurnstileToken(action);
  } catch {
    return null;
  }
}

export async function mutateHeaders() {
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
  const headers = {};
  if (isCloudMode()) {
    if (CLOUD?.publicToken) headers['x-caret-token'] = CLOUD.publicToken;
    const sessionToken = getCloudSessionToken();
    if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export async function uploadHeaders() {
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
