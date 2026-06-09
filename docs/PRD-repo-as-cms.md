# PRD — "The Repository is the CMS"

> Architecture-leverage initiative. Status: **Draft**. Owner: Allen.
> Grounded in a code sweep of `packages/core`, `packages/caretize`, `packages/cloudflare`
> (June 2026). File:line references are accurate as of that sweep — verify before editing.

## 1. Thesis

Traditional CMSes split **content** (a DB/SaaS) from **presentation** (your code), and editing
happens in an admin UI divorced from the result. CaretCMS collapses all three: content is
**versioned files in the repo**, the schema is **largely the component tree**, and editing
happens **in-context on the live page**.

> **The repository is the CMS, and the running site is the editing UI.**

This initiative pushes harder on that paradigm and deletes the seams that still echo the old
model. Six workstreams, ordered by leverage-to-effort.

## 2. Goals / Non-goals

**Goals**
- Eliminate duplicated authoring (schemas defined once).
- Make "edit → review → publish" a first-class, git-backed workflow.
- Turn content history into git history (audit, blame, revert, PR review for free).
- Extend caretize so an existing content-driven Astro site becomes editable in ~one command.
- Keep core dependency-free and storage-agnostic (the property that enables all of the above).

**Non-goals**
- Replacing the optimistic-concurrency model (revisions stay).
- Forcing git on non-filesystem deployments (KV/R2 stay first-class; git is opt-in).
- Building a parallel admin form-builder as the primary editing surface (in-context stays primary).
- Multi-tenant SaaS auth/identity (out of scope; only enough editor identity for drafts).

## 3. Current architecture (as found)

- **Mutation path (the choke point):** `POST /api/cms/mutate` → `executeMutation`
  (`engine.ts`) → per-key promise-chain lock `entry::<collection>::<id>` →
  `getRevision` (409 on mismatch) → `getEntry` → mutate in memory → `adapter.writeEntry`
  (atomic `rename(2)`) → `bumpRevision` → `appendHistory`. The **only** other write site is
  the restore path in `routes/history.ts` (`withEntryLock`).
- **Sidecar** (`.caretcms/`) owns revisions (`revisions.json`), per-entry history (50 deep),
  and collection metadata — none of which live in the content files.
- **Schemas** flow: `caret({ schemas })` → `createSchemasPlugin` serializes to
  `virtual:caretcms/schemas` → `registerCollectionSchema` (registry Map) →
  `GET /api/cms/schema` (3-tier: explicit → dynamic metadata → inferred) → Studio `renderFields`.
  Core consumes **plain JSON Schema** and is Zod-agnostic by design.
- **Overlay** (`session-overlay-adapter.ts`): a base+overlay merge with tombstones, wired
  per-request in `middleware.ts` via `adapter.makeSessionOverlay(sessionId)` (demo mode only).
  Only the Cloudflare KV adapter implements `makeSessionOverlay` today.
- **caretize tiers:** Tier-1 literal-const loops (`wrap.ts`), Tier-2 component-prop literals
  (`props.ts`), Tier-3 import-backed loops (`import-wrap.ts`), Tier-4 prop hoisting
  (`prop-hoist.ts`). `getCollection().map()` loops are **flagged** (`IteratorFlag`), not bound.

---

## W1 — Single-source schemas (`@caretcms/zod`)  ·  *quick win, do first*

**Problem.** Users hand-write `caret.schemas.mjs` (JSON Schema for the Studio) **and** a Zod
schema in `content.config.ts` for the same fields. They drift. (See the field-by-field
duplication audit in §Appendix A — `date`, `cover`, labels all diverge already.)

**Approach.** A **separate optional package** `@caretcms/zod` that converts a content-collection
Zod schema into the JSON-Schema map core expects. **Zero core changes** — the output is a plain
`Record<string, Record<string, unknown>>` handed to `caret({ schemas })`. Core stays Zod-agnostic;
`zod` (and `zod-to-json-schema` for Zod 3) are *that package's* peer deps, used only in
`astro.config.mjs` (build-time, never in the SSR bundle). Mirrors the `@caretcms/cloudflare` seam.

```js
// astro.config.mjs
import { schemasFromCollections } from "@caretcms/zod";
import { collections } from "./src/content.config.ts";
caret({ schemas: schemasFromCollections(collections) });
```

**Integration point.** Only `CaretOptions.schemas` (consumed at `index.ts` `resolveCaretOptions`
→ `createSchemasPlugin`). Nothing downstream changes.

**Contracts to preserve.** Output must satisfy `CollectionSchema` (`types.ts`): top-level
`type:"object"` + `properties`. `buildTemplate` walks `properties` only.

**Risks / mapping gaps.**
- CaretCMS `format` hints (`"image"`, `"html"`, `"date"`) have **no Zod equivalent** → need an
  annotation escape hatch (`z.string().meta({ format: "image" })` in Zod 3.24+, or a convention map:
  `z.coerce.date()`→`date`, `z.string().url()`→`uri`).
- Field label: Studio reads `prop.title`; Zod emits `description` from `.describe()` → promote
  `description`→`title`.
- `z.coerce.date()` → emit `{type:"string", format:"date"}`, not `{type:"object"}`.
- Non-`z.object()` roots must be rejected with a clear error.

**Acceptance.** `content-site` deletes `caret.schemas.mjs` for `blog` and derives it from
`content.config.ts`; Studio shows identical labels/inputs; unit tests cover each mapping + each gap.

**Effort.** S–M (new tiny package + tests; no core risk).

---

## W2 — Drafts & Publish (promote the overlay)  ·  *highest delight / least new code*

**Problem.** Edits write straight to the published base. There is no "preview my changes, then
publish." Yet the hard part — a base+overlay merge with tombstones — **already exists**
(`session-overlay-adapter.ts`), used only for demo sandboxes.

**Approach.** Promote the per-session ephemeral overlay to a **per-editor persistent draft**:
edits land in the editor's overlay; the public site reads base; an authenticated editor in
*preview mode* reads the overlay; **Publish** flushes overlay→base (→ a git commit once W3 lands).

**Components to add.**
1. **Editor identity** — add `editorId` to the `caret_session` token payload (`auth/session.ts`,
   `SessionPayload` is currently `{ editor:true, exp }`). Update `buildToken`/`parseToken`.
2. **`makeEditorOverlay(editorId)`** on `StorageAdapter` (optional, peer to `makeSessionOverlay`).
   Implement for Filesystem (`.caret/drafts/<editorId>/` + sidecar), KV (prefix `draft/<editorId>/`,
   **no TTL** — unlike demo's 2h), and InMemory (for tests). Markdown delegates to a filesystem
   draft root (source-file overlay makes no sense in place).
3. **Preview toggle** — a cookie or `?preview=1`; in `middleware.ts`, add a branch:
   `isEditorAuthenticated && previewMode` → install `SessionOverlayAdapter(base, makeEditorOverlay)`.
   Keep the existing `editor` flag (drives stega) independent of overlay selection.
4. **`POST /api/cms/publish`** `{ collection?, id? }` — per-entry `withEntryLock`: read overlay →
   tombstone ⇒ `base.deleteEntry`, else `base.writeEntry`+`bumpRevision`+`appendHistory("publish")`
   → clear overlay entry. Return new base revisions.
5. **`DELETE /api/cms/draft`** — discard overlay without publishing.
6. **Editor UI** — preview toggle + Publish/Discard buttons in the editor chrome / Studio.

**Contracts to preserve.** Reuse `withEntryLock` (exported from `engine.ts`). Lock key must be
**namespaced by editor** (`entry::<editorId>::<collection>::<id>`) so two editors' overlay writes
don't false-share a lock.

**Risks.**
- **Revision divergence (critical):** overlay revisions are isolated; after publish the base bumps
  to a *different* number than the editor's cached revision → guaranteed 409 on next edit. Publish
  response **must** return new base revisions and the client must reconcile (or reset overlay
  revisions to match).
- **Publish-all atomicity:** N entries with per-entry locks is not atomic; document it and return
  the exact list of committed entries.
- Filesystem/InMemory need a `makeEditorOverlay` implementation (only KV has the overlay method today).

**Acceptance.** An authed editor toggles preview, edits, sees changes only in preview; public view
unchanged; Publish promotes them; edit-after-publish does not 409; Discard reverts.

**Effort.** M–L (adapters + endpoint + UI; engine reuse keeps it contained).

---

## W3 — Git-native content history (`gitStorage`)  ·  *the defining differentiator*

**Problem.** History is a `.caretcms/` sidecar + `.caretize-bak` backups — reinventing version
control next to the real one. Content edits *are* diffs; git can own them, unlocking blame,
revert, branch-per-draft, **PR review of content**, and atomic content+code.

**Approach.** An **opt-in, best-effort** post-write commit. Not a new adapter necessarily — a
`postWrite` hook fired inside the engine, guarded so it only runs on a filesystem-backed adapter
inside a git repo.

**Integration point (single choke).** In `engine.ts`, after `adapter.writeEntry` succeeds, at
**command granularity** (one commit per `executeMutation`, not per entry — `reorder_entries` writes
many entries in a loop). Mirror the hook in the restore path (`routes/history.ts`). Author = editor
(needs W2's `editorId`), message = action + scope (`edit pages/home: headline`).

**Contracts to preserve.**
- Keep the `getRevision → writeEntry → bumpRevision` unit intact; **git is best-effort** — a commit
  failure logs and never blocks the 200 or skips `bumpRevision`.
- Run the commit **after** `atomicWrite`'s `rename(2)`, never during the `.tmp` write.
- Don't shell out synchronously inside the lock/`serializeWrite` chain — use a background queue
  (fire-and-forget with error logging) or a bounded `spawn` with timeout.

**What the sidecar still owns (do NOT remove):** revision counters (commit SHAs aren't monotonic
concurrency tokens), pre-mutation history snapshots (git stores after, not the labeled before),
collection metadata.

**Risks.**
- **Non-git deployments (KV/R2):** must be guarded by startup detection (`.git` present + filesystem
  adapter); unguarded it crashes every KV write.
- **Overlay writes (demo + W2 drafts) must NOT commit** — only Publish commits.
- `MarkdownAdapter.deleteCollection` intentionally leaves source files; a "delete" commit would need
  explicit `git rm` — document as a known limitation.
- `git reset --hard` by an operator desyncs sidecar revisions (acceptable; out-of-band action).

**Acceptance.** On a filesystem site in a git repo, each save (or publish) produces one commit
authored by the editor with a descriptive message; KV deployments are unaffected; concurrent edits
don't corrupt; toggle/flag controls the feature.

**Effort.** M (contained hook + guard + queue), but high-care (touches the write path).

---

## W4 — caretize `--bind-collections` (Tier-5)  ·  *adoption lever*

**Problem.** caretize *flags* `getCollection().map()` loops but won't bind them. Closing this makes
"existing content-driven Astro site → editable" near one command.

**Approach.** A new opt-in tier that, for the **direct-render case**, emits
`const g = bindEntry({ collection, id: item.id })` in the loop body and `{...g("field")}` spreads on
the native elements that render `item.data.field`. (The content-site **gallery** loop is the exact
target shape; see `index.astro:45-58`.)

**Detection (extend the flag).** `IteratorFlag` carries only `{startOffset, method, receiver}`. Add:
- `collectionName` — scan frontmatter for `const <receiver> = … getCollection("X")…` (new
  `getCollectionCalls(fmText)` in `frontmatter.ts`; handle `.sort().slice()` chains via the existing
  bracket balancer).
- `itemParam` — already extractable via `mapParamIdents`/`readCallbackFirstParam` (`usage.ts:110,148`);
  just surface it.
- `accessedFields` — regex `<itemParam>\.data\.(\w+)` over the expression text (`expressionText`,
  `detect.ts`).
- entry id — convention `<itemParam>.id` (true for `getCollection` and `getLiveCollection`).

**Pipeline slot.** Add a 5th pass in `cli.ts:analyzeFiles` → `bindsByFile`; extend `Analysis`,
`selectChanges`, `prepareTouched`, and the flag-suppression filter (suppress flags whose receiver a
bind tier covered). New `--bind-collections` flag in `cli-args.ts` (default off → diagnostic only).
Transform + verify in `run.ts` (reuse the `parseAstro` re-parse gate; the spread splice reuses
`splice.ts`).

**Hard parts (scope explicitly).**
- **Component-prop case** (`<PostCard title={post.data.title}/>`, the blog index): the element to
  bind is in *another file* → defer to a later phase reusing Tier-2/4 cross-file resolution. v1 handles
  **direct-render only**; component-prop stays a flag.
- **Concise→block arrow rewrite:** injecting a `const g = …` needs a block-body arrow; converting
  `(post) => (<li>…)` to `(post) => { const g=…; return (<li>…); }` is a deletion-bearing rewrite,
  **not** pure insertion → needs its own inverse gate (model on `verifyHoistResult`).

**Acceptance.** `caretize --bind-collections` turns the gallery-style loop in a fixture
(`starlog-index.astro`) from a flag into working `bindEntry()` bindings that re-parse; dry-run shows
the plan; component-prop loops still flag with a clear message.

**Effort.** L (the arrow-body rewrite + new detection are the most invasive caretize work yet).

---

## W5 — In-context primacy (product principle)  ·  *guardrail, not a build*

Keep in-context editing the **primary** surface; Studio earns its keep for **structural** ops
(list/create/reorder/delete) and fields with no on-page representation (SEO meta, draft flags).
Bias new work toward making more of the site directly editable rather than adding admin forms.
Action: write this as a contributing/design principle; review new Studio form work against it.

**Effort.** XS (doc + review norm).

---

## W6 — Deployment/topology matrix (docs)  ·  *make the seam visible*

Same content code runs over filesystem, markdown, in-memory, or Cloudflare KV/R2 — "no CMS to host,"
edit-native, content lives where it fits. Document the matrix (git-backed editorial vs KV-backed
high-write) as a first-class choice, not an implementation footnote. Ties together W3 (git path) and
the existing cloud path.

**Effort.** S (docs).

---

## 4. Sequencing

1. **W1** (single-source schemas) — isolated, no core risk, removes daily friction. *Start here.*
2. **W2** (drafts/publish) — highest delight; engine + overlay already exist.
3. **W3** (git-native) — the strategic bet; lands cleanly *after* W2 supplies `editorId` and the
   Publish choke-point to commit at.
4. **W4** (caretize bind) — parallelizable with W2/W3 (separate package); ship direct-render first.
5. **W5/W6** — continuous (docs + review norms).

## 5. Success metrics
- Schema lines authored per collection: **2 sources → 1**.
- "Edit → preview → publish" exists and round-trips without a 409.
- A content edit appears as a git commit authored by the editor (filesystem deployments).
- caretize converts a flagged `getCollection` loop into a working binding on the fixture corpus.
- Core runtime dependencies: **still 0**; KV/R2 path unaffected by W3.

## 6. Open questions
- W2: per-editor overlay backing for filesystem — `.caret/drafts/<editorId>/` layout + sidecar reuse?
- W3: commit cadence — every save vs only on Publish (W2 makes "only on Publish" attractive: drafts
  stay out of git noise, publishes are the meaningful commits). **Recommendation: commit on Publish.**
- W3: batch a "publish all" into a single commit (cleaner history) vs per-entry commits.
- W1: standardize the format-hint annotation (`.meta({format})`) and document the supported set.

## Appendix A — `content-site` schema duplication (blog)
| Field | Zod (`content.config.ts`) | JSON Schema (`caret.schemas.mjs`) | Divergence |
|---|---|---|---|
| title | `z.string()` | `string, title:"Title"` | label only in JSON |
| excerpt | `z.string()` | `string, title:"Excerpt"` | label only in JSON |
| date | `z.coerce.date()` | `string, format:"date"` | type + format diverge |
| author | `z.string()` | `string, title:"Author"` | label only |
| tags | `z.array(z.string()).default([])` | `array<string>, title:"Tags"` | label; default |
| cover | `z.string().optional()` | `string, format:"image"` | format + label |
| cover_alt | `z.string().optional()` | `string, title:"Cover alt text"` | label |

`site`, `pages`, `gallery`, `team` exist only in `caret.schemas.mjs` (no Zod counterpart).
