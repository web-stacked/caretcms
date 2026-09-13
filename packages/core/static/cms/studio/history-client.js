/** @typedef {{ id: string, name?: string, email?: string }} HistoryEditor */
/** @typedef {{ ts: number, action: string, editor?: HistoryEditor }} HistoryItem */
/**
 * @typedef {{ kind: 'loaded', items: HistoryItem[] }
 * | { kind: 'unauthorized' }
 * | { kind: 'error' }} HistoryResult
 */
/**
 * @typedef {{ kind: 'restored', data: unknown, revision?: number }
 * | { kind: 'unauthorized' }
 * | { kind: 'error' }} RestoreResult
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {HistoryItem[]} */
function historyItems(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!isRecord(item) || typeof item.ts !== 'number' || !Number.isFinite(item.ts)) return [];
    /** @type {HistoryItem} */
    const normalized = {
      ts: item.ts,
      action: typeof item.action === 'string' && item.action ? item.action : 'save',
    };
    if (isRecord(item.editor) && typeof item.editor.id === 'string') {
      normalized.editor = { id: item.editor.id };
      if (typeof item.editor.name === 'string') normalized.editor.name = item.editor.name;
      if (typeof item.editor.email === 'string') normalized.editor.email = item.editor.email;
    }
    return [normalized];
  });
}

/** @param {{ apiBasePath: string, fetchImpl?: typeof fetch }} options */
export function createStudioHistoryClient({ apiBasePath, fetchImpl = fetch }) {
  /** @param {{ collection: string, id: string }} input @returns {Promise<HistoryResult>} */
  async function list(input) {
    const search = new URLSearchParams(input);
    const response = await fetchImpl(`${apiBasePath}/history?${search}`, {
      credentials: 'same-origin',
    });
    if (response.status === 401) return { kind: 'unauthorized' };
    if (!response.ok) return { kind: 'error' };
    const body = await response.json().catch(() => null);
    return isRecord(body)
      ? { kind: 'loaded', items: historyItems(body.history) }
      : { kind: 'error' };
  }

  /** @param {{ collection: string, id: string, ts: number }} input @returns {Promise<RestoreResult>} */
  async function restore(input) {
    const response = await fetchImpl(`${apiBasePath}/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-caret-request': '1' },
      credentials: 'same-origin',
      body: JSON.stringify(input),
    });
    if (response.status === 401) return { kind: 'unauthorized' };
    if (!response.ok) return { kind: 'error' };
    const body = await response.json().catch(() => null);
    if (!isRecord(body) || !Object.prototype.hasOwnProperty.call(body, 'data')) {
      return { kind: 'error' };
    }
    return typeof body.revision === 'number'
      ? { kind: 'restored', data: body.data, revision: body.revision }
      : { kind: 'restored', data: body.data };
  }

  return { list, restore };
}
