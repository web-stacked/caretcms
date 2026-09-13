import type { CollectionStudioConfig } from "../types.js";

const FIELD_SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function publicationField(
  config: CollectionStudioConfig | null | undefined,
): string | null {
  if (!config?.publication) return null;
  const field = config.publication.field?.trim() || "published";
  return FIELD_SEGMENT_RE.test(field) ? field : null;
}

export function isPublicEntry(
  data: Record<string, unknown>,
  config: CollectionStudioConfig | null | undefined,
): boolean {
  const field = publicationField(config);
  return field === null || isPublishedEntry(data, field);
}

/**
 * Test the explicit boolean publication state used by a managed collection.
 * This is useful with Astro's native build-time collection APIs, which do not
 * pass through Caret's request-aware loaders.
 */
export function isPublishedEntry(
  data: Record<string, unknown>,
  field = "published",
): boolean {
  return data[field] === true;
}

function safeSameOriginPath(value: string): string | null {
  const path = value.trim();
  if (
    !path.startsWith("/")
    || path.startsWith("//")
    || path.includes("\\")
    || /[{}]/.test(path)
  ) return null;
  try {
    const url = new URL(path, "https://caretcms.invalid");
    if (url.origin !== "https://caretcms.invalid") return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function resolvePreviewPath(
  config: CollectionStudioConfig | null | undefined,
  id: string,
): string | null {
  const configured = config?.previewPath;
  const template = typeof configured === "string" ? configured : configured?.[id];
  if (typeof template !== "string") return null;
  return safeSameOriginPath(template.replaceAll("{id}", encodeURIComponent(id)));
}
