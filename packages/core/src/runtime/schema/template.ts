/**
 * Build a default entry template from a JSON Schema.
 *
 * Used to seed initial data for new entries in dynamically-created
 * collections. Pure JSON-Schema → value mapping; no validation library
 * (schemas reach core as JSON Schema, e.g. via the caller's own
 * `z.toJSONSchema()`), so core stays Zod-agnostic.
 */

import type { CollectionSchema } from "../../types.js";

type JsonSchemaProperty = {
  type?: string;
  default?: unknown;
};

/**
 * Generate a default template from a JSON Schema.
 * Used to create initial data for new entries in dynamic collections.
 */
export function generateTemplateFromSchema(jsonSchema: CollectionSchema): Record<string, unknown> {
  const template: Record<string, unknown> = {};

  for (const [key, prop] of Object.entries(jsonSchema.properties)) {
    const p = prop as JsonSchemaProperty;

    if (p.default !== undefined) {
      template[key] = p.default;
    } else if (p.type === "string") {
      template[key] = "";
    } else if (p.type === "number" || p.type === "integer") {
      template[key] = 0;
    } else if (p.type === "boolean") {
      template[key] = false;
    } else if (p.type === "array") {
      template[key] = [];
    } else if (p.type === "object") {
      template[key] = {};
    }
  }

  return template;
}
