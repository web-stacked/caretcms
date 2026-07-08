import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Owns the examples/starter dev server for the whole e2e run.
 *
 * Astro 7's `astro dev` is a managed BACKGROUND server (it daemonizes and
 * returns), so a Playwright `webServer` — which expects a foreground process and
 * kills it on teardown — can't reliably manage it: the daemon leaks past the run
 * and a later run reuses a stale build. Instead we start it here and stop it in
 * globalTeardown, both of which Playwright invokes as functions (not signals),
 * so the lifecycle is deterministic and leak-free. A stale daemon from a crashed
 * prior run is cleaned by the `astro dev stop` below before we start fresh.
 */
const PORT = process.env.E2E_PORT ?? "4399";
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const starterCwd = fileURLToPath(new URL("../../examples/starter/", import.meta.url));

export default async function globalSetup(): Promise<void> {
  // Clean slate: never serve a daemon left over from a previous (crashed) run.
  try {
    execFileSync("npx", ["astro", "dev", "stop"], { cwd: starterCwd, stdio: "ignore" });
  } catch {
    /* nothing running */
  }

  // The starter resolves @caretcms/core from its built dist.
  execFileSync("npm", ["run", "build:core"], { cwd: repoRoot, stdio: "inherit" });

  // Start a fresh background dev server with the editor password the specs use.
  execFileSync("npx", ["astro", "dev", "--background", "--host", "--port", PORT], {
    cwd: starterCwd,
    stdio: "inherit",
    env: { ...process.env, CARET_EDIT_PASSWORD: "e2e-secret" },
  });

  // Wait for it to respond before the specs run.
  const url = `http://localhost:${PORT}/`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`[e2e] starter dev server did not come up at ${url}`);
}
