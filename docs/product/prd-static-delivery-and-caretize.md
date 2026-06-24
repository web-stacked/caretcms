# PRD - Static-First CaretCMS And Caretize

Status: **Implemented** (core + caretize; see [docs/static-delivery.md](../static-delivery.md))
Owner: Allen
Last updated: 2026-06-23

> Historical planning doc. Static delivery shipped in `@caretcms/core` — `delivery:
> "static"`, build-time bake, publish webhook, caretize static init. Sections below
> describe the original gap analysis; treat "Today, embedded CaretCMS still needs…"
> as pre-implementation context.

This document is ASCII-only on purpose. It is meant to be easy to review in git,
copy into issues, and work through as a checklist.

## 1. Summary

CaretCMS already has the foundation for "the repository is the CMS":
in-context editing, a real `@caretcms/caretize` CLI, markdown storage, per-editor
draft overlays, Preview / Publish / Discard, and optional git commit-on-publish.

The remaining product gap is delivery.

Today, embedded CaretCMS still needs Astro `output: "server"` because published
HTML is rewritten per request by middleware. Static Astro users still have to run
a server just to get stored edits baked into pages.

Static delivery mode should make this true:

```text
Visitors get static files.
Editors get instant inline editing.
Saves go through the existing draft/publish machinery.
Publish triggers a rebuild.
The build bakes CaretCMS content into static HTML.
```

This is not a plan to build `caretize` from scratch. It already exists. This is a
plan to make the existing repo-as-CMS and caretize system work cleanly for static
delivery.

## 2. One paragraph pitch

Static delivery CaretCMS lets a normal static Astro site become editable without
turning the public site into an always-on server. Editors still click text and
images in place, save drafts, preview, publish, and optionally commit changes to
git. The difference is what happens after publish: a rebuild webhook runs Astro
build, CaretCMS bakes stored overrides into the generated HTML, and the deployed
site remains fast, frozen, SEO-correct static output.

## 3. Current foundation

The local repository is now synced with remote `main` and already includes major
early-June work. These are foundations, not future work.

### 3.1 Existing repo-as-CMS docs

- `docs/PRD-repo-as-cms.md`
- `docs/CHECKLIST-repo-as-cms.md`
- `docs/deployment.md`
- `docs/design-principles.md`

Those docs define the broader product thesis:

```text
The repository is the CMS.
The running site is the editing UI.
```

This PRD extends that thesis with static delivery.

### 3.2 Existing caretize CLI

`packages/caretize` already exists.

It includes:

- `packages/caretize/package.json`
- `packages/caretize/src/cli.ts`
- dry-run, interactive review, write, backup, and restore
- static text and image tagging
- `editable()` wrapping for inline data arrays
- prop hoisting
- import-backed list handling
- `--bind-collections`
- `--bind-routes`
- idempotency and parse verification gates
- unit and e2e tests under `tests/unit/caretize-*` and `tests/e2e/caretize-verify.spec.ts`

Caretize should not be rebuilt. Static delivery may only need a small extension for
setup guidance or static delivery scaffolding.

### 3.3 Existing draft and publish workflow

Core already has:

- per-editor draft overlays via `StorageAdapter.makeEditorOverlay`
- preview mode via the `caret_preview` cookie
- `POST /api/cms/publish`
- `DELETE /api/cms/draft`
- editor toolbar Preview / Publish / Discard controls
- `publishOverlay()` in `packages/core/src/runtime/publish.ts`
- optional git commit-on-publish via `CARET_GIT_ON_PUBLISH=true`

Key files:

- `packages/core/src/runtime/middleware.ts`
- `packages/core/src/runtime/routes/publish.ts`
- `packages/core/src/runtime/routes/draft.ts`
- `packages/core/src/runtime/publish.ts`
- `packages/core/src/runtime/git-journal.ts`
- `packages/core/static/cms/editor/toolbar.js`

This means static delivery does not need to invent Preview / Publish. It needs to
connect Publish to rebuild and static baking.

### 3.4 Existing storage foundation

Core already supports:

- filesystem JSON storage
- markdown storage
- in-memory storage
- Cloudflare KV/R2 storage and uploads
- sidecar metadata for revisions/history/collection metadata

Relevant files:

- `packages/core/src/types.ts`
- `packages/core/src/runtime/providers.ts`
- `packages/core/src/runtime/storage/filesystem-adapter.ts`
- `packages/core/src/runtime/storage/markdown-adapter.ts`
- `packages/cloudflare/src/adapters/kv-storage.ts`

## 4. Current problem

Even with all of the above, embedded static output still exits early.

Current flow in `packages/core/src/index.ts`:

```text
if config.output == "static":
  warn that embedded CMS needs server output
  skip middleware
  skip admin routes
  skip API routes
  skip editor assets
  skip inline editor bootstrap
```

Current content delivery flow:

```text
Visitor request
  -> Astro server render
  -> CaretCMS middleware intercepts HTML
  -> rewriteCaretAttributes reads the StorageAdapter
  -> response HTML contains stored overrides
```

That flow works for server output, but it is the wrong delivery model for a
pure static site.

The user pain:

```text
I have a static Astro site.
I want a CMS.
I do not want to host an app server.
CaretCMS currently makes me switch to server output for the public site.
```

## 5. Before and after

### 5.1 Before: current server-first delivery

```text
Editor:
  sign in
  preview draft
  edit page
  publish draft to base

Visitor:
  request page
  server renders page
  middleware rewrites HTML using base storage
  visitor receives rewritten HTML
```

Strengths:

- Works today.
- Uses existing mutation engine, storage adapters, and rewrite engine.
- Supports drafts/publish.

Weakness:

- Public delivery still needs a server request path.

### 5.2 After: proposed static delivery delivery

```text
Editor:
  sign in through authoring surface
  preview draft
  edit page
  publish draft to base
  publish triggers rebuild webhook

Build:
  Astro builds static HTML
  CaretCMS build-time bake runs rewriteCaretAttributes
  saved base content is written into generated HTML
  static deploy goes live

Visitor:
  request page
  CDN/static host serves baked HTML
```

Strengths:

- Public site is static.
- No visitor request-time rewrite.
- SEO sees final HTML.
- Existing editor and publish model stay intact.

Trade-off:

- Public changes appear after rebuild/deploy, not immediately after save.

## 6. Goals

- Make static delivery a first-class CaretCMS path.
- Keep existing embedded server mode working.
- Reuse current `rewriteCaretAttributes` logic for build-time baking.
- Reuse current drafts/publish system.
- Reuse current `caretize` CLI and only extend it where static delivery setup needs help.
- Keep visitors on frozen, fast, SEO-correct static HTML.
- Make editor UX honest about the states:
  - draft saved
  - published to base
  - rebuild started
  - deployed or deployment status unknown
- Keep core storage-agnostic.
- Keep core runtime dependency discipline.

## 7. Non-goals

- Rebuilding `packages/caretize` from scratch.
- Replacing current embedded server mode.
- Replacing the mutation engine or revision model.
- Building a full hosted SaaS control plane in this PRD.
- Guaranteeing every hosting provider integration in v1.
- Making publish-to-live instant. Static delivery accepts a rebuild delay.

## 8. Users and use cases

### 8.1 Content editor

Wants:

- click-to-edit on the actual page
- preview drafts before publishing
- publish when ready
- clear status when changes are not live yet

Does not want:

- to understand Astro output modes
- to wonder whether a save is live

### 8.2 Static Astro developer

Wants:

- keep static hosting
- keep CDN performance
- avoid operating a Node server for visitor traffic
- make existing pages editable with `caretize`
- wire publish to the existing build/deploy platform

Does not want:

- a CMS database that owns content separately from the repo
- a large runtime dependency stack

### 8.3 Migration team

Wants:

- run `npx @caretcms/caretize`
- review safe changes
- annotate existing pages/components
- adopt static delivery mode without rewriting site architecture

Does not want:

- unsafe codemods
- duplicate schema/config work

## 9. Proposed solution

Static delivery is built from three homes:

```text
SHOW   -> browser/editor surface
STORE  -> authoring/mutation surface
PUBLISH -> build/deploy surface
```

### 9.1 SHOW: instant editor feedback

Use the current editor runtime.

Existing relevant files:

- `packages/core/static/cms/editor.js`
- `packages/core/static/cms/editor/text-edit.js`
- `packages/core/static/cms/editor/image-edit.js`
- `packages/core/static/cms/editor/save-queue.js`
- `packages/core/static/cms/editor/toolbar.js`

Current editor behavior already includes optimistic updates and rollback paths.
For static delivery, the editor should make the state explicit:

```text
Edited locally
  -> saving draft
  -> draft saved
  -> published
  -> rebuild triggered
  -> deployed, or check deployment provider
```

### 9.2 STORE: save through existing mutation/publish machinery

Use the current mutation engine and draft overlay system.

Existing relevant files:

- `packages/core/src/runtime/mutations/engine.ts`
- `packages/core/src/runtime/mutations/contracts.ts`
- `packages/core/src/runtime/routes/mutate.ts`
- `packages/core/src/runtime/routes/publish.ts`
- `packages/core/src/runtime/routes/draft.ts`
- `packages/core/src/runtime/publish.ts`

Open design question:

```text
What is the v1 authoring topology for static sites?
```

Options:

1. Local preview authoring server

```text
astro dev or preview server
  -> editor routes exist locally
  -> publish writes repo/storage
  -> rebuild/deploy happens through CI
```

2. Serverless authoring function

```text
static visitor site
  -> no server in visitor path
editor requests
  -> small auth/mutate/publish function
  -> storage adapter
  -> rebuild webhook
```

3. Existing server mode as authoring-only

```text
public static deploy
authoring server protected separately
same repo/storage
publish triggers public rebuild
```

Recommendation for v1:

```text
Define the product around serverless authoring, but implement the core bake
path first. Document local preview authoring as the easiest first user path.
```

Reason:

- Build-time baking proves static delivery delivery.
- The existing server route stack can act as the first authoring surface.
- Serverless extraction can follow with clearer requirements.

### 9.3 PUBLISH: rebuild and bake

Current publish flushes draft overlay to base storage. Static delivery should add a
post-publish rebuild step.

Desired flow:

```text
POST /api/cms/publish
  -> publishOverlay(base, overlay)
  -> optional git commit-on-publish
  -> trigger rebuild webhook
  -> return publish result + webhook result
```

The rebuild then runs:

```text
astro build
  -> generate static HTML
  -> CaretCMS build-time bake scans generated HTML
  -> rewriteCaretAttributes replaces data-caret content from base storage
  -> final dist contains baked HTML
```

The build-time bake should reuse:

- `packages/core/src/runtime/rewrite.ts`
- `StorageAdapter`
- provider-loading patterns from `packages/core/src/runtime/providers.ts`

## 10. Architecture changes

### 10.1 Reuse

Reuse as much as possible:

- `packages/core/src/runtime/rewrite.ts`
  - Same binding parser and safe replacement logic.
  - Move invocation from request-time only to request-time plus build-time.

- `packages/core/src/runtime/mutations/engine.ts`
  - Same locks, revisions, history, and `409` conflict semantics.

- `packages/core/src/runtime/publish.ts`
  - Same draft-to-base publish semantics.

- `packages/core/src/types.ts`
  - Same `StorageAdapter` and `UploadHandler` contracts.

- `packages/caretize`
  - Existing annotation and migration CLI.

- `packages/core/static/cms`
  - Existing editor runtime and toolbar.

### 10.2 Change

Change carefully:

- `packages/core/src/index.ts`
  - Static output should not simply mean "skip everything forever."
  - It needs a static delivery mode path.
  - Server mode must keep current behavior.

- `packages/core/src/runtime/providers.ts`
  - Build-time code may need provider access without request middleware.

- `packages/core/src/loader.ts`
  - Current loader is request-context oriented.
  - Static builds may need build-safe adapter access.

- `packages/core/src/runtime/routes/publish.ts`
  - May add optional rebuild webhook trigger after current publish and git journal.

- editor toolbar/status copy
  - Clarify "published" vs "deployed."

### 10.3 New

Likely new pieces:

- build-time bake utility
- Astro integration hook or post-build command to run bake
- static delivery config option
- rebuild webhook configuration
- static delivery docs
- static delivery tests
- optional caretize static delivery setup/check command

## 11. Proposed configuration shape

This is a draft. Final API should be validated before implementation.

```js
caret({
  mode: "embedded",
  delivery: {
    enabled: true,
    bake: true,
    publish: {
      webhookUrl: process.env.CARET_REBUILD_WEBHOOK,
    },
  },
})
```

Alternative:

```js
caret({
  output: "static delivery",
})
```

Recommendation:

Use an explicit nested option, not a new `mode`, because `mode` already means
embedded vs cloud.

```text
mode: embedded
delivery.mode === "static": true
```

Open question:

Should the option be available when Astro `output` is `static`, or should it
also work in server output as a preview of static deployment behavior?

## 12. Build-time bake design

### 12.1 Input

The bake step needs:

- built HTML files
- configured storage adapter
- same rewrite options as request-time rewrite, including allowed rich text classes

### 12.2 Process

```text
for each HTML file in dist:
  read file
  if it has data-caret or data-caret-scope attributes:
    call rewriteCaretAttributes(html, adapter, options)
    write rewritten HTML back
```

### 12.3 Output

Static HTML in `dist` contains saved base content.

No visitor middleware is needed.

### 12.4 Test shape

Unit test:

```text
input HTML with data-caret
adapter has saved value
run bake utility
output HTML contains saved value
```

Integration test:

```text
static Astro fixture
storage has override
astro build
CaretCMS bake runs
dist/index.html contains override
```

## 13. Rebuild webhook design

After Publish, static delivery needs to kick off the deploy pipeline.

Config draft:

```js
caret({
  delivery: {
    publish: {
      webhookUrl: process.env.CARET_REBUILD_WEBHOOK,
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CARET_REBUILD_TOKEN}`,
      },
    },
  },
})
```

Failure behavior:

```text
If publish fails:
  nothing is published
  no rebuild webhook is called

If publish succeeds and webhook succeeds:
  report publish ok + rebuild started

If publish succeeds and webhook fails:
  report publish ok + rebuild failed
  do not roll back content
  show retry rebuild action if possible
```

This is important. The content and deploy steps are separate. A webhook failure
must not undo the publish.

## 14. Caretize role in static delivery

Caretize already solves most migration needs:

```text
npx @caretcms/caretize --dry-run
npx @caretcms/caretize
npx @caretcms/caretize --bind-collections
npx @caretcms/caretize --bind-routes
```

Potential static delivery extension:

```text
npx @caretcms/caretize --static delivery
```

Possible behavior:

- detect Astro `output: "static"`
- confirm CaretCMS integration exists
- warn if static delivery bake is not configured
- suggest required environment variables
- optionally scaffold static delivery config
- optionally write a JSON report for deployment setup

Non-goal:

Do not make caretize own deploy-provider automation in v1.

Caretize should remain safe:

- dry-run first
- no double config injection
- no unsafe rewrites
- idempotency tests for any new scaffold behavior

## 15. Trade-offs

### 15.1 Benefits

- Public site stays static.
- CDN performance and SEO are strong.
- No request-time rewrite for visitors.
- Existing editor UX remains.
- Existing repo-as-CMS story becomes more complete.
- The MLS-style rebuild-on-change pattern is familiar:

```text
source changes
  -> webhook / action
  -> rebuild
  -> static deploy
```

### 15.2 Costs

- Published changes are not live until rebuild finishes.
- Publish and deploy become separate states.
- More provider-specific docs are needed.
- Build-time adapter loading must be robust.
- Static delivery authoring needs a clear topology.

### 15.3 Alternatives

Alternative 1: Keep server-only embedded mode

- Lowest engineering effort.
- Does not solve static user pain.

Alternative 2: Client overlay for visitors

- Avoids rebuild delay.
- Bad for SEO and can cause content flash/mismatch.

Alternative 3: Auto-rebuild every save

- Simple mental model.
- Too noisy and expensive for normal editing.
- Draft/publish already gives a better boundary.

Alternative 4: Full SaaS control plane first

- Powerful long term.
- Too large for this phase.

## 16. Phased rollout checklist

### Phase 0 - PRD and alignment

- [ ] Add this PRD.
- [ ] Review against `docs/PRD-repo-as-cms.md`.
- [ ] Confirm that the scope is static delivery, not rebuilding caretize/publish.
- [ ] Choose first authoring topology for v1.
- [ ] Decide initial API shape for `delivery`.

Clean commit:

```text
docs: add static delivery PRD and checklist
```

### Phase 1 - Build-time bake utility

- [ ] Add a utility that rewrites built HTML using `rewriteCaretAttributes`.
- [ ] Reuse `StorageAdapter`.
- [ ] Reuse rich text options such as `allowedClasses`.
- [ ] Add unit tests for file-free rewrite utility behavior.
- [ ] Add temp-dir tests for reading/writing HTML files.
- [ ] Do not change server middleware behavior.

Acceptance:

```text
Given HTML with data-caret
And storage with an override
When bake runs
Then output HTML contains the override
```

### Phase 2 - Static output integration

- [ ] Add `delivery.mode === "static"` config or equivalent.
- [ ] In Astro static output, register build-time bake behavior.
- [ ] Keep current server output behavior unchanged.
- [ ] Keep cloud mode behavior unchanged unless explicitly supported.
- [ ] Log clear setup/status messages.
- [ ] Add tests around the `output: "static"` branch in `packages/core/src/index.ts`.

Acceptance:

```text
Astro output static no longer means "CaretCMS is completely skipped"
when delivery is enabled.
```

### Phase 3 - Build-safe provider access

- [ ] Identify whether build-time bake can reuse current virtual provider module.
- [ ] If not, add a build-safe provider loader.
- [ ] Keep request-context provider behavior unchanged.
- [ ] Add tests for provider loading outside middleware/request context.

Acceptance:

```text
Build-time bake can load the configured storage adapter without middleware.
```

### Phase 4 - Static delivery authoring topology

- [ ] Pick v1 path:
  - local preview authoring server
  - serverless authoring function
  - protected authoring server separate from public static deploy
- [ ] Document how editor routes are reached.
- [ ] Document where drafts are stored.
- [ ] Document how publish writes base content.
- [ ] Add tests for any extracted route/handler if serverless is included.

Acceptance:

```text
A static delivery user knows exactly where editing happens and where visitors go.
```

### Phase 5 - Rebuild webhook

- [ ] Add config for rebuild webhook.
- [ ] Trigger webhook after successful publish.
- [ ] Keep publish success independent from webhook success.
- [ ] Return webhook status in publish response.
- [ ] Add retry guidance or a retry endpoint if needed.
- [ ] Add tests for success, failure, and not-called-on-publish-failure.

Acceptance:

```text
Publish can trigger a rebuild, and webhook failure is visible without rolling
back content.
```

### Phase 6 - Editor status polish

- [ ] Update toolbar/status copy for static delivery.
- [ ] Distinguish:
  - draft saved
  - published
  - rebuild triggered
  - deployed status unknown
- [ ] Preserve existing optimistic rollback behavior.
- [ ] Add tests where practical.

Acceptance:

```text
Editors do not confuse "saved" with "live on the public site."
```

### Phase 7 - Caretize static delivery helper, if needed

- [ ] Audit current caretize preflight.
- [ ] Decide whether static delivery setup belongs in caretize or docs.
- [ ] If added, make it dry-run/idempotent.
- [ ] Add tests for duplicate config prevention.

Acceptance:

```text
Caretize helps static users without becoming an unsafe project generator.
```

### Phase 8 - Docs and examples

- [ ] Add static delivery docs.
- [ ] Add deployment recipes:
  - local preview + GitHub Actions
  - Netlify build hook
  - Vercel deploy hook
  - Cloudflare Pages webhook
- [ ] Add a static example or adapt an existing example.
- [ ] Document limitations.

Acceptance:

```text
A new user can follow docs from static Astro site to editable static deploy.
```

## 17. Testing plan

### Unit tests

- build-time bake utility
- provider loading for bake
- publish webhook trigger
- webhook failure behavior
- static delivery option validation

### Integration tests

- static fixture builds and produces baked HTML
- server output still rewrites per request
- cloud mode unchanged
- markdown storage works with bake

### E2E tests

Only after the static path exists:

```text
1. Start authoring surface
2. Edit draft
3. Publish
4. Run static build
5. Assert dist HTML contains published content
```

## 18. Clean commit plan

Recommended commits:

1. `docs: add static delivery PRD and checklist`
2. `feat(core): add build-time static bake utility`
3. `feat(core): wire static delivery bake into static output`
4. `feat(core): add rebuild webhook on publish`
5. `fix(editor): clarify static delivery publish and deploy states`
6. `docs: add static delivery deployment recipes`
7. optional: `feat(caretize): add static delivery setup check`

Each commit should pass the narrow relevant tests. Before merge:

```text
npm run check
npm run test:e2e
```

Run e2e when runtime/editor behavior changes.

## 19. Open questions

1. What is the first supported authoring topology?

```text
local preview server
serverless function
separate protected authoring server
```

2. Where should build-time bake hook into Astro?

```text
Astro integration hook
Vite plugin
post-build command
```

3. Should static delivery be an option under embedded mode?

```text
mode: "embedded"
delivery: { enabled: true }
```

4. How much provider-specific webhook support belongs in core?

```text
generic webhook only
or provider presets later
```

5. How should the editor know deploy finished?

```text
fire-and-forget webhook
manual status
poll configured status URL
provider-specific integration
```

6. Does static delivery require serverless auth routes in v1, or can v1 document
local/protected authoring server first?

## 20. Success metrics

- Static delivery sites can deploy baked HTML without server request-time rewrite.
- Static delivery docs are enough for a new static Astro site.
- Existing server mode tests remain green.
- Existing caretize tests remain green.
- Publish-to-rebuild webhook success rate is visible.
- Support requests about "why do I need output server?" decrease.
- Time from Publish to static deploy is measurable.

## 21. Final recommendation

This work is worth doing, but only in the narrowed form:

```text
Static delivery delivery for the existing repo-native CMS.
```

Do not frame it as:

```text
Build caretize.
Build publish.
Invent a new CMS workflow.
```

Those foundations already exist.

The valuable next step is:

```text
Move the visitor delivery path from request-time rewrite to build-time bake,
then connect publish to rebuild.
```

