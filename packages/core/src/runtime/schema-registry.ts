/**
 * Schema registry for explicit Zod-derived JSON Schemas.
 *
 * When the user passes `schemas` in caret() options, the integration
 * serializes them and injects them into a virtual module. The schema API
 * route reads from this registry and falls back to inference only when
 * no explicit schema is registered for a collection.
 */

import type { JsonSchemaNode } from "../schema-utils.js";

type CollectionSchemaEntry = {
  schema: JsonSchemaNode;
  template: Record<string, unknown> | null;
};

const registry = new Map<string, CollectionSchemaEntry>();

export function registerCollectionSchema(
  collection: string,
  jsonSchema: JsonSchemaNode,
  template: Record<string, unknown> | null,
): void {
  registry.set(collection, { schema: jsonSchema, template });
}

export function getRegisteredSchema(
  collection: string,
): CollectionSchemaEntry | null {
  return registry.get(collection) ?? null;
}

