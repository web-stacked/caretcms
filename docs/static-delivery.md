# Static delivery

Static delivery lets a normal **static Astro site** use CaretCMS without running an
always-on server for public traffic. Editors still get inline editing and Studio in
`astro dev`; published content is **baked into generated HTML** at build time.

## When to use it

| Use static delivery when… | Use server delivery when… |
|---|---|
| Your site ships as static files (Netlify, Vercel static, S3, CDN) | You already run Astro with `output: 'server'` |
| You are fine with **Publish → rebuild → deploy** for public updates | You need visitor-visible edits **immediately** after save |
| You want CaretCMS without adding an SSR adapter | You want per-request HTML rewriting in production |

## How it works

```text
Dev (astro dev)
  → CaretCMS injects /admin, /api/cms, inline editor (local authoring)

Build (astro build, output: static)
  → Authoring routes stay out of production output
  → astro:build:done bakes .caret/data overrides into dist/**/*.html

Publish (in dev or a staging environment)
  → Draft overlay commits to storage
  → Optional rebuild webhook triggers CI → astro build → deploy
```

Your template markup remains the **seed content**. Until an editor saves an
override, visitors see the original HTML. After publish and rebuild, stored values
replace tagged fields in the built files.

## Setup

### 1. Wire the integration

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import caret from '@caretcms/core';

export default defineConfig({
  // output defaults to "static" in Astro — no adapter required
  // caret() auto-selects static delivery for static Astro output
  integrations: [caret()],
});
```

`caret()` is the recommended static-site setup. Use `delivery` only when you want
to configure bake/publish behavior or explicitly pin the mode:

```js
caret({
  delivery: {
    // mode defaults to 'auto', so static Astro output still uses static delivery
    bake: true, // default for static delivery
    publish: {
      webhookUrl: process.env.CARET_REBUILD_WEBHOOK_URL,
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.CI_TOKEN}` },
    },
  },
})
```

You can also pass `delivery: 'static'` to make the integration validate that Astro
is still running with static output.

`npx @caretcms/caretize init` scaffolds `caret()` automatically for static Astro
projects.

### 2. Tag editable content

Add `data-caret` attributes by hand, or let caretize do the first pass:

```sh
npx @caretcms/caretize
```

Same binding model as server delivery — see
[`packages/core/README.md`](../packages/core/README.md).

### 3. Author locally

```sh
npm run dev
```

Sign in at `/admin`. With no `CARET_EDIT_PASSWORD` set, a temporary dev password is
printed in the terminal. Edit inline or in Studio; use Preview / Publish / Discard as
usual.

### 4. Ship baked HTML

```sh
npm run build
```

The integration logs how many HTML files were rewritten, for example:

```text
[caretcms] static delivery bake complete (12/12 HTML files rewritten).
```

Deploy `dist/` to your static host. Public pages contain baked content — no CMS
routes in production output.

## Publish and rebuild

On static delivery, **anonymous visitors only see published content after a rebuild**
that runs `astro build` with access to your storage (`.caret/data/` or git-checked-in
content).

Typical CI flow:

1. Editor publishes in dev (or staging with authoring routes enabled).
2. `POST /api/cms/publish` commits drafts and optionally calls `delivery.publish.webhookUrl`.
3. CI receives the webhook, runs `astro build`, deploys `dist/`.
4. Bake step reads storage and rewrites HTML.

Add a `deployment` provider when the editor should track the accepted request
through a real provider build and verify that the published revisions reached
the live artifact. See [deployment completion status](./deployment-status.md).

The publish still succeeds if the webhook fails — check server logs for webhook errors
and retry the deploy manually.

Webhook body (JSON):

```json
{
  "source": "caretcms",
  "event": "publish",
  "published": [{ "collection": "pages", "id": "home", "revision": 3, "deleted": false }],
  "commit": "abc123...",
  "deploymentId": "5df5b238-4df4-46ba-91a8-e347be6b5a3f"
}
```

`commit` is set when `CARET_GIT_ON_PUBLISH=true` and git commit-on-publish succeeds.
`deploymentId` correlates the request with a deployment status provider.

## Storage and git

Static delivery works with any `StorageAdapter`. Common patterns:

- **Filesystem + git** — commit `.caret/data/` (or `markdownStorage` frontmatter) on
  publish; CI builds from the updated repo.
- **CI-only bake** — storage lives on the build agent; webhook triggers build after
  publish from a staging editor environment.

See [deployment.md](./deployment.md) for adapter topology and env vars.

## Configuration reference

| Option | Default (static) | Notes |
|---|---|---|
| `delivery` | `'auto'` | Static Astro output resolves to static delivery; server output resolves to server delivery |
| `delivery: 'static'` | — | Optional shorthand for `{ mode: 'static', bake: true }`; errors if Astro output is not static |
| `delivery.mode` | `'auto'` if omitted | Use `'static'` only when you want to pin this path |
| `delivery.bake` | `true` for effective static delivery | Set `false` to skip HTML rewrite at build |
| `delivery.publish.webhookUrl` | none | Called after successful publish |
| `delivery.publish.method` | `POST` | `POST` or `PUT` |
| `delivery.publish.headers` | `{}` | Extra headers for the webhook |
| `deployment` | none | Runtime provider for build identity and evidence-backed completion status |

Other `caret()` options (`mountPath`, `storage`, `allowedClasses`, …) behave the same
as server delivery during dev authoring.

## Troubleshooting

**Preflight says static output is using auto/static delivery**

That is expected when `caret()` is wired in a static Astro project. Public changes
still need Publish + rebuild + deploy.

**Preflight warns that static output is using server delivery**

Remove `delivery: 'server'`, change it to `delivery: 'auto'`, or run
`npx @caretcms/caretize init` to let static output use build-time baking.

**Edits work in dev but not on the deployed site**

You likely deployed without a post-publish rebuild, or bake could not read storage
(e.g. `.caret/data/` not present in CI). Run `astro build` locally and confirm the
bake log line.

**Build log says bake skipped**

Ensure a storage provider is configured (default `filesystemStorage()` is fine) and
`delivery.bake` is not `false`.

**I need live editing on production pages**

Use server delivery (`output: 'server'` + an SSR adapter) instead, or keep static
delivery and edit via dev/staging only.

## Related

- [`packages/caretize/README.md`](../packages/caretize/README.md) — auto-tagging existing sites
- [`docs/deployment.md`](./deployment.md) — storage adapters and production env vars
- [`packages/core/README.md`](../packages/core/README.md) — full API and inline editing
