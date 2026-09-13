/** Stateless Studio schema defaults and field presentation helpers. */
/** @typedef {import('../../../src/schema-utils.js').JsonSchemaNode} Schema */

/** @template T @param {T} v @returns {T} */
export function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

/** @param {Schema | null | undefined} schema @returns {unknown} */
export function templateFromSchema(schema) {
  if (!schema || typeof schema !== "object") return "";
  if (schema.default !== undefined) return deepClone(schema.default);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return deepClone(schema.enum[0]);
  if (schema.type === "object") {
    /** @type {Record<string, unknown>} */
    var objectTemplate = {};
    Object.keys(schema.properties || {}).forEach(function (key) {
      objectTemplate[key] = templateFromSchema(schema.properties?.[key]);
    });
    return objectTemplate;
  }
  if (schema.type === "array") return [];
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer") {
    return typeof schema.minimum === "number" ? schema.minimum : 0;
  }
  return "";
}

/** @param {string} path @param {number} index @returns {string} */
export function generatedId(path, index) {
  var parts = path.split(".").filter(Boolean);
  var key = parts.pop() || "item";
  if (/^\d+$/.test(key)) key = parts.pop() || "item";
  key = key.replace(/ies$/, "y").replace(/s$/, "");
  return (key + "-" + (index + 1) + "-" + Date.now().toString(36))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** @param {string} filename @returns {string} */
export function friendlyFileTitle(filename) {
  return String(filename || "Image")
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, function (c) { return c.toUpperCase(); }) || "Image";
}

/** @param {string} path @returns {string} */
export function singularItemLabel(path) {
  var key = (path.split(".").filter(Boolean).pop() || "item").toLowerCase();
  if (key === "images") return "image";
  if (key === "details") return "detail";
  if (key === "documents") return "document";
  if (key === "videos") return "video";
  if (key === "links") return "link";
  if (key === "resume") return "résumé item";
  return key.replace(/ies$/, "y").replace(/s$/, "") || "item";
}

/** @param {Record<string, unknown> | null | undefined} data @returns {string} */
export function getTitle(data) {
  if (!data) return "Untitled";
  var keys = ["name", "title", "question", "company_name", "headline", "label"];
  for (var i = 0; i < keys.length; i++) {
    const value = data[keys[i]];
    if (typeof value === "string" && value) return value;
  }
  return "Untitled";
}

/** @param {string} key @returns {string} */
export function humanizeKey(key) {
  return key.replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

/** @param {string} path @returns {string} */
export function fieldIdFromPath(path) {
  return "caret-field-" + String(path || "").replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** @param {unknown} data @param {string} path @returns {unknown} */
export function getNestedValue(data, path) {
  return path.split(".").reduce(function (value, key) {
    if (value === null || typeof value !== "object") return undefined;
    return /** @type {Record<string, unknown>} */ (value)[key];
  }, data);
}

/**
 * @param {Record<string, unknown>} data
 * @param {string} path
 * @param {unknown} value
 */
export function setNestedValue(data, path, value) {
  var keys = path.split(".");
  /** @type {Record<string, unknown>} */
  var target = data;
  for (var i = 0; i < keys.length - 1; i++) {
    var key = keys[i];
    var next = target[key];
    if (next === null || typeof next !== "object") {
      next = /^\d+$/.test(keys[i + 1]) ? [] : {};
      target[key] = next;
    }
    target = /** @type {Record<string, unknown>} */ (next);
  }
  target[keys[keys.length - 1]] = value;
}
