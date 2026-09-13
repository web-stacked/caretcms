/** @typedef {{ path: string, message: string }} ValidationIssue */
/**
 * @typedef {{ kind: 'saved', revision?: number }
 * | { kind: 'validation', issues: ValidationIssue[] }
 * | { kind: 'conflict', currentRevision: number }
 * | { kind: 'unauthorized' }
 * | { kind: 'error' }} SaveResult
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {ValidationIssue[]} */
function validationIssues(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(issue => isRecord(issue)
    && typeof issue.path === 'string'
    && typeof issue.message === 'string'
    ? [{ path: issue.path, message: issue.message }]
    : []);
}

/**
 * @param {{ apiBasePath: string, fetchImpl?: typeof fetch }} options
 */
export function createStudioMutationClient({ apiBasePath, fetchImpl = fetch }) {
  /** @param {Record<string, unknown>} payload */
  async function mutate(payload) {
    const response = await fetchImpl(`${apiBasePath}/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-caret-request': '1' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    if (response.status === 401) return { response, body: null };
    const body = await response.json().catch(() => null);
    return { response, body };
  }

  /**
   * @param {{ collection: string, id: string, data: Record<string, unknown>, expectedRevision?: number }} input
   * @returns {Promise<SaveResult>}
   */
  async function save(input) {
    const payload = { type: 'put_entry', ...input };
    const { response, body } = await mutate(payload);
    if (response.status === 401) return { kind: 'unauthorized' };
    if (!response.ok) {
      const issues = isRecord(body) ? validationIssues(body.issues) : [];
      if (issues.length > 0) return { kind: 'validation', issues };
      if (response.status === 409 && isRecord(body) && typeof body.currentRevision === 'number') {
        return { kind: 'conflict', currentRevision: body.currentRevision };
      }
      return { kind: 'error' };
    }
    return isRecord(body) && typeof body.revision === 'number'
      ? { kind: 'saved', revision: body.revision }
      : { kind: 'saved' };
  }

  /**
   * @param {{ collection: string, id: string, expectedRevision?: number }} input
   * @returns {Promise<'deleted' | 'unauthorized' | 'error'>}
   */
  async function remove(input) {
    const { response } = await mutate({ type: 'delete_entry', ...input });
    if (response.status === 401) return 'unauthorized';
    return response.ok ? 'deleted' : 'error';
  }

  return { save, remove };
}
