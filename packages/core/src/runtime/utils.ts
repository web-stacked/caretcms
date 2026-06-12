/**
 * Shared deep-value helpers used by the bind/mutation engine, the rewrite
 * engine, editable(), and the browser runtime. One definition of dot-path
 * semantics: object keys and numeric array indices both traverse (the getter
 * existed as three hand-rolled copies, one of which refused arrays — so
 * `items.0.title` resolved server-side but not in the cloud live-sync path).
 */

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function assertSafeKey(key: string): void {
  if (FORBIDDEN_KEYS.has(key)) {
    throw new Error(`Forbidden key in path: ${key}`);
  }
}

/** Set a deeply nested value by dot-path. Mutates `obj` in place. */
export function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  if (keys.length === 0) throw new Error("Invalid field path");
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    assertSafeKey(key);

    const next = current[key];
    if (typeof next !== "object" || next === null) {
      current[key] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    }
    current = current[key] as Record<string, unknown>;
  }

  const last = keys[keys.length - 1];
  assertSafeKey(last);
  current[last] = value;
}

/** Read a deeply nested value by dot-path (object keys + numeric array
 *  indices). Counterpart to setNestedValue. The prototype-polluting keys it
 *  refuses make reads fail soft (undefined) where writes fail loud. */
export function getNestedValue(data: unknown, path: string): unknown {
  if (!path) return data;
  let current: unknown = data;
  for (const key of path.split(".")) {
    if (FORBIDDEN_KEYS.has(key)) return undefined;
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
