import type { APIContext } from "astro";
import { isEditorAuthenticated } from "../auth/session.js";
import { getRegisteredSchema } from "../schema-registry.js";
import { inferJsonSchema, buildTemplate } from "../../schema-utils.js";
import { generateTemplateFromSchema } from "../schema/json-to-zod.js";
import { json, getAdapter } from "./_helpers.js";

export async function GET(context: APIContext): Promise<Response> {
  if (!isEditorAuthenticated(context)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const adapter = getAdapter();
  const collectionRaw = (context.url.searchParams.get("collection") ?? "")
    .trim()
    .toLowerCase();
  if (!(await adapter.isKnownCollection(collectionRaw))) {
    return json({ error: "Invalid collection" }, 400);
  }

  // 1. Check for explicit registered schema (from integration config)
  const registered = getRegisteredSchema(collectionRaw);
  if (registered) {
    return json({
      schema: registered.schema,
      template: registered.template,
      collection: collectionRaw,
      source: "explicit",
    });
  }

  // 2. Check for dynamic schema (from collection metadata)
  const metadata = await adapter.getCollectionMetadata(collectionRaw);
  if (metadata?.schema) {
    const template = generateTemplateFromSchema(metadata.schema);
    return json({
      schema: metadata.schema,
      template,
      collection: collectionRaw,
      source: "dynamic",
      metadata: {
        label: metadata.label,
        description: metadata.description,
        icon: metadata.icon,
        creatable: metadata.creatable,
        orderable: metadata.orderable,
      },
    });
  }

  // 3. Fall back to schema inference from first entry
  const entries = await adapter.listEntries(collectionRaw);
  const firstEntry = entries[0]?.data ?? {};

  const schema = inferJsonSchema(firstEntry);
  const template = buildTemplate(schema);

  return json({
    schema,
    template,
    collection: collectionRaw,
    source: "inferred",
    inferredFrom: entries.length > 0 ? entries[0].id : null,
  });
}
