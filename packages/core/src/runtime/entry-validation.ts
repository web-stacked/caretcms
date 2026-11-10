import type { StorageAdapter } from "../types.js";
import { validateJsonSchema, type JsonSchemaNode, type JsonSchemaValidationIssue } from "../schema-utils.js";
import { getRegisteredSchema, resolveCollectionStudioConfig } from "./schema-registry.js";
import { stripBodyOverlay } from "./utils.js";
import { publicationField } from "./collection-policy.js";

export class EntryValidationError extends Error {
  constructor(readonly issues: JsonSchemaValidationIssue[]) {
    super("Entry does not match current collection requirements");
  }
}

/** Validate final public content before a new transition starts. Deletion has no fields. */
export async function validateEntryTransition(
  adapter: StorageAdapter, collection: string, data: Record<string, unknown> | null,
): Promise<JsonSchemaValidationIssue[]> {
  if (data === null) return [];
  data = stripBodyOverlay(data);
  const schema = getRegisteredSchema(collection)?.schema ??
    (await adapter.getCollectionMetadata(collection))?.schema as JsonSchemaNode | undefined;
  const issues = schema ? validateJsonSchema(data, schema) : [];
  const field = publicationField(await resolveCollectionStudioConfig(adapter, collection));
  if (field && typeof data[field] !== "boolean") {
    issues.push({ path: field, code: "invalid_type", message: `Managed publication field "${field}" must be a boolean` });
  }
  return issues;
}
