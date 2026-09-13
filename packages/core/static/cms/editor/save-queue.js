import { buildCmsUrl, isPolicyDraftMode } from './config.js';
import { mutateHeaders, readHeaders } from './security.js';

/** @typedef {{ revision: number, data: Record<string, unknown> }} EntrySnapshot */
/**
 * @typedef {{ ok: true, revision?: number }
 *   | { ok: false, reason: 'conflict', currentRevision?: number, latestValue?: string }
 *   | { ok: false, reason: 'unauthorized' | 'error' }} SaveResult
 */
/** @typedef {'saving' | 'idle' | 'error'} SaveStatus */
/** @typedef {{ type: 'save_field', collection: string, id: string, field: string, value: string, expectedRevision?: number }} SaveFieldPayload */

/** @param {string} collection @param {string} id @returns {string} */
function entryKey(collection, id) {
  return `${collection}::${id}`;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is number} */
function isRevision(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** @param {unknown} data @param {string} path @returns {string | undefined} */
function getNestedStringValue(data, path) {
  if (!isRecord(data)) return undefined;

  /** @type {unknown} */
  let current = data;
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isRecord(current)) {
      if (!Object.hasOwn(current, segment)) return undefined;
      current = current[segment];
    } else return undefined;
  }

  return typeof current === 'string' ? current : undefined;
}

/**
 * @param {string} collection
 * @param {string} id
 * @param {() => void} onUnauthorized
 * @returns {Promise<EntrySnapshot | null>}
 */
async function fetchEntrySnapshot(collection, id, onUnauthorized) {
  const res = await fetch(buildCmsUrl('/entries', { collection, id }), {
    headers: readHeaders(),
  });
  if (res.status === 401) {
    onUnauthorized();
    return null;
  }
  if (!res.ok) throw new Error('Failed to load entry');

  const json = await res.json();
  if (!isRecord(json) || !Array.isArray(json.entries)) {
    throw new Error('Invalid entry response');
  }
  const entry = json.entries[0];
  if (entry === undefined) {
    return { revision: 0, data: {} };
  }
  if (!isRecord(entry) || !isRecord(entry.data) || !isRevision(entry.revision)) {
    throw new Error('Invalid entry response');
  }

  return {
    revision: entry.revision,
    data: entry.data,
  };
}

/**
 * @param {object} options
 * @param {(status: SaveStatus, message: string) => void} options.setStatus
 * @param {() => void} options.onUnauthorized
 * @returns {(collection: string, id: string, field: string, value: string) => Promise<SaveResult>}
 */
export function createSaveField({ setStatus, onUnauthorized }) {
  /** @type {Promise<unknown>} */
  let saveQueue = Promise.resolve();
  /** @type {Map<string, number>} */
  const revisionByEntry = new Map();
  /** @type {Map<string, Promise<number | null>>} */
  const revisionLoadByEntry = new Map();

  /** @param {string} collection @param {string} id @returns {Promise<number | null>} */
  async function ensureRevision(collection, id) {
    const key = entryKey(collection, id);
    const cached = revisionByEntry.get(key);
    if (cached !== undefined) return cached;

    const inFlight = revisionLoadByEntry.get(key);
    if (inFlight) return inFlight;

    const task = (async () => {
      const snapshot = await fetchEntrySnapshot(collection, id, onUnauthorized);
      if (!snapshot) return null;
      revisionByEntry.set(key, snapshot.revision);
      return snapshot.revision;
    })().finally(() => {
      revisionLoadByEntry.delete(key);
    });

    revisionLoadByEntry.set(key, task);
    return task;
  }

  /**
   * @param {string} collection @param {string} id @param {string} field
   * @returns {Promise<{ currentRevision: number | undefined, latestValue: string | undefined }>}
   */
  async function readLatestFieldValue(collection, id, field) {
    const snapshot = await fetchEntrySnapshot(collection, id, onUnauthorized);
    if (!snapshot) return { currentRevision: undefined, latestValue: undefined };

    revisionByEntry.set(entryKey(collection, id), snapshot.revision);
    return {
      currentRevision: snapshot.revision,
      latestValue: getNestedStringValue(snapshot.data, field),
    };
  }

  /**
   * @param {string} collection @param {string} id @param {string} field @param {string} value
   * @returns {Promise<SaveResult>}
   */
  async function execSave(collection, id, field, value) {
    setStatus('saving', 'Saving...');
    const key = entryKey(collection, id);

    try {
      const expectedRevision = await ensureRevision(collection, id);
      if (expectedRevision === null) {
        return { ok: false, reason: 'unauthorized' };
      }

      /** @type {SaveFieldPayload} */
      const body = { type: 'save_field', collection, id, field, value };
      if (typeof expectedRevision === 'number') {
        body.expectedRevision = expectedRevision;
      }

      const res = await fetch(buildCmsUrl('/mutate'), {
        method: 'POST',
        headers: await mutateHeaders(),
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        onUnauthorized();
        return { ok: false, reason: 'unauthorized' };
      }

      const parsed = await res.json().catch(() => null);
      const json = isRecord(parsed) ? parsed : {};
      if (!res.ok) {
        if (res.status === 409) {
          const currentRevision = isRevision(json.currentRevision)
            ? json.currentRevision
            : undefined;
          if (typeof currentRevision === 'number') {
            revisionByEntry.set(key, currentRevision);
          }

          /** @type {{ currentRevision: number | undefined, latestValue: string | undefined }} */
          let latest = { currentRevision: undefined, latestValue: undefined };
          try {
            latest = await readLatestFieldValue(collection, id, field);
          } catch {
            // Keep conflict semantics even if a follow-up refresh fails.
          }
          setStatus('error', 'Revision conflict');
          return {
            ok: false,
            reason: 'conflict',
            currentRevision:
              typeof latest.currentRevision === 'number'
                ? latest.currentRevision
                : currentRevision,
            latestValue: latest.latestValue,
          };
        }

        setStatus('error', 'Save failed');
        return { ok: false, reason: 'error' };
      }

      const fallbackRevision = typeof expectedRevision === 'number' && expectedRevision < Number.MAX_SAFE_INTEGER
        ? expectedRevision + 1
        : undefined;
      const nextRevision = isRevision(json.revision)
        ? json.revision
        : fallbackRevision;
      if (typeof nextRevision === 'number') {
        revisionByEntry.set(key, nextRevision);
      }

      setStatus('idle', isPolicyDraftMode() ? 'Draft saved' : 'Saved');
      if (isPolicyDraftMode()) window.dispatchEvent(new CustomEvent('cms:draftSaved'));
      return { ok: true, revision: nextRevision };
    } catch {
      setStatus('error', 'Save failed');
      return { ok: false, reason: 'error' };
    }
  }

  /** @param {string} collection @param {string} id @param {string} field @param {string} value */
  return function saveField(collection, id, field, value) {
    const task = saveQueue.then(() => execSave(collection, id, field, value));
    saveQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
}
