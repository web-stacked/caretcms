import { buildCmsUrl, savesDrafts } from './config.js';
import { mutateHeaders, readHeaders } from './security.js';

/** @typedef {{ revision: number, baseRevision?: number, data: Record<string, unknown> }} EntrySnapshot */
/**
 * @typedef {{ ok: true, revision?: number }
 *   | { ok: false, reason: 'conflict', currentRevision?: number, latestValue?: string }
 *   | { ok: false, reason: 'invalid', message: string }
 *   | { ok: false, reason: 'unauthorized' | 'error' }} SaveResult
 * `invalid` is a save the server refused (it won't succeed on retry);
 * `error` is one that couldn't complete (offline, server failure).
 */
/** @typedef {'saving' | 'idle' | 'error'} SaveStatus */
/** @typedef {{ type: 'save_field', collection: string, id: string, field: string, value: string, expectedRevision?: number, expectedBaseRevision?: number }} SaveFieldPayload */
/**
 * @typedef {{ baseValue?: string }} SaveFieldOptions
 * `baseValue` is the field's value when the editor started editing it. A
 * revision conflict whose latest value for this field still equals it was
 * caused by a change to another field, so the save retries instead of asking.
 */
/**
 * @typedef {((collection: string, id: string, field: string, value: string, options?: SaveFieldOptions) => Promise<SaveResult>) & {
 *   prime: (collection: string, id: string) => void,
 * }} SaveField
 */

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

/** @param {unknown} data @param {string} path @returns {{ found: boolean, value: unknown }} */
function getNestedValue(data, path) {
  /** @type {unknown} */
  let current = data;
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment) || Number(segment) >= current.length) return { found: false, value: undefined };
      current = current[Number(segment)];
    } else if (isRecord(current)) {
      if (!Object.hasOwn(current, segment)) return { found: false, value: undefined };
      current = current[segment];
    } else return { found: false, value: undefined };
  }
  return { found: true, value: current };
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
    return { revision: isRevision(json.revision) ? json.revision : 0, data: {}, ...(isRevision(json.baseRevision) ? { baseRevision: json.baseRevision } : {}) };
  }
  if (!isRecord(entry) || !isRecord(entry.data) || !isRevision(entry.revision)) {
    throw new Error('Invalid entry response');
  }

  return {
    revision: entry.revision,
    data: entry.data,
    ...(isRevision(entry.baseRevision) ? { baseRevision: entry.baseRevision } : {}),
  };
}

/**
 * @param {object} options
 * @param {(status: SaveStatus, message: string) => void} options.setStatus
 * @param {() => void} options.onUnauthorized
 * @returns {SaveField}
 */
export function createSaveField({ setStatus, onUnauthorized }) {
  const savesToDraft = savesDrafts();
  /** @type {Promise<unknown>} */
  let saveQueue = Promise.resolve();
  /** @type {Map<string, number>} */
  const revisionByEntry = new Map();
  /** @type {Map<string, number>} */
  const baseRevisionByEntry = new Map();
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
      if (snapshot.baseRevision !== undefined) baseRevisionByEntry.set(key, snapshot.baseRevision);
      else baseRevisionByEntry.delete(key);
      return snapshot.revision;
    })().finally(() => {
      revisionLoadByEntry.delete(key);
    });

    revisionLoadByEntry.set(key, task);
    return task;
  }

  /**
   * @param {string} collection @param {string} id @param {string} field
   * @returns {Promise<{ currentRevision: number | undefined, latestValue: string | undefined, fieldStored: boolean }>}
   */
  async function readLatestFieldValue(collection, id, field) {
    const snapshot = await fetchEntrySnapshot(collection, id, onUnauthorized);
    if (!snapshot) return { currentRevision: undefined, latestValue: undefined, fieldStored: true };

    revisionByEntry.set(entryKey(collection, id), snapshot.revision);
    if (snapshot.baseRevision !== undefined) baseRevisionByEntry.set(entryKey(collection, id), snapshot.baseRevision);
    else baseRevisionByEntry.delete(entryKey(collection, id));
    const stored = getNestedValue(snapshot.data, field);
    return {
      currentRevision: snapshot.revision,
      latestValue: typeof stored.value === 'string' ? stored.value : undefined,
      fieldStored: stored.found,
    };
  }

  /**
   * @param {string} collection @param {string} id @param {string} field @param {string} value
   * @param {SaveFieldOptions} options
   * @param {boolean} [isRetry]
   * @returns {Promise<SaveResult>}
   */
  async function execSave(collection, id, field, value, options, isRetry = false) {
    setStatus('saving', savesToDraft ? 'Saving draft…' : 'Saving live changes…');
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

      const expectedBaseRevision = baseRevisionByEntry.get(key);
      if (expectedBaseRevision !== undefined) body.expectedBaseRevision = expectedBaseRevision;

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

          /** @type {{ currentRevision: number | undefined, latestValue: string | undefined, fieldStored: boolean }} */
          let latest = { currentRevision: undefined, latestValue: undefined, fieldStored: true };
          try {
            latest = await readLatestFieldValue(collection, id, field);
          } catch {
            // Keep conflict semantics even if a follow-up refresh fails.
          }
          // Someone else changed a different field (this one still matches what
          // the editor started from, or was never saved and still renders its
          // template text), or saved the same text: nothing to decide.
          const untouchedHere = options.baseValue !== undefined
            && (latest.latestValue === options.baseValue || !latest.fieldStored);
          const sameText = latest.latestValue === value;
          if (!isRetry && typeof latest.currentRevision === 'number' && (untouchedHere || sameText)) {
            return execSave(collection, id, field, value, options, true);
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

        if (res.status >= 400 && res.status < 500) {
          const issue = Array.isArray(json.issues) && isRecord(json.issues[0]) ? json.issues[0] : null;
          const message = typeof issue?.message === 'string' ? issue.message
            : typeof json.error === 'string' ? json.error : 'This change could not be saved';
          setStatus('error', 'Not saved');
          return { ok: false, reason: 'invalid', message };
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

      setStatus('idle', savesToDraft ? 'Draft saved' : 'Changes are live');
      if (savesToDraft) window.dispatchEvent(new CustomEvent('cms:draftSaved'));
      window.dispatchEvent(new CustomEvent('cms:entrySaved', { detail: { collection, id } }));
      return { ok: true, revision: nextRevision };
    } catch {
      setStatus('error', 'Save failed');
      return { ok: false, reason: 'error' };
    }
  }

  /** @type {SaveField} */
  const saveField = Object.assign(
    /** @param {string} collection @param {string} id @param {string} field @param {string} value @param {SaveFieldOptions} [options] */
    (collection, id, field, value, options = {}) => {
      const task = saveQueue.then(() => execSave(collection, id, field, value, options));
      saveQueue = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
    {
      // Record the revision the page was rendered from, so a stale tab's first
      // save is checked against what its editor actually saw instead of
      // whatever is newest when it happens to save.
      /** @param {string} collection @param {string} id */
      prime(collection, id) {
        ensureRevision(collection, id).catch(() => {
          // A failed prime falls back to reading the revision at save time.
        });
      },
    },
  );
  return saveField;
}
