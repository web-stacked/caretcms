/**
 * @caretcms/zod — derive CaretCMS Studio schemas from your Zod content-collection schemas.
 *
 * CaretCMS's Studio consumes plain JSON Schema, and `@caretcms/core` stays
 * deliberately Zod-agnostic (zero runtime deps). If you already describe a
 * content collection with Zod (Astro's `content.config.ts`), this helper turns
 * that ONE source into the JSON-Schema map you hand to `caret({ schemas })` — so
 * field definitions, labels, and widget hints live in a single place instead of
 * being duplicated in a hand-written `caret.schemas` file.
 *
 *   import { schemasFromZod } from "@caretcms/zod";
 *   caret({ schemas: schemasFromZod({ blog: blogSchema, page: pageSchema }) });
 *
 * Requires Zod v4 (uses `z.toJSONSchema`). Zod is a PEER dependency; nothing here
 * is imported by `@caretcms/core`, preserving its Zod-agnostic boundary.
 */
import { z } from "zod";

/** A JSON Schema object node. Structurally what core's `CollectionSchema`
 *  expects: `{ type: "object", properties: { ... } }`. */
export type JsonSchema = Record<string, unknown>;

export interface DeriveOptions {
  /** Extra per-node tweaks, applied AFTER the built-in date handling. Use this to
   *  map project-specific Zod shapes to CaretCMS widget `format` hints. */
  override?: (ctx: { zodSchema: unknown; jsonSchema: JsonSchema }) => void;
}

function isObjectSchema(node: JsonSchema): boolean {
  return node.type === "object" && typeof node.properties === "object" && node.properties !== null;
}

/**
 * Promote Zod `description` → JSON Schema `title` (the Studio renders `title` as
 * the field label). Recurses into nested object properties and array items.
 * Non-destructive: an explicit `title` wins, and `description` is left intact.
 */
function promoteTitles(node: JsonSchema): void {
  if (!node || typeof node !== "object") return;
  if (typeof node.description === "string" && typeof node.title !== "string") {
    node.title = node.description;
  }
  const props = node.properties as Record<string, JsonSchema> | undefined;
  if (props && typeof props === "object") {
    for (const child of Object.values(props)) promoteTitles(child);
  }
  const items = node.items as JsonSchema | undefined;
  if (items && typeof items === "object") promoteTitles(items);
}

/**
 * Convert ONE Zod object schema into a CaretCMS-ready JSON Schema.
 *
 * Bridges the gaps a raw `z.toJSONSchema` leaves for the Studio:
 *  - `z.date()` / `z.coerce.date()` → `{ type: "string", format: "date" }`.
 *    (Raw conversion throws "Date cannot be represented in JSON Schema" — the
 *    stored value is an ISO string, so a string with a date widget is correct.)
 *  - `description` → `title`, so each field gets a friendly label.
 *  - Custom widget hints (`image`, `html`, …) travel via `.meta({ format: "…" })`.
 *
 * Throws if the schema is not a Zod object — a collection schema must be an object.
 */
export function schemaFromZod(schema: z.ZodType, options: DeriveOptions = {}): JsonSchema {
  const json = z.toJSONSchema(schema, {
    unrepresentable: "any",
    io: "input",
    override: (ctx) => {
      const def = (ctx.zodSchema as { _zod?: { def?: { type?: string } } })?._zod?.def;
      if (def?.type === "date") {
        ctx.jsonSchema.type = "string";
        ctx.jsonSchema.format = "date";
      }
      options.override?.(ctx as { zodSchema: unknown; jsonSchema: JsonSchema });
    },
  }) as JsonSchema;

  delete json.$schema;
  promoteTitles(json);

  if (!isObjectSchema(json)) {
    throw new Error(
      "@caretcms/zod: each collection schema must be a Zod object (z.object({ ... })).",
    );
  }
  return json;
}

/**
 * Convert a map of `collectionName -> Zod object schema` into the
 * `Record<string, JsonSchema>` you pass to `caret({ schemas })`.
 */
export function schemasFromZod(
  schemas: Record<string, z.ZodType>,
  options: DeriveOptions = {},
): Record<string, JsonSchema> {
  const out: Record<string, JsonSchema> = {};
  for (const [collection, schema] of Object.entries(schemas)) {
    out[collection] = schemaFromZod(schema, options);
  }
  return out;
}
