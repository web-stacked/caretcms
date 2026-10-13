import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// Pack the actual distribution into a consumer outside the workspace. This
// catches missing exports/assets and dependency leakage hidden by workspace links.
const run = promisify(execFile);
const repo = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
const version = !process.argv[2] || process.argv[2] === "pinned"
  ? manifest.devDependencies.astro : process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Pass an exact Astro version");
// Use the adapter released with the 6.0 lower bound. Later 10.0.x imports
// getAbortControllerCleanup, which Astro 6.0.0 does not export.
const nodeAdapterVersion = version.startsWith("6.") ? "10.0.2"
  : JSON.parse(await readFile(join(repo, "examples/starter/package.json"), "utf8")).dependencies["@astrojs/node"];
const root = await mkdtemp(join(tmpdir(), "caret-consumer-"));
try {
  const packed = await run("npm", ["pack", "--workspace", "@caretcms/core", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: repo });
  const [{ filename }] = JSON.parse(packed.stdout);
  await cp(join(repo, "tests/fixtures/consumer"), root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "caret-release-consumer", private: true, type: "module",
    dependencies: { astro: version, "@astrojs/node": nodeAdapterVersion, "@caretcms/core": `file:./${filename}` },
  }, null, 2));
  console.log(`Testing packed @caretcms/core with Astro ${version}, Node ${process.version}`);
  const install = await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: root, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  if (install.stderr) process.stderr.write(install.stderr);
  // Separate processes avoid development module/env caches affecting the build.
  for (const [script, mode] of [["smoke.mjs", "development"], ["build-smoke.mjs", "production"], ["ssr-smoke.mjs", "production"]]) {
    const smoke = await run(process.execPath, [join(root, script)], {
      cwd: root, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NODE_ENV: mode, CARET_EDIT_PASSWORD: "consumer-fixture",
        CARET_SESSION_SECRET: randomBytes(32).toString("hex"),
        CARET_CONSUMER_SSR: script === "ssr-smoke.mjs" ? "1" : "0", ASTRO_TELEMETRY_DISABLED: "1" },
    });
    process.stdout.write(smoke.stdout);
    process.stderr.write(smoke.stderr);
  }
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  await rm(root, { recursive: true, force: true });
}
