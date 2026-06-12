/**
 * Shared schema utility functions used by both the schema route and the
 * virtual schemas module to build default templates from JSON Schema.
 */

export type JsonSchemaNode = {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  enum?: unknown[];
  required?: string[];
  default?: unknown;
  [key: string]: unknown;
};

export function inferJsonSchema(value: unknown): JsonSchemaNode {
  if (value === null || value === undefined) {
    return { type: "string", default: "" };
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { type: "array", items: { type: "string" }, default: [] };
    }
    return { type: "array", items: inferJsonSchema(value[0]), default: [] };
  }

  if (typeof value === "object") {
    const properties: Record<string, JsonSchemaNode> = {};
    const required: string[] = [];
    Object.entries(value as Record<string, unknown>).forEach(([key, nested]) => {
      properties[key] = inferJsonSchema(nested);
      required.push(key);
    });
    return { type: "object", properties, required };
  }

  if (typeof value === "string") return { type: "string", default: "" };
  if (typeof value === "number") return { type: "number", default: 0 };
  if (typeof value === "boolean") return { type: "boolean", default: false };
  return { type: "string", default: "" };
}

export function buildTemplate(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const normalized = schema as JsonSchemaNode;
  if (normalized.default !== undefined) return normalized.default as Record<string, unknown> | null;

  switch (normalized.type) {
    case "object": {
      const obj: Record<string, unknown> = {};
      if (normalized.properties) {
        Object.entries(normalized.properties).forEach(([key, prop]) => {
          obj[key] = buildTemplate(prop);
        });
      }
      return obj;
    }
    case "array":
      return [] as unknown as Record<string, unknown>;
    case "string":
      if (normalized.enum && normalized.enum.length > 0) return normalized.enum[0] as Record<string, unknown> | null;
      return "" as unknown as Record<string, unknown>;
    case "number":
    case "integer":
      return 0 as unknown as Record<string, unknown>;
    case "boolean":
      return false as unknown as Record<string, unknown>;
    default:
      return null;
  }
}
