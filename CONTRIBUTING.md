# Contributing to CaretCMS

Thanks for your interest in improving CaretCMS. This guide covers the
local setup, the layout of the repo, and the checks your change must pass.

## Setup

Requirements are pinned in `.nvmrc` and `package.json` (`engines`): Node
`^20.19.1 || >=22.12.0` and npm `>=10`.

```sh
npm install
```

Run one of the example apps that embed the CMS:

```sh
npm run dev:starter    # minimal CMS-enabled app (Node adapter, filesystem storage)
npm run dev:content    # content-first starter
```

The example apps require an editor password:

```sh
CARET_EDIT_PASSWORD=your-password npm run dev:starter
```

## Repository layout

| Path | What it is |
|---|---|
| `packages/core` | The reusable, platform-neutral package (`@caretcms/core`). Most changes land here. |
| `packages/cloudflare` | Cloudflare KV/R2 storage and upload adapters. |
| `examples/` | Adoption assets and integration fixtures (`starter`, `content-site`, `demo`). Also the targets for end-to-end tests. |
| `tests/unit` | Vitest unit tests. |
| `tests/e2e` | Playwright end-to-end tests (drive the inline editor in a real browser). |

`packages/core` must stay free of platform-specific imports — anything
platform-bound belongs behind the `StorageAdapter` / `UploadHandler`
interfaces (see `packages/cloudflare` for the reference implementation).

## Quality gates

Before opening a pull request, run the full gate:

```sh
npm run check
```

This runs, in order: `validate:versions`, `typecheck:core`, `typecheck:cloudflare`,
`build:core`, `build:cloudflare`, and `test:unit`. You can run any step individually:

```sh
npm run typecheck:core         # type-check the core package
npm run typecheck:cloudflare   # type-check the cloudflare package
npm run build:core             # compile @caretcms/core to dist/
npm run build:cloudflare       # compile @caretcms/cloudflare to dist/
npm run test:unit              # Vitest unit tests
```

End-to-end tests run separately and build the core package automatically:

```sh
npm run test:e2e         # Playwright; first run: npx playwright install chromium
```

CI (`.github/workflows/ci.yml`) runs the Node gate on Node 20 and 22, a Bun
parity check, and the Playwright suite. All must be green to merge.

## Tests

- **Unit tests** (`tests/unit`) cover the mutation engine, rewrite engine,
  auth, storage adapters, and route contracts. Add or extend a unit test for
  any logic change in `packages/core`.
- **End-to-end tests** (`tests/e2e`) drive the inline editor against
  `examples/starter`. Add an E2E test when you change an editor *surface*
  (text/image editing, save flow, conflict handling). Each test resets the
  filesystem-backed storage in `beforeEach`, so tests start from the template
  defaults.

When you fix a bug, add the test that fails before your fix and passes after.

## Pull requests

- Keep changes focused; one logical change per PR.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
  messages (e.g. `fix(core): …`, `feat(core): …`, `docs: …`).
- Update `CHANGELOG.md` under `## [Unreleased]` for any user-facing change.
- Dependency versions for `astro` and Tailwind are pinned exactly and enforced
  by `npm run validate:versions`; do not introduce ranges for those.
