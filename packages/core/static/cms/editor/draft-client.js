/**
 * @typedef {object} DraftState
 * @property {number} count
 * @property {boolean} canPublish
 * @property {boolean} retryJournal
 * @property {number} journalPending
 * @property {boolean} retryRebuild
 */
/**
 * @typedef {object} RetryDeploymentResult
 * @property {boolean} deploymentTracked
 */

export class CmsDraftRequestError extends Error {}

/** @param {Response} response */
async function requireOk(response) {
  if (!response.ok) {
    throw new CmsDraftRequestError(`CMS request failed (${response.status})`);
  }
  return response;
}

/** @param {unknown} value */
function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * HTTP client for editor-specific draft and deploy-retry operations.
 *
 * @param {{
 *   buildUrl: (path: string) => string,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
export function createDraftClient(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = { 'Content-Type': 'application/json', 'x-caret-request': '1' };

  /** @param {'GET' | 'POST' | 'DELETE'} method @param {string} path @param {string | undefined} body */
  function request(method, path, body) {
    return fetchImpl(options.buildUrl(path), {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body }),
    });
  }

  async function getState() {
    const response = await requireOk(await request('GET', '/draft', undefined));
    const data = record(await response.json());
    return /** @type {DraftState} */ ({
      count: typeof data.count === 'number' && Number.isFinite(data.count)
        ? Math.max(0, Math.trunc(data.count))
        : 0,
      canPublish: data.canPublish !== false,
      retryRebuild: data.retryRebuild === true,
      retryJournal: data.retryJournal === true,
      journalPending: typeof data.journalPending === 'number' && Number.isSafeInteger(data.journalPending)
        ? Math.max(0, data.journalPending) : 0,
    });
  }

  async function publish() {
    const response = await requireOk(await request('POST', '/publish', '{}'));
    return /** @type {unknown} */ (await response.json());
  }

  async function discard() {
    await requireOk(await request('DELETE', '/draft', undefined));
  }

  async function retryDeployment() {
    const response = await requireOk(await request(
      'POST',
      '/publish',
      JSON.stringify({ retryRebuild: true }),
    ));
    const data = record(await response.json());
    const rebuild = record(data.rebuild);
    if (rebuild.ok !== true) throw new CmsDraftRequestError('Deployment retry failed');
    return /** @type {RetryDeploymentResult} */ ({
      deploymentTracked: data.deploymentTracked === true,
    });
  }

  async function retryJournal() {
    const response = await requireOk(await request('POST', '/publish', JSON.stringify({ retryJournal: true })));
    const data = record(await response.json());
    const journal = record(data.journal);
    if (data.ok !== true || typeof journal.pending !== 'number' || !Number.isSafeInteger(journal.pending) || journal.pending < 0 ||
        typeof journal.blocked !== 'number' || !Number.isSafeInteger(journal.blocked) || journal.blocked < 0 || journal.blocked > journal.pending) {
      throw new CmsDraftRequestError('Invalid Git history retry response');
    }
    return { pending: journal.pending, blocked: journal.blocked };
  }

  return { getState, publish, discard, retryDeployment, retryJournal };
}
