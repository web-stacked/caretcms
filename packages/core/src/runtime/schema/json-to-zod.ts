/**
 * Runtime JSON Schema to Zod converter for dynamic collections.
 *
 * Converts JSON Schema objects (stored in collection metadata) to Zod schemas
 * that can be used for validation and type inference.
 */

import { z } from "zod";
import type { CollectionSchema } from "../../types.js";

type JsonSchemaProperty = {
  type?: string;
  format?: string;
  enum?: unknown[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  title?: string;
  description?: string;
  default?: unknown;
};

function convertProperty(prop: JsonSchemaProperty, isRequired: boolean): z.ZodTypeAny {
  let schema: z.ZodTypeAny;

  // Handle enum first
  if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
    const values = prop.enum as [string, ...string[]];
    schema = z.enum(values);
  }
  // Handle type
  else if (prop.type === "string") {
    let stringSchema = z.string();

    if (prop.format === "email") {
      stringSchema = stringSchema.email();
    } else if (prop.format === "url") {
      stringSchema = stringSchema.url();
    }

    if (typeof prop.minLength === "number" && prop.minLength > 0) {
      stringSchema = stringSchema.min(prop.minLength);
    }
    if (typeof prop.maxLength === "number") {
      stringSchema = stringSchema.max(prop.maxLength);
    }

    schema = stringSchema;
  } else if (prop.type === "number" || prop.type === "integer") {
    let numberSchema = z.number();

    if (prop.type === "integer") {
      numberSchema = numberSchema.int();
    }
    if (typeof prop.minimum === "number") {
      numberSchema = numberSchema.min(prop.minimum);
    }
    if (typeof prop.maximum === "number") {
      numberSchema = numberSchema.max(prop.maximum);
    }

    schema = numberSchema;
  } else if (prop.type === "boolean") {
    schema = z.boolean();
  } else if (prop.type === "array") {
    const itemSchema = prop.items ? convertProperty(prop.items, true) : z.any();
    schema = z.array(itemSchema);
  } else if (prop.type === "object") {
    if (prop.properties) {
      const shape: Record<string, z.ZodTypeAny> = {};
      const requiredFields = new Set(prop.required ?? []);

      for (const [key, value] of Object.entries(prop.properties)) {
        shape[key] = convertProperty(value, requiredFields.has(key));
      }

      schema = z.object(shape);
    } else {
      schema = z.record(z.string(), z.any());
    }
  } else {
    schema = z.any();
  }

  // Add metadata
  if (prop.title || prop.format) {
    const meta: Record<string, string> = {};
    if (prop.title) meta.title = prop.title;
    if (prop.format) meta.format = prop.format;
    schema = schema.meta(meta);
  }

  // Handle optional vs required
  if (!isRequired) {
    schema = schema.optional();
  }

  // Add default if present
  if (prop.default !== undefined && "default" in schema) {
    schema = (schema as z.ZodDefault<z.ZodTypeAny>).default(prop.default);
  }

  return schema;
}

/**
 * Convert a JSON Schema to a Zod schema.
 * Used to validate entries in dynamically-created collections.
 */
export function jsonSchemaToZod(jsonSchema: CollectionSchema): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(jsonSchema.required ?? []);

  for (const [key, prop] of Object.entries(jsonSchema.properties)) {
    shape[key] = convertProperty(prop as JsonSchemaProperty, required.has(key));
  }

  return z.object(shape);
}

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
