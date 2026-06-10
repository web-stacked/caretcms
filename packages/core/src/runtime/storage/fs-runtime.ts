/**
 * Runtime guard shared by every filesystem-backed StorageAdapter. Filesystem
 * storage cannot work on edge runtimes (no fs); failing fast in the adapter
 * constructor turns silently-empty reads and cryptic write errors into one
 * actionable message.
 */

/** workerd (incl. Astro 6's dev server) sets navigator.userAgent to this. */
const WORKERD_USER_AGENT = "Cloudflare-Workers";

/**
 * Return a human-readable runtime name if filesystem storage cannot work here,
 * or null when a real Node filesystem is available.
 *
 * Astro 6's dev server runs on the same workerd runtime as production, so a
 * Workers-targeted project has no filesystem in dev *or* prod.
 */
function detectUnsupportedRuntime(): string | null {
  const g = globalThis as { navigator?: { userAgent?: string }; WebSocketPair?: unknown };
  // navigator.userAgent === "Cloudflare-Workers" only when the `global_navigator`
  // compat flag is on, so also check WebSocketPair — a workerd global present
  // regardless of compat flags — to detect Workers even on an old compat date.
  if (g.navigator?.userAgent === WORKERD_USER_AGENT || typeof g.WebSocketPair === "function") {
    return "Cloudflare Workers (workerd)";
  }
  if (typeof process === "undefined" || typeof process.cwd !== "function") {
    return "a non-Node runtime";
  }
  return null;
}

export function assertFilesystemRuntime(): void {
  const runtime = detectUnsupportedRuntime();
  if (!runtime) return;
  throw new Error(
    `[caretcms] Filesystem storage is not available on ${runtime}.\n` +
      `Astro 6's dev server also runs on workerd, so this fails in dev as well as production.\n\n` +
      `Targeting Cloudflare Workers? Use the KV adapter from @caretcms/cloudflare in BOTH dev and prod:\n\n` +
      `  import { cloudflareStorage } from '@caretcms/cloudflare';\n` +
      `  // caret({ storage: cloudflareStorage(), ... })\n\n` +
      `Targeting a Node host? Filesystem storage works there — make sure you are not building for an edge runtime.`,
  );
}
