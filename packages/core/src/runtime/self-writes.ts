import { resolve } from "node:path";

/**
 * Files CaretCMS wrote itself, so the dev server can tell an editor's save
 * from a developer's edit. Kept on `globalThis` because Astro evaluates the
 * runtime (which writes) separately from the integration (which serves dev).
 */
const REGISTRY = Symbol.for("caretcms.selfWrites");
const WINDOW_MS = 5_000;

function registry(): Map<string, number> {
  const scope = globalThis as typeof globalThis & { [REGISTRY]?: Map<string, number> };
  return (scope[REGISTRY] ??= new Map());
}

export function recordSelfWrite(path: string): void {
  const writes = registry();
  const now = Date.now();
  for (const [file, at] of writes) if (now - at > WINDOW_MS) writes.delete(file);
  writes.set(resolve(path), now);
}

export function isSelfWrite(path: string): boolean {
  const at = registry().get(resolve(path));
  return at !== undefined && Date.now() - at <= WINDOW_MS;
}
