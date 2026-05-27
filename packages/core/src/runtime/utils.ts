/**
 * Shared deep-value helper used by bind and mutation engine.
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
