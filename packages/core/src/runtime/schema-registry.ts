/**
 * Schema registry for explicit Zod-derived JSON Schemas.
 *
 * When the user passes `schemas` in caret() options, the integration
 * serializes them and injects them into a virtual module. The schema API
 * route reads from this registry and falls back to inference only when
 * no explicit schema is registered for a collection.
 */

import type { JsonSchemaNode } from "../schema-utils.js";
import type { CollectionStudioConfig, StorageAdapter } from "../types.js";

type CollectionSchemaEntry = {
  schema: JsonSchemaNode;
  template: Record<string, unknown> | null;
  metadata?: CollectionStudioConfig;
};

type SchemaRegistryState = {
  schemas: Map<string, CollectionSchemaEntry>;
  studioConfigs: Map<string, CollectionStudioConfig>;
};

// The virtual schema module and runtime routes can be loaded through different
// Vite module graphs in Astro dev. A namespaced global registry preserves their
// shared identity across dependency-optimization reloads.
const schemaRegistryKey = Symbol.for("@caretcms/core/schema-registry");
const globalSlots = globalThis as typeof globalThis & Record<symbol, unknown>;
const state = (globalSlots[schemaRegistryKey] ??= {
  schemas: new Map<string, CollectionSchemaEntry>(),
  studioConfigs: new Map<string, CollectionStudioConfig>(),
}) as SchemaRegistryState;
const registry = state.schemas;
const studioConfigRegistry = state.studioConfigs;

export function registerCollectionSchema(
  collection: string,
  jsonSchema: JsonSchemaNode,
  template: Record<string, unknown> | null,
  metadata?: CollectionStudioConfig,
): void {
  registry.set(collection, { schema: jsonSchema, template, metadata });
  if (metadata) studioConfigRegistry.set(collection, metadata);
}

export function registerCollectionStudioConfig(
  collection: string,
  metadata: CollectionStudioConfig,
): void {
  studioConfigRegistry.set(collection, metadata);
}

export function getRegisteredSchema(
  collection: string,
): CollectionSchemaEntry | null {
  return registry.get(collection) ?? null;
}

export function getRegisteredCollectionNames(): string[] {
  return [...new Set([...registry.keys(), ...studioConfigRegistry.keys()])].sort();
}

export async function getStudioCollectionNames(
  adapter: StorageAdapter,
): Promise<string[]> {
  return [...new Set([
    ...(await adapter.discoverCollections()),
    ...getRegisteredCollectionNames(),
  ])].sort();
}

export async function getStudioCollections(
  adapter: StorageAdapter,
): Promise<Array<{ name: string; config: CollectionStudioConfig }>> {
  const collections = await Promise.all((await getStudioCollectionNames(adapter)).map(async (name) => ({
    name,
    config: await resolveCollectionStudioConfig(adapter, name),
  })));
  return collections.sort((a, b) =>
    (a.config.order ?? 0) - (b.config.order ?? 0)
    || (a.config.label ?? a.name).localeCompare(b.config.label ?? b.name),
  );
}

export async function isKnownStudioCollection(
  adapter: StorageAdapter,
  collection: string,
): Promise<boolean> {
  return registry.has(collection)
    || studioConfigRegistry.has(collection)
    || adapter.isKnownCollection(collection);
}

export async function resolveCollectionStudioConfig(
  adapter: StorageAdapter,
  collection: string,
): Promise<CollectionStudioConfig> {
  const dynamic = await adapter.getCollectionMetadata(collection);
  const registered = studioConfigRegistry.get(collection);
  return {
    label: dynamic?.label,
    entryLabel: dynamic?.entryLabel,
    description: dynamic?.description,
    icon: dynamic?.icon,
    titleField: dynamic?.titleField,
    thumbnailField: dynamic?.thumbnailField,
    subtitleField: dynamic?.subtitleField,
    order: dynamic?.order,
    creatable: dynamic?.creatable,
    orderable: dynamic?.orderable,
    deletable: dynamic?.deletable,
    singletonId: dynamic?.singletonId,
    previewPath: dynamic?.previewPath,
    publication: dynamic?.publication,
    ...registered,
  };
}
