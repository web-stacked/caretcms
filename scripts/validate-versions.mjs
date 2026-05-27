import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const REQUIRED = {
  devDependencies: {
    astro: '6.1.8',
    '@tailwindcss/vite': '4.2.4',
    tailwindcss: '4.2.4',
    typescript: '5.9.3',
    vitest: '4.1.5',
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

if (errors.length > 0) {
  console.error('Version policy check failed:');
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}

console.log('Version policy check passed.');
