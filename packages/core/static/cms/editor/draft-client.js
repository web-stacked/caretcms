/**
 * @typedef {object} DraftState
 * @property {number} count
 * @property {boolean} canPublish
 * @property {boolean} retryRebuild
 * @property {DraftConflict[]} conflicts
 */
/**
 * A draft whose fields also changed on the site.
 * @typedef {object} DraftConflict
 * @property {string} collection
 * @property {string} id
 * @property {string} title
 * @property {boolean} removed
 * @property {{ field: string, label: string, mine: string, site: string }[]} fields
 * @property {string[]} body The editor's text for each body block that changed on the site.
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
      conflicts: (Array.isArray(data.conflicts) ? data.conflicts : []).map(record)
        .filter(conflict => typeof conflict.collection === 'string' && typeof conflict.id === 'string')
        .map(conflict => ({
          collection: String(conflict.collection),
          id: String(conflict.id),
          title: typeof conflict.title === 'string' ? conflict.title : '',
          removed: conflict.removed === true,
          body: (Array.isArray(conflict.body) ? conflict.body : []).filter(text => typeof text === 'string'),
          fields: (Array.isArray(conflict.fields) ? conflict.fields : []).map(record).map(field => ({
            field: String(field.field ?? ''),
            label: String(field.label ?? field.field ?? ''),
            mine: typeof field.mine === 'string' ? field.mine : '',
            site: typeof field.site === 'string' ? field.site : '',
          })),
        })),
    });
  }

  async function publish() {
    const response = await requireOk(await request('POST', '/publish', '{}'));
    return /** @type {unknown} */ (await response.json());
  }

  /** @param {string} collection @param {string} id @param {'mine' | 'site'} keep */
  async function resolveConflict(collection, id, keep) {
    await requireOk(await request('POST', '/draft', JSON.stringify({ collection, id, keep })));
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

  return { getState, publish, discard, resolveConflict, retryDeployment };
}
