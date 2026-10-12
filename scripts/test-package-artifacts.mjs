// Install all published packages outside the workspace and exercise their
// real tarballs. No publishing or changes to package versions/lockfiles.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, cp, rm, realpath, stat, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("../", import.meta.url));
const root = await realpath(await mkdtemp(join(tmpdir(), "caret-package-artifacts-")));
const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
const packages = ["core", "cloudflare", "caretize", "zod"];
const dependencies = { astro: manifest.devDependencies.astro, typescript: manifest.devDependencies.typescript,
  zod: JSON.parse(await readFile(join(repo, "packages/zod/package.json"), "utf8")).devDependencies.zod,
  "@types/node": JSON.parse(await readFile(join(repo, "packages/core/package.json"), "utf8")).devDependencies["@types/node"] };
let runtime;

try {
  for (const name of packages) {
    const { stdout } = await run("npm", ["pack", "--workspace", `@caretcms/${name}`, "--ignore-scripts", "--json", "--pack-destination", root],
      { cwd: repo, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    const [packed] = JSON.parse(stdout);
    const files = new Set(packed.files.map(file => file.path));
    assert.ok(files.has("LICENSE"), `${name}: MIT license missing`);
    assert.ok(files.has("README.md"), `${name}: README missing`);
    for (const file of files) assert.ok(!/^(?:tests|examples|node_modules|\.caret|\.caretcms)\//.test(file), `${name}: unexpected payload ${file}`);
    // Source and declaration maps must resolve to sources shipped in the package.
    for (const file of files) {
      if (!file.endsWith(".map")) continue;
      const map = JSON.parse(await readFile(join(repo, "packages", name, file), "utf8"));
      for (const source of map.sources) {
        const shipped = posix.normalize(posix.join(posix.dirname(file), source));
        assert.ok(files.has(shipped), `${name}: ${file} points to unshipped ${shipped}`);
      }
    }
    dependencies[`@caretcms/${name}`] = `file:./${packed.filename}`;
    console.log(`Packed ${packed.name}: ${packed.files.length} files, ${packed.size} bytes.`);
  }
  await cp(join(repo, "tests/fixtures/package-artifacts"), root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "caret-artifact-consumer", private: true, type: "module", dependencies }));
  await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: root, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  const imports = [];
  for (const name of packages) {
    const installed = join(root, "node_modules/@caretcms", name);
    assert.ok(!relative(root, await realpath(installed)).startsWith(".."), `${name}: resolved outside consumer`);
    const pkg = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    if (name === "core") assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
    if (name === "caretize") assert.ok(!pkg.dependencies?.["@caretcms/core"]);
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      for (const key of ["types", "import"]) assert.ok((await stat(join(installed, target[key]))).isFile(), `${name}${subpath}: missing ${key}`);
      const specifier = pkg.name + (subpath === "." ? "" : subpath.slice(1));
      imports.push(`import * as exported${imports.length} from ${JSON.stringify(specifier)};\nvoid exported${imports.length};`);
    }
  }
  await writeFile(join(root, "exports.ts"), imports.join("\n"));
  await run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
    { cwd: root, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  console.log(`All ${imports.length} exported entrypoints resolve from installed tarballs and typecheck in a strict consumer.`);
  const { stdout } = await run(process.execPath, [join(root, "smoke.mjs")], { cwd: root, timeout: 60_000 });
  process.stdout.write(stdout);
  const cli = join(root, "node_modules/.bin/caretize");
  assert.ok((await stat(cli)).mode & 0o111, "Installed CLI lacks executable permissions");
  const core = join(root, "node_modules/@caretcms/core");
  const hidden = join(root, "hidden-core");
  await rename(core, hidden);
  try {
    const help = await run(cli, ["--help"], { cwd: root, timeout: 30_000 });
    assert.match(help.stdout, /caretize/i);
    const standalone = await run(process.execPath, [join(root, "caretize.mjs")], { cwd: root, timeout: 30_000 });
    process.stdout.write(standalone.stdout);
  } finally { await rename(hidden, core); }
  console.log("Installed caretize executable starts with core unavailable and no workspace links.");

  const require = createRequire(import.meta.url);
  const wrangler = createRequire(require.resolve("wrangler/package.json"));
  const { build } = wrangler("esbuild");
  const { Miniflare, convertV4MiniflareOptions } = wrangler("miniflare");
  await build({ entryPoints: [join(root, "browser.mjs")], bundle: true, outdir: join(root, "browser-dist"),
    platform: "browser", format: "esm", logLevel: "silent" });
  console.log("Installed browser and editor JS/CSS entrypoints bundle successfully.");
  const worker = await build({ entryPoints: [join(root, "worker.mjs")], bundle: true, write: false,
    platform: "neutral", format: "esm", target: "esnext", conditions: ["import"],
    external: ["cloudflare:workers", "node:*"], logLevel: "silent",
    define: { "import.meta.glob": "__caretArtifactGlob" }, banner: { js: "const __caretArtifactGlob = () => ({});" },
    plugins: [{ name: "unused-astro-virtuals", setup(builder) {
      // Standalone adapter checks have no configured Astro provider/schema;
      // normal Astro injection is covered by the SSR/consumer gates.
      builder.onResolve({ filter: /^virtual:caretcms\/(?:providers|schemas)$/ }, args => ({ path: args.path, namespace: "caret-virtual" }));
      builder.onLoad({ filter: /.*/, namespace: "caret-virtual" }, () => ({ contents: "export {};", loader: "js" }));
    } }] });
  runtime = new Miniflare(convertV4MiniflareOptions({ name: "caret-artifact-worker", modules: true, script: worker.outputFiles[0].text,
    compatibilityDate: "2026-01-01", compatibilityFlags: ["nodejs_compat"], cf: false, host: "127.0.0.1", port: 0,
    resourcePersistencePath: join(root, "persist"), durableObjects: { CMS_CONTENT: { className: "CaretCmsContent", useSQLite: true } },
    kvNamespaces: ["CMS_KV"], r2Buckets: ["CMS_R2"] }));
  await runtime.ready;
  const response = await runtime.dispatchFetch("https://artifacts.test/");
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  for (const [provider, results] of Object.entries(data.conformance)) {
    assert.ok(results.length > 0);
    assert.deepEqual(results.filter(result => result.status === "failed"), [], JSON.stringify(results));
    console.log(`Packed ${provider}: ${results.filter(result => result.status === "passed").length} conformance checks pass; ${results.filter(result => result.status === "skipped").length} explicit skips.`);
  }
  assert.equal(data.upload, true);
  assert.equal(data.contentType, "image/png");
  console.log("Packed R2 handler uploads bytes through the native R2 binding.");
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  try { await runtime?.dispose(); } finally { await rm(root, { recursive: true, force: true }); }
}
