import { buildCmsUrl } from '../config.js';
import { isRecord } from './utils.js';
import { mutateHeaders, readHeaders } from '../security.js';

/** @typedef {import('./model.js').Section} Section */

/** @param {unknown} value @returns {value is number} */
function isRevision(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * @param {{ collection: string, id: string, onUnauthorized: () => void }} options
 * @returns {Promise<{ data: Record<string, unknown>, revision: number } | null>}
 */
export async function fetchPageEntry({ collection, id, onUnauthorized }) {
  const res = await fetch(buildCmsUrl('/entries', { collection, id }), {
    headers: readHeaders(),
  });
  if (res.status === 401) {
    onUnauthorized();
    return null;
  }
  if (!res.ok) throw new Error('Failed to load page data');

  const json = await res.json();
  const entry = isRecord(json) && Array.isArray(json.entries) ? json.entries[0] : null;
  if (!isRecord(entry) || !isRecord(entry.data)) {
    throw new Error('Page entry not found');
  }

  return {
    data: entry.data,
    revision: isRevision(entry.revision) ? entry.revision : 0,
  };
}

/**
 * @param {{ collection: string, id: string, sections: Section[], expectedRevision: number, onUnauthorized: () => void }} options
 * @returns {Promise<{ ok: true, revision: number } | { ok: false, reason: 'unauthorized' | 'conflict' | 'error', currentRevision?: number | null, error?: string }>}
 */
export async function savePageLayout({
  collection,
  id,
  sections,
  expectedRevision,
  onUnauthorized,
}) {
  const res = await fetch(buildCmsUrl('/mutate'), {
    method: 'POST',
    headers: await mutateHeaders(),
    body: JSON.stringify({
      type: 'update_page_layout',
      collection,
      id,
      sections,
      expectedRevision,
    }),
  });

  if (res.status === 401) {
    onUnauthorized();
    return { ok: false, reason: 'unauthorized' };
  }

  const rawJson = await res.json().catch(() => ({}));
  const json = isRecord(rawJson) ? rawJson : {};
  if (!res.ok) {
    if (res.status === 409) {
      return {
        ok: false,
        reason: 'conflict',
        currentRevision: isRevision(json.currentRevision) ? json.currentRevision : null,
      };
    }
    const issue = Array.isArray(json.issues) ? json.issues[0] : null;
    const issueDetail =
      issue &&
      typeof issue === 'object' &&
      typeof issue.path === 'string' &&
      typeof issue.message === 'string'
        ? `${issue.path}: ${issue.message}`
        : null;
    return {
      ok: false,
      reason: 'error',
      error:
        typeof json.error === 'string'
          ? issueDetail
            ? `${json.error} (${issueDetail})`
            : json.error
          : 'Failed to save layout',
    };
  }

  return {
    ok: true,
    revision:
      isRevision(json.revision)
        ? json.revision
        : isRevision(expectedRevision)
          ? expectedRevision + 1
          : 1,
  };
}
