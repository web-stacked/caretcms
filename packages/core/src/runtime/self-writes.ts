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

const RELOAD_WAITERS = Symbol.for("caretcms.selfWriteReloadWaiters");

function reloadWaiters(): Set<() => void> {
  const scope = globalThis as typeof globalThis & { [RELOAD_WAITERS]?: Set<() => void> };
  return (scope[RELOAD_WAITERS] ??= new Set());
}

/**
 * Dev only: resolves once Astro has picked up CaretCMS's own writes (the
 * moment it would reload the page), or after `timeoutMs`. Publishing waits on
 * this so the editor's reload shows the published content, not the old one.
 * Call before writing, so the signal can't arrive first.
 */
export function waitForSelfWriteReload(timeoutMs: number): Promise<void> {
  return new Promise(done => {
    const waiters = reloadWaiters();
    const finish = () => { clearTimeout(timer); waiters.delete(finish); done(); };
    const timer = setTimeout(finish, timeoutMs);
    waiters.add(finish);
  });
}

/** Called by the dev server when it skips a reload caused by CaretCMS's writes. */
export function notifySelfWriteReload(): void {
  for (const finish of [...reloadWaiters()]) finish();
}
