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

export type JsonSchemaValidationIssue = {
  path: string;
  code: string;
  message: string;
};

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function resolveLocalRef(root: JsonSchemaNode, ref: string): JsonSchemaNode | null {
  if (!ref.startsWith("#/")) return null;
  let current: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === "object" && !Array.isArray(current)
    ? current as JsonSchemaNode
    : null;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Dependency-free validator for the JSON Schema subset Caret's Studio renders. */
export function validateJsonSchema(
  value: unknown,
  schema: JsonSchemaNode,
): JsonSchemaValidationIssue[] {
  const active = new WeakMap<JsonSchemaNode, Set<string>>();
  let visits = 0;
  const visit = (current: unknown, node: JsonSchemaNode, path: string, depth = 0): JsonSchemaValidationIssue[] => {
    if (++visits > 100_000) return [{ path, code: "invalid_schema", message: "Validation complexity limit exceeded" }];
    if (active.get(node)?.has(path)) return [{ path, code: "invalid_schema", message: "Cyclic schema reference" }];
    if (depth > 128) return [{ path, code: "invalid_schema", message: "Schema recursion limit exceeded" }];
    const paths = active.get(node) ?? new Set<string>();
    active.set(node, paths);
    paths.add(path);
    try {
      const issues: JsonSchemaValidationIssue[] = [];
      if (typeof node.$ref === "string") {
        const ref = resolveLocalRef(schema, node.$ref);
        if (!ref) return [{ path, code: "invalid_schema", message: "Unresolved schema reference" }];
        issues.push(...visit(current, ref, path, depth + 1));
      }
      if (Array.isArray(node.allOf)) {
        for (const child of node.allOf) {
          if (child && typeof child === "object" && !Array.isArray(child)) issues.push(...visit(current, child as JsonSchemaNode, path, depth + 1));
        }
      }
      for (const keyword of ["anyOf", "oneOf"] as const) {
        const alternatives = node[keyword];
        if (!Array.isArray(alternatives)) continue;
        const matches = alternatives.filter(candidate => candidate && typeof candidate === "object" && !Array.isArray(candidate)
          && visit(current, candidate as JsonSchemaNode, path, depth + 1).length === 0).length;
        if (matches === 0 || (keyword === "oneOf" && matches !== 1)) {
          issues.push({ path, code: "invalid_union", message: keyword === "oneOf" ? "Value must match exactly one allowed schema" : "Value does not match an allowed schema" });
        }
      }
      issues.push(...validateAgainst(current, node, path, depth));
      return issues;
    } finally { paths.delete(path); }
  };

  const validateAgainst = (
    current: unknown,
    node: JsonSchemaNode,
    path: string,
    depth: number,
  ): JsonSchemaValidationIssue[] => {
    const local: JsonSchemaValidationIssue[] = [];
    const allowedTypes = Array.isArray(node.type)
      ? node.type.filter((type): type is string => typeof type === "string")
      : typeof node.type === "string" ? [node.type] : [];
    const actual = valueType(current);
    const typeMatches = allowedTypes.length === 0
      || allowedTypes.includes(actual)
      || (actual === "integer" && allowedTypes.includes("number"));
    if (!typeMatches) {
      return [{ path, code: "invalid_type", message: `Expected ${allowedTypes.join(" or ")}, received ${actual}` }];
    }

    if (Array.isArray(node.enum) && !node.enum.some((candidate) => Object.is(candidate, current))) {
      local.push({ path, code: "invalid_enum_value", message: "Value is not one of the allowed options" });
    }
    if (Object.prototype.hasOwnProperty.call(node, "const") && !Object.is(node.const, current)) {
      local.push({ path, code: "invalid_literal", message: "Value does not match the required value" });
    }

    if (typeof current === "string") {
      if (typeof node.minLength === "number" && current.length < node.minLength) {
        local.push({ path, code: "too_small", message: `Must contain at least ${count(node.minLength, "character")}` });
      }
      if (typeof node.maxLength === "number" && current.length > node.maxLength) {
        local.push({ path, code: "too_big", message: `Must contain at most ${count(node.maxLength, "character")}` });
      }
      if (typeof node.pattern === "string") {
        try {
          if (!new RegExp(node.pattern).test(current)) {
            local.push({ path, code: "invalid_string", message: "Value has an invalid format" });
          }
        } catch { /* an invalid schema pattern is ignored rather than blocking writes */ }
      }
    }

    if (typeof current === "number") {
      if (node.type === "integer" && !Number.isInteger(current)) {
        local.push({ path, code: "invalid_type", message: "Expected an integer" });
      }
      if (typeof node.minimum === "number" && current < node.minimum) {
        local.push({ path, code: "too_small", message: `Must be at least ${node.minimum}` });
      }
      if (typeof node.maximum === "number" && current > node.maximum) {
        local.push({ path, code: "too_big", message: `Must be at most ${node.maximum}` });
      }
      if (typeof node.exclusiveMinimum === "number" && current <= node.exclusiveMinimum) {
        local.push({ path, code: "too_small", message: `Must be greater than ${node.exclusiveMinimum}` });
      }
      if (typeof node.exclusiveMaximum === "number" && current >= node.exclusiveMaximum) {
        local.push({ path, code: "too_big", message: `Must be less than ${node.exclusiveMaximum}` });
      }
    }

    if (Array.isArray(current)) {
      if (typeof node.minItems === "number" && current.length < node.minItems) {
        local.push({ path, code: "too_small", message: `Must contain at least ${count(node.minItems, "item")}` });
      }
      if (typeof node.maxItems === "number" && current.length > node.maxItems) {
        local.push({ path, code: "too_big", message: `Must contain at most ${count(node.maxItems, "item")}` });
      }
      if (node.items && typeof node.items === "object" && !Array.isArray(node.items)) {
        current.forEach((item, index) => local.push(...visit(item, node.items as JsonSchemaNode, path ? `${path}.${index}` : String(index), depth + 1)));
      }
    }

    if (current && typeof current === "object" && !Array.isArray(current)) {
      const record = current as Record<string, unknown>;
      for (const required of node.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(record, required)) {
          local.push({
            path: path ? `${path}.${required}` : required,
            code: "required",
            message: "Required field is missing",
          });
        }
      }
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        if (Object.prototype.hasOwnProperty.call(record, key)) {
          local.push(...visit(record[key], child, path ? `${path}.${key}` : key, depth + 1));
        }
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (!Object.prototype.hasOwnProperty.call(node.properties ?? {}, key)) {
            local.push({
              path: path ? `${path}.${key}` : key,
              code: "unrecognized_key",
              message: "Unknown field",
            });
          }
        }
      }
    }
    return local;
  };

  return visit(value, schema, "");
}

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
