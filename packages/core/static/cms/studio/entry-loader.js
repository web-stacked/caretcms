import { templateFromSchema } from './field-model.js';

/** @typedef {import('../../../src/schema-utils.js').JsonSchemaNode} Schema */
/** @typedef {{ path: string, message: string }} ValidationIssue */
/**
 * @typedef {{
 *   kind: 'ready', data: Record<string, unknown>, revision: number, schema: Schema | null,
 *   validationIssues: ValidationIssue[], publicationFieldName: string | null,
 *   initialized: boolean,
 * } | { kind: 'missing', schema: Schema | null, publicationFieldName: string | null }
 * | { kind: 'unauthorized' }
 * | { kind: 'error', code: string }} EntryLoadResult
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

/** @param {unknown} value @returns {Schema | null} */
function schemaValue(value) {
  return isRecord(value) ? /** @type {Schema} */ (value) : null;
}

/** @param {{ apiBasePath: string, fetchImpl?: typeof fetch }} options */
export function createStudioEntryLoader({ apiBasePath, fetchImpl = fetch }) {
  /**
   * @param {{ collection: string, id: string, isNew?: boolean, initializeIfMissing?: boolean }} input
   * @returns {Promise<EntryLoadResult>}
   */
  async function load(input) {
    const entrySearch = new URLSearchParams({ collection: input.collection, id: input.id });
    const schemaSearch = new URLSearchParams({ collection: input.collection });
    const [entryResponse, schemaResponse] = await Promise.all([
      fetchImpl(`${apiBasePath}/entries?${entrySearch}`, { credentials: 'same-origin' }),
      fetchImpl(`${apiBasePath}/schema?${schemaSearch}`, { credentials: 'same-origin' }),
    ]);
    if (entryResponse.status === 401 || schemaResponse.status === 401) return { kind: 'unauthorized' };

    if (!entryResponse.ok) {
      const failure = await entryResponse.json().catch(() => null);
      return {
        kind: 'error',
        code: isRecord(failure) && typeof failure.code === 'string' ? failure.code : 'loadFailed',
      };
    }

    const entryBody = await entryResponse.json().catch(() => null);
    if (!isRecord(entryBody) || !Array.isArray(entryBody.entries)) {
      return { kind: 'error', code: 'loadFailed' };
    }
    const schemaBody = schemaResponse.ok
      ? await schemaResponse.json().catch(() => null)
      : null;
    const schema = isRecord(schemaBody) ? schemaValue(schemaBody.schema) : null;
    const metadata = isRecord(schemaBody) && isRecord(schemaBody.metadata) ? schemaBody.metadata : null;
    const publication = metadata && isRecord(metadata.publication) ? metadata.publication : null;
    const publicationFieldName = publication
      ? (typeof publication.field === 'string' ? publication.field : 'published')
      : null;

    const rawEntry = entryBody.entries[0];
    if (rawEntry !== undefined) {
      if (!isRecord(rawEntry) || !isRecord(rawEntry.data)) {
        return { kind: 'error', code: 'loadFailed' };
      }
      return {
        kind: 'ready',
        data: rawEntry.data,
        revision: typeof rawEntry.revision === 'number' ? rawEntry.revision : 0,
        schema,
        validationIssues: validationIssues(rawEntry.validationIssues),
        publicationFieldName,
        initialized: false,
      };
    }

    if (!input.isNew && !input.initializeIfMissing) {
      return { kind: 'missing', schema, publicationFieldName };
    }
    const template = isRecord(schemaBody) && isRecord(schemaBody.template)
      ? schemaBody.template
      : templateFromSchema(schema);
    if (!isRecord(template)) return { kind: 'error', code: 'loadFailed' };
    return {
      kind: 'ready', data: template, revision: 0, schema,
      validationIssues: [], publicationFieldName, initialized: true,
    };
  }

  return { load };
}
