import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const REQUIRED = {
  devDependencies: {
    astro: '7.2.4',
    '@tailwindcss/vite': '4.3.2',
    tailwindcss: '4.3.2',
    typescript: '6.0.3',
    vitest: '4.1.10',
  },
};

const RANGE_RE = /^[~^<>*=]|(?:\s\|\|\s)|(?:\sx\s)|(?:\*)/;
const errors = [];

function assertDepGroup(groupName, expected) {
  const actual = pkg[groupName] ?? {};
  for (const [name, version] of Object.entries(expected)) {
    const found = actual[name];
    if (!found) {
      errors.push(`Missing ${groupName}.${name}`);
      continue;
    }
    if (RANGE_RE.test(found)) {
      errors.push(`${groupName}.${name} uses range "${found}" (must be exact)`);
    }
    if (found !== version) {
      errors.push(`${groupName}.${name} is "${found}" (expected "${version}")`);
    }
  }
}

assertDepGroup('devDependencies', REQUIRED.devDependencies);

// --- Cross-package (@caretcms/*) lockstep -----------------------------------
// The internal packages reference each other by caret range (e.g. cloudflare
// peers `@caretcms/core: ^0.1.1`). Those versions are hand-managed, so a core
// bump to a new minor/major can silently leave a peer range unsatisfiable with
// nothing else in CI to catch it. Verify every internal ref is satisfied by the
// referenced package's CURRENT local version.
function parseVersion(v) {
  const [major, minor, patch] = String(v).split('-')[0].split('.').map((n) => Number.parseInt(n, 10));
  return { major, minor, patch };
}

// Minimal caret-range satisfaction (all internal ranges use `^`).
function caretSatisfies(range, version) {
  if (!range.startsWith('^')) return true; // only guard caret ranges
  const base = parseVersion(range.slice(1));
  const v = parseVersion(version);
  if ([base.major, base.minor, base.patch, v.major, v.minor, v.patch].some(Number.isNaN)) return true;
  const gte =
    v.major > base.major ||
    (v.major === base.major && (v.minor > base.minor || (v.minor === base.minor && v.patch >= base.patch)));
  if (!gte) return false;
  if (base.major > 0) return v.major === base.major;
  if (base.minor > 0) return v.major === 0 && v.minor === base.minor;
  return v.major === 0 && v.minor === 0 && v.patch === base.patch;
}

const packagesDir = path.join(root, 'packages');
const localVersions = {};
const manifests = [];
if (fs.existsSync(packagesDir)) {
  for (const dir of fs.readdirSync(packagesDir)) {
    const manifestPath = path.join(packagesDir, dir, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    localVersions[manifest.name] = manifest.version;
    manifests.push({ dir, manifest });
  }
}

for (const { dir, manifest } of manifests) {
  for (const group of ['dependencies', 'peerDependencies']) {
    const deps = manifest[group] ?? {};
    for (const [name, range] of Object.entries(deps)) {
      if (!name.startsWith('@caretcms/')) continue;
      const localVersion = localVersions[name];
      if (!localVersion) continue; // external / not in this monorepo
      if (!caretSatisfies(range, localVersion)) {
        errors.push(
          `packages/${dir} ${group}.${name} "${range}" is not satisfied by local ${name}@${localVersion} — bump the range`,
        );
      }
    }
  }
}

if (errors.length > 0) {
  console.error('Version policy check failed:');
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}

console.log('Version policy check passed.');
