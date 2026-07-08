# CaretCMS — Core (open-core monorepo)

**Public**, MIT-licensed. The CaretCMS engine: an Astro integration that adds inline
editing + a content Studio to any Astro site, with pluggable storage/upload adapters.
Distributed via npm under the `@caretcms/` scope. v0.1.0 (bootstrap release,
embedded mode; cloud mode is alpha).

## Packages
- **`packages/core`** → `@caretcms/core` (published). The integration + runtime.
  `@caretcms/core/contracts` exposes the shared contract surface (id grammar,
  rewrite tag allowlist, rich allowlist).
- **`packages/cloudflare`** → `@caretcms/cloudflare` (published). KV storage + R2
  upload adapters. Depends on core via interfaces + the contracts subpath only.
- **`packages/caretize`** → `@caretcms/caretize` (published). CLI that scans an
  Astro project and inserts `data-caret` attributes. Deliberately has NO core
  dependency — it mirrors core's contracts as copies, held byte-identical by
  `tests/unit/contracts-parity.test.ts`.
- **`packages/zod`** → `@caretcms/zod` (published). Optional Zod→JSON-Schema
  bridge for `caret({ schemas })`; zod is a peer dep. Core stays Zod-agnostic.
- **`examples/*`** (private): `starter` (Node + filesystem, the E2E target),
  `content-site` (editorial showcase), `demo` (Cloudflare KV/R2 deployment).

## Stack
Astro 7.0.6 (peer `^6.0.0 || ^7.0.0`) · TypeScript 6.0.3 (strict, NodeNext, ES2022) ·
Tailwind 4.3.2 · Vitest 4.1.10 · Playwright `^1.61` · fast-check `^4`
(property-based) · npm workspaces. Node `>=22.12.0` (Astro 7 dropped Node 20). Vite 8
via root `overrides` (Astro 7 requires it). Note: Astro 7's `astro dev` is a managed
**background** server (daemonizes); the e2e harness wraps it — see
`scripts/e2e-serve-starter.mjs`. Core has no runtime deps — schemas arrive as JSON
Schema, so it's Zod-agnostic.

## Commands
- `npm run build:<pkg>` / `typecheck:<pkg>` for `core`, `cloudflare`, `caretize`,
  `zod` — `tsc -p tsconfig.build.json` → `dist/` (typecheck: strict, no emit).
  Note: cloudflare's typecheck resolves core via its built `dist/`, so build
  core first on a fresh clone.
- `npm run test:unit` — `vitest run` (`tests/unit/**/*.test.ts`).
- `npm run test:e2e` — `playwright test`; builds core, boots `examples/starter`,
  runs `tests/e2e/*.spec.ts`. **Serial (1 worker)** — starter uses filesystem
  storage and parallel writers corrupt the JSON. Run separately from unit tests.
- `npm run validate:versions` — enforces exact-pinned (no `^`/`~`) versions for
  astro, tailwind, typescript, vitest via `scripts/validate-versions.mjs`.
- `npm run check` — gate: validate:versions → typecheck (all 4 pkgs) → build
  (all 4 pkgs) → test:unit (no e2e).
- `npm run dev:starter` / `dev:content` — run an example dev server.

## Architecture
- **Integration** (`packages/core/src/index.ts`): `caret()` factory. Resolves config
  (mode `embedded`|`cloud`, storage/upload providers), generates virtual modules
  (`virtual:caretcms/providers`, `virtual:caretcms/schemas`) via Vite plugins, injects
  `order:'pre'` middleware, ~16 routes, and the inline-editor bootstrap script.
- **Mutation engine** (`src/runtime/mutations/engine.ts`): per-key promise-chain locks
  serialize writes; optimistic concurrency via revision numbers; mismatch → 409 with
  `currentRevision` for client retry. No database/distributed lock — single-server
  embedded only.
- **Rewrite engine** (`src/runtime/rewrite.ts`): parses `data-caret="collection::id::field"`
  attributes and injects stored overrides into HTML. **Security-critical** — string
  manipulation with sanitization, no DOM parser; fuzzed by fast-check
  (`tests/unit/rewrite-properties.test.ts`, XSS/injection invariants).
- **Storage abstraction** (`src/types.ts`): `StorageAdapter` / `UploadHandler`
  interfaces. Core ships filesystem + in-memory **reference** adapters only; it never
  imports platform code. Cloudflare KV/R2 live in `packages/cloudflare` (uses
  `env.CMS_KV` / `env.CMS_R2`).
- **Live loaders** (`src/loader.ts`): `caretLoader()` for Astro 6 stable +
  5.10+ experimental live collections.
- **Auth** (`src/runtime/auth/`): password + optional demo-session overlay,
  rate-limiter, HttpOnly/SameSite=Lax/Secure cookies.
- **Browser runtime** (`src/browser-runtime.ts`): two-phase — bootstrap checks
  `/api/cms/auth/session`, then lazy-loads the editor only if authed and `data-caret`
  present.

## Public API (`@caretcms/core`)
Default export `caret()`. Subpaths: `./loader`, `./runtime` (`loadEntry`,
`loadCollection`), `./providers/storage/filesystem`, `./providers/uploads/local`,
`./schema-registry`, `./schema-utils`, `./browser-runtime`, `./editor-runtime`
(static editor JS/CSS, served from `static/`, **not** `dist/`). Helper factories:
`defineStorageProvider`, `defineUploadProvider`, `filesystemStorage`, `localUploads`.
Types (`StorageAdapter`, `UploadHandler`, `EntryData`, `CollectionSchema`, …) are
exported ahead of implementations — treat them as the public contract.

## Conventions
- `.test.ts` = vitest unit, `.spec.ts` = playwright e2e. vitest stubs the virtual
  modules in `vitest.config.ts`.
- `tsconfig.json` (strict, no emit) vs `tsconfig.build.json` (emit + declaration maps).
- Published packages MIT/public; example apps `private`. `prepublishOnly` runs a
  version check + clean + build.
- Versions are **exact-pinned** by policy — `validate:versions` fails the gate
  otherwise. Don't reintroduce ranges for the guarded deps.

## Public-repo discipline
Everything here is open source. No API keys, private endpoints, or secrets —
`CARET_EDIT_PASSWORD` is injected at runtime for demo/e2e only, never committed.
Cloud mode is alpha with placeholder endpoints; don't document private infrastructure.
