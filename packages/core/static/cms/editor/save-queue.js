import { buildCmsUrl } from './config.js';
import { mutateHeaders, readHeaders } from './security.js';

function entryKey(collection, id) {
  return `${collection}::${id}`;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

function getNestedStringValue(data, path) {
  if (!isRecord(data)) return undefined;

  let current = data;
  for (const segment of path.split('.')) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = current[segment];
  }

  return typeof current === 'string' ? current : undefined;
}

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
  const entry = Array.isArray(json.entries) ? json.entries[0] : null;
  if (!entry || !isRecord(entry.data)) {
    return { revision: 0, data: {} };
  }

  return {
    revision: Number.isInteger(entry.revision) ? entry.revision : 0,
    data: entry.data,
  };
}

export function createSaveField({ setStatus, onUnauthorized }) {
  let saveQueue = Promise.resolve();
  const revisionByEntry = new Map();
  const revisionLoadByEntry = new Map();

  async function ensureRevision(collection, id) {
    const key = entryKey(collection, id);
    if (revisionByEntry.has(key)) {
      return revisionByEntry.get(key);
    }

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

  async function readLatestFieldValue(collection, id, field) {
    const snapshot = await fetchEntrySnapshot(collection, id, onUnauthorized);
    if (!snapshot) return { currentRevision: undefined, latestValue: undefined };

    revisionByEntry.set(entryKey(collection, id), snapshot.revision);
    return {
      currentRevision: snapshot.revision,
      latestValue: getNestedStringValue(snapshot.data, field),
    };
  }

  async function execSave(collection, id, field, value) {
    setStatus('saving', 'Saving...');
    const key = entryKey(collection, id);

    try {
      const expectedRevision = await ensureRevision(collection, id);
      if (expectedRevision === null) {
        return { ok: false, reason: 'unauthorized' };
      }

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

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409) {
          const currentRevision = Number.isInteger(json.currentRevision)
            ? json.currentRevision
            : undefined;
          if (typeof currentRevision === 'number') {
            revisionByEntry.set(key, currentRevision);
          }

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

      const nextRevision = Number.isInteger(json.revision)
        ? json.revision
        : typeof expectedRevision === 'number'
          ? expectedRevision + 1
          : undefined;
      if (typeof nextRevision === 'number') {
        revisionByEntry.set(key, nextRevision);
      }

      setStatus('idle', 'Saved');
      return { ok: true, revision: nextRevision };
    } catch {
      setStatus('error', 'Save failed');
      return { ok: false, reason: 'error' };
    }
  }

  return function saveField(collection, id, field, value) {
    const task = saveQueue.then(() => execSave(collection, id, field, value));
    saveQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
}
