import { buildCmsUrl } from '../config.js';
import { isRecord } from './utils.js';
import { mutateHeaders, readHeaders } from '../security.js';

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
  const entry = Array.isArray(json.entries) ? json.entries[0] : null;
  if (!entry || !isRecord(entry.data)) {
    throw new Error('Page entry not found');
  }

  return {
    data: entry.data,
    revision: Number.isInteger(entry.revision) ? entry.revision : 0,
  };
}

export async function savePageLayout({
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
      id,
      sections,
      expectedRevision,
    }),
  });

  if (res.status === 401) {
    onUnauthorized();
    return { ok: false, reason: 'unauthorized' };
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 409) {
      return {
        ok: false,
        reason: 'conflict',
        currentRevision: Number.isInteger(json.currentRevision) ? json.currentRevision : null,
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
      Number.isInteger(json.revision)
        ? json.revision
        : Number.isInteger(expectedRevision)
          ? expectedRevision + 1
          : 1,
  };
}
