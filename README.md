# CaretCMS

CaretCMS is a reusable, open-core CMS for Astro:

- **Static delivery** — keep `output: 'static'`; bake published edits into HTML at build time
- **Live content collections** via `astro:content` live loaders
- **Inline canvas editing** — text, images, and section layout edited directly on the page
- **Studio admin** for structured entry editing
- **Attribute-first binding** — add `data-caret` attributes; no schema rewrite required
- **Pluggable storage** — filesystem out of the box, Cloudflare KV/R2 adapter included

The CMS ships as `@caretcms/core`, an Astro integration you install into any Astro app.

![CaretCMS inline editor demo](https://caretcms.com/preview/caretcms-editor-demo.gif)

## Packages

| Package | Description |
|---------|-------------|
| [`@caretcms/core`](packages/core) | Platform-neutral core: integration, mutation engine, studio admin, inline editor, `StorageAdapter` interface |
| [`@caretcms/cloudflare`](packages/cloudflare) | Cloudflare storage + upload adapters (KV/R2) |
| [`@caretcms/caretize`](packages/caretize) | CLI that scans an existing Astro site and adds `data-caret` attributes interactively |
| [`@caretcms/zod`](packages/zod) | Optional Zod → JSON Schema bridge for `caret({ schemas })` |

## Examples

| Example | What it shows |
|---------|---------------|
| [`examples/starter`](examples/starter) | Smallest useful CMS-enabled Astro site |
| [`examples/content-site`](examples/content-site) | Editorial content site with scoped bindings and shared content |
| [`examples/demo`](examples/demo) | Cloudflare deployment example |

## Quick start

Pick the delivery mode that matches your Astro output:

### Static sites (recommended for marketing / brochure sites)

No SSR adapter. Author locally; public visitors see edits after **Publish → rebuild → deploy**.

```sh
npm install @caretcms/core
```

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import caret from '@caretcms/core';

export default defineConfig({
  integrations: [caret({ delivery: 'static' })],
});
```

See [docs/static-delivery.md](docs/static-delivery.md) for the full publish/rebuild flow.

### Server-rendered sites (instant visitor updates)

Per-request HTML rewriting in production. Requires `output: 'server'` and an SSR adapter:

```sh
npm install @caretcms/core @astrojs/node
```

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import caret from '@caretcms/core';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [caret()],
});
```

### After wiring either path

- Run `npm run dev` — with no password configured, a temporary dev password is printed in the terminal
- **Sign in at `/admin`**; the content Studio lives at `/admin/cms`
- Add `data-caret` / `data-caret-scope` attributes — or run `npx @caretcms/caretize init` then `npx @caretcms/caretize` to tag an existing site interactively
- For production authoring, set `CARET_EDIT_PASSWORD` and `CARET_SESSION_SECRET` (see [deployment](docs/deployment.md))
- Optionally create `src/caret.config.ts` with `caretLoader` for `getLiveEntry` / `getLiveCollection`

The inline editor bootstraps when `data-caret` is present **and** `/api/cms/auth/session` confirms an authenticated session. Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS.

Full API reference: [`packages/core/README.md`](packages/core/README.md). Static delivery guide: [docs/static-delivery.md](docs/static-delivery.md). Docs site: **https://caretcms.com/docs**.

## Develop in this repo

```sh
npm install

# run the example apps
npm run dev:starter      # minimal "ship fast" path
npm run dev:content      # integrate into a real template

# core package checks
npm run typecheck:core
npm run build:core
```

## Quality gates

```sh
npm run validate:versions   # pinned-version policy
npm run typecheck:core
npm run build:core
npm run test:unit
npm run test:e2e            # builds core, runs the starter, drives the editor
```

Or run the full gate with `npm run check`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
