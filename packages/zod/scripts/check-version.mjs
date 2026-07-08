#!/usr/bin/env node
/**
 * Refuses to publish if package.json version equals (or is older than) the
 * latest version on npm. Prevents accidentally re-publishing an already
 * released version under the same number.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

let publishedVersion = "";
try {
  publishedVersion = execSync(`npm view ${pkg.name} version`, { encoding: "utf8" }).trim();
} catch {
  // First publish — npm view fails when the package doesn't exist yet.
  process.exit(0);
}

if (!publishedVersion) process.exit(0);

function parse(version) {
  const [major, minor, patch] = version.split(".").map((n) => Number.parseInt(n, 10));
  return { major, minor, patch };
}

function isNewer(a, b) {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch > b.patch;
}

const local = parse(pkg.version);
const remote = parse(publishedVersion);

if (!isNewer(local, remote)) {
  console.error(
    `[31m[prepublishOnly] Refusing to publish: package.json version ${pkg.version} is not newer than npm latest ${publishedVersion}.[0m`,
  );
  console.error(`Bump the version in packages/zod/package.json before publishing.`);
  process.exit(1);
}

console.log(`[prepublishOnly] OK: ${pkg.version} > ${publishedVersion} on npm.`);
