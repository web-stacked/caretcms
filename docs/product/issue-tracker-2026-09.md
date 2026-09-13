# CaretCMS — verified issues and improvement tracker

Audit date: **2026-09-05**. This is the working backlog from the code review and
browser investigation. It covers the working tree at that date, including
uncommitted work; it is not a claim that every finding applies to the published
npm release.

**FIX-001 through FIX-012 are implemented and verified locally.** These changes
are committed on `main`; no release has been created. The confirmed-behavior and
reproduction descriptions below preserve the **before-fix audit evidence**.
**EXT-001 (paragraph editing), EXT-002 (multiline YAML), EXT-003 (write
permissions), and MAINT-001 (browser-module maintenance) are also verified
locally. EXT-004 (coordinated Cloudflare storage) and EXT-005 (deployment
status) are verified locally and against deployed services.** Other optional
extensions remain in the backlog.

Final validation: `npm run check:all` passed — **1,012 unit tests in 111 files**,
all three example builds, and **65 Chromium E2E tests** (40 standard, 2 CSP,
15 Markdown, 5 static, 2 permissions, 1 Cloudflare Durable Object). Additional local browser experiments verified webhook
timeout/retry, both draft-conflict variants, and three toolbar viewport widths.

Implementation limits and migration instructions:
[publish recovery](../publish-recovery.md) and
[frontmatter compatibility](../markdown-frontmatter.md), plus
[browser module maintenance](../browser-maintenance.md) and
[paragraph editing](../markdown-paragraph-editing.md), plus the
[authorization policy](../authorization-policy.md), and
[coordinated Cloudflare storage](../cloudflare-durable-storage.md).

## How to use this tracker

- Assign an owner and link the implementation PR in the index when work starts.
- Mark a task complete only after its acceptance checks pass. Record test commands
  and browser results in its verification record.
- Preserve existing uncommitted changes. Recheck the current implementation before
  applying a fix; source links identify starting points, not frozen line numbers.
- Keep core dependency-free and storage-agnostic. Add platform-specific work in
  sibling packages, preserve public adapter compatibility, and retain contract
  parity tests when changing shared contracts.
- Use isolated example copies or disposable fixtures for destructive failure
  tests. Never corrupt normal example content to reproduce a failure.

## Status and order

High priority means content preservation or basic access to existing content.
Medium priority means recovery, diagnostics, or interaction reliability.

| ID | Work item | Priority | Status | Owner / PR |
| --- | --- | --- | --- | --- |
| [FIX-001](#fix-001--preserve-newer-content-when-publishing-drafts) | Drafts silently overwrite newer content | High | Verified locally | `main` / direct integration |
| [FIX-002](#fix-002--recover-from-partial-publish-failures) | Partial publishing leaves inconsistent state | High | Verified locally | `main` / direct integration |
| [FIX-003](#fix-003--make-all-collection-entries-accessible) | Studio hides entries after the first 24 | High | Verified locally | `main` / direct integration |
| [FIX-004](#fix-004--bound-rebuild-hook-waits-and-allow-retry) | Rebuild hooks hold publishing open | Medium | Verified locally | `main` / direct integration |
| [FIX-005](#fix-005--distinguish-unreadable-content-from-missing-content) | Parse errors are shown as missing entries | Medium | Verified locally | `main` / direct integration |
| [FIX-006](#fix-006--prevent-development-toolbar-overlap) | Astro toolbar blocks Caret controls | Medium | Verified locally | `main` / direct integration |
| [FIX-007](#fix-007--make-the-studio-delete-confirmation-a-real-modal) | Delete confirmation loses modal and focus context | Medium | Verified locally | `main` / direct integration |
| [FIX-008](#fix-008--make-studio-history-a-keyboard-managed-disclosure) | History panel has no disclosure or focus context | Medium | Verified locally | `main` / direct integration |
| [FIX-009](#fix-009--make-the-studio-create-entry-overlay-a-real-modal) | Create Entry overlay lacks modal and keyboard containment | Medium | Verified locally | `main` / direct integration |
| [FIX-010](#fix-010--make-collection-reordering-keyboard-operable) | Collection ordering is drag-only and loses mode focus | Medium | Verified locally | `main` / direct integration |
| [FIX-011](#fix-011--show-complete-collection-counts-on-studio-home) | Studio home truncates collection counts at 24 | Medium | Verified locally | `main` / direct integration |
| [FIX-012](#fix-012--identify-duplicate-entry-ids-across-pages) | Off-page duplicate IDs show a generic creation failure | Medium | Verified locally | `main` / direct integration |

Recommended order: **FIX-001 → FIX-002 → FIX-003 → FIX-004 → FIX-005 → FIX-006 → FIX-007 → FIX-008 → FIX-009 → FIX-010 → FIX-011 → FIX-012**.
FIX-001 and FIX-002 share draft/publish contracts and should be designed together.
FIX-003, FIX-005, and FIX-006 can be implemented independently. Coordinate
FIX-004's response and retry behavior with FIX-002.

All twelve defects can be fixed and regression-tested locally without external
accounts. This does not imply that arbitrary third-party storage supports
transactions or that deployment-provider behavior has been verified.

## Verification baseline

- The initial `npm run check` passed, including **858 tests in 87 unit test files**.
- Browser checks used Chromium and isolated copies of `examples/starter` in
  static authoring mode and `examples/content-site` as a production Node build.
- Separate authenticated browser contexts reproduced the draft conflict.
- Browser observations were checked against API responses and stored files.
- A local HTTP server reproduced an unresponsive rebuild hook; no external CI or
  deployment service was contacted.
- A separate backend characterization test reproduced partial multi-entry
  publishing. That test asserted the existing defect; its passing result did not
  mean publishing was correct.
- The full existing E2E suite was **not** run during the investigation.

## Confirmed defects

### FIX-001 — Preserve newer content when publishing drafts

**Status:** Verified locally · **Priority:** High · **Owner / PR:** `main` / direct integration

**Confirmed behavior:** In static delivery, editor A saved a headline draft,
editor B published a newer headline, and A then published. The stored headline
reverted to A's older text. Both publishes returned HTTP 200 with
`conflicts: []`.

The same problem occurred with **different fields**: A changed the headline and
B changed the section heading. After B published, A's publish reverted B's section
heading even though A never edited it.

**Reproduce:**

1. Start a static authoring fixture with a published entry containing two fields.
2. Sign in using two separate browser contexts, A and B.
3. A edits and saves a draft. B edits the same field and publishes first.
4. A publishes. Inspect the response and the published storage value.
5. Repeat with A and B editing different fields of the same entry.

**Code starting points:** [mutation engine](../../packages/core/src/runtime/mutations/engine.ts),
[draft overlay](../../packages/core/src/runtime/storage/session-overlay-adapter.ts),
[publisher](../../packages/core/src/runtime/publish.ts),
[storage contracts](../../packages/core/src/types.ts).

The field mutation clones the merged entry into the overlay. Publishing treats
the resulting snapshot as field deltas and shallow-merges it into current
content. Overlay revisions do not establish whether the published base changed
since the draft began. This is a local draft problem, separate from KV's
distributed concurrency limitation. Current server delivery saves structured
fields directly; the browser reproduction used normal static drafting.

**Changes to make:**

- [x] Persist a draft baseline or starting base revision, separate from the
      revision used to serialize edits within that draft.
- [x] Use a baseline plus whole-entry conflict checks for field saves and
      whole-entry saves (the conservative initial alternative to field merging).
- [x] Detect stale-base conflicts before publishing or deleting content; retain
      the draft and provide a useful conflict response.
- [x] Preserve newer changes to fields the draft did not edit. A conservative
      whole-entry conflict is acceptable as an initial safe implementation;
      automatic merging must not overwrite unrelated changes.
- [x] Define behavior for nested fields, arrays, deletions, recreated entries,
      and drafts created before the new metadata exists.
- [x] Display conflict recovery in the browser without silently losing the
      editor's draft.

**Acceptance checks:**

- [x] Two editors changing the same field produce an explicit conflict.
- [x] Two editors changing different fields preserve B's publication when A
      publishes, or safely reject A's stale draft with recovery available.
- [x] Reloading or restarting preserves draft conflict protection.
- [x] Draft deletion cannot silently delete an entry changed since drafting.
- [x] Browser results, API outcomes, and stored data agree.

**Verification record:** `tests/unit/publish-recovery.test.ts` covers same-field
and disjoint conflicts, direct base edits without a revision bump, deletion,
legacy drafts, and full replacement. `tests/e2e/static-delivery.spec.ts` checks
two editor contexts, response, retained draft, and stored newer content. Separate
browser edits of the starter's headline/section reproduced both original cases:
A now receives `stale_entry`, and B's stored entry remains unchanged. Baseline
metadata is persisted with the draft; a reload does not reset it.

**Chosen scope:** All structured edits are treated as whole-entry snapshots.
Nested fields and arrays therefore use the same conservative conflict rule;
automatic field merging remains future work.

### FIX-002 — Recover from partial publish failures

**Status:** Verified locally · **Priority:** High · **Owner / PR:** `main` / direct integration

**Confirmed behavior:** A history-file write failed after publishing a Markdown
body edit. The browser displayed `Publish failed` and received HTTP 500, but the
source file already contained the edit. The draft remained. Once the storage
obstruction was removed, retrying returned `stale_body` with no entries published.

A backend reproduction also showed that a history failure on the second entry
of a bulk publish changes both entries, clears only the first draft, and throws
without returning the list of completed entries.

**Reproduce in a disposable fixture only:**

1. Edit a Markdown paragraph in the browser and blur to save its draft.
2. Verify the source file has not changed yet.
3. Create a directory at the expected history-file path, such as
   `.caretcms/history/blog/<entry-id>.json`, so history persistence will fail.
4. Click Publish. Inspect the HTTP response, UI, source, revision, and draft.
5. Remove the test obstruction and retry Publish. Observe the stale-body conflict.

**Code starting points:** [publisher](../../packages/core/src/runtime/publish.ts),
[publish route](../../packages/core/src/runtime/routes/publish.ts),
[Markdown adapter](../../packages/core/src/runtime/storage/markdown-adapter.ts),
[filesystem adapter](../../packages/core/src/runtime/storage/filesystem-adapter.ts),
[metadata store](../../packages/core/src/runtime/storage/sidecar-meta-store.ts),
[toolbar](../../packages/core/static/cms/editor/toolbar.js).

Body splicing, frontmatter writes, revision increments, history persistence, and
draft cleanup happen separately. The entry lock serializes concurrent calls;
it does not roll back prior writes or recover from interruption.

**Changes to make:**

- [x] Define per-entry commit/recovery semantics for built-in adapters, including
      the relationship between content, revision, history, and draft cleanup.
- [x] Implement recoverable commits or journaling where appropriate. Do not
      promise universal transactions through the existing generic adapter API.
- [x] Make retries safe when an earlier attempt already changed source content.
- [x] Return curated JSON and explicit completed, conflicted, failed, or
      recovery-required outcomes for bulk publication.
- [x] Preserve enough information to restore or finish an interrupted publish.
- [x] Surface partial completion accurately in the browser and retain recoverable
      drafts instead of reporting an undifferentiated failure.
- [x] Coordinate git and rebuild hooks with the content that actually committed.

**Acceptance checks:**

- [x] Inject failures at body/source write, frontmatter write, revision update,
      history append, and draft cleanup boundaries.
- [x] Each failure leaves a documented recoverable state with truthful API/UI
      feedback; a retry completes safely or provides an explicit recovery path.
- [x] A two-entry failure reports what already completed.
- [x] Repeating a successful operation does not duplicate history or apply edits
      a second time unexpectedly.
- [x] Test restart recovery where the implementation claims crash recovery.
- [x] Repeat the history-file obstruction in the browser and verify source,
      revision, history, and draft state after recovery.

**Verification record:** `tests/unit/publish-recovery.test.ts` injects failures
before/after entry and combined Markdown/frontmatter writes, revision changes,
history writes, and draft cleanup; it also covers bulk results, intervention
during recovery, and a fresh Markdown adapter after failure. The Markdown browser
suite repeats the real history-path obstruction: the UI reports recovery, retry
finishes with revision 1, one history snapshot, and zero drafts. History read
failures now propagate rather than being treated as an empty history.

**Guarantee:** Forward recovery with consistent, serialized storage; no atomic
bulk transaction or distributed KV guarantee. See the recovery guide.

### FIX-003 — Make all collection entries accessible

**Status:** Verified locally · **Priority:** High · **Owner / PR:** `main` / direct integration

**Confirmed behavior:** A collection contained 30 entries. The API reported
`total: 30`, `pageSize: 24`, `totalPages: 2`, and `hasNext: true`. Studio displayed
24 cards and `24 entries`, without next-page controls. Searching for ID `30`
displayed `No entries yet.` The API's second page contained IDs 25–30.

**Reproduce:** Seed 30 valid entries, open their Studio collection, compare its
count with the entries API, then search for an entry beyond the first page.

**Code starting points:** [collection page](../../packages/core/src/runtime/routes/collection-list.ts),
[entries API](../../packages/core/src/runtime/routes/entries.ts),
[messages](../../packages/core/src/runtime/i18n.ts).

Studio ignores pagination metadata and searches only its loaded entries. The
existing API query searches IDs, while Studio's local search also searches the
display title. Preserve that behavior when moving search to the server.

**Changes to make:**

- [x] Consume pagination metadata and provide accessible page navigation.
- [x] Show accurate totals and the visible range.
- [x] Search across the collection by ID and display title, including entries
      outside the current page; reset pagination when the query changes.
- [x] Distinguish an empty collection from no matching search results.
- [x] Define safe collection reordering across pages; do not submit an incomplete
      list as if it represented the whole collection.
- [x] Handle creating/deleting entries on the last page and stale search responses.
- [x] Add English/Spanish messages for new controls and states.

**Acceptance checks:**

- [x] All 30+ entries can be reached through Studio navigation.
- [x] ID and title searches find entries originally on page 2.
- [x] Counts remain accurate after search, creation, and deletion.
- [x] Reordering does not accidentally alter or exclude unseen entries.
- [x] Keyboard navigation and a small viewport can operate pagination controls.

**Verification record:** `tests/unit/entries-read-errors.test.ts` covers 30 IDs,
page clamping, title search beyond page one, empty results, and protection against
creating an existing revision-zero ID. The Studio browser regression traverses
31 entries, searches the page-two title, clears search, uses keyboard pagination
at 390px, deletes the last-page entries, and verifies the remaining count.
Existing Studio CRUD tests cover creation and returning to the collection.

**Chosen scope:** Reorder is disabled with an explanatory message when a query,
multiple pages, or an unreadable entry means the whole collection is not loaded.
The UI does not submit a partial order. Creation uses `put_entry.createOnly` so
an ID outside the visible page cannot be replaced.

### FIX-004 — Bound rebuild-hook waits and allow retry

**Status:** Verified locally · **Priority:** Medium · **Owner / PR:** `main` / direct integration

**Confirmed behavior:** A local rebuild hook accepted the request but sent no
response. After 6.9 seconds the browser still showed `Publishing…`; content was
already written and the editor's draft count was zero. The experiment ended
there, so it does not prove an infinite wait. The code has no application-level
timeout; runtime/network limits may eventually terminate the request.

**Reproduce:** Point a disposable site's publish hook at a local HTTP server that
does not respond. Publish a draft through the browser and inspect content,
draft count, the pending request, and toolbar state.

**Code starting points:** [webhook](../../packages/core/src/runtime/rebuild-webhook.ts),
[publish route](../../packages/core/src/runtime/routes/publish.ts),
[toolbar](../../packages/core/static/cms/editor/toolbar.js),
[delivery configuration](../../packages/core/src/index.ts).

**Changes to make:**

- [x] Give hook requests a documented, bounded timeout and abort them on expiry.
- [x] Report that content committed even when triggering a deploy failed.
- [x] Provide an authenticated, CSRF-protected retry action that works after the
      original drafts have been cleared.
- [x] Preserve the relevant publish payload for retry and define duplicate-hook
      handling without promising exactly-once delivery.
- [x] Keep tokens, configured authorization headers, and private hook details out
      of browser-visible errors.
- [x] Add automatic retries only if durable scheduling and retry limits are
      implemented; otherwise ship an explicit manual retry.

**Acceptance checks:**

- [x] Hanging, non-successful, and unreachable hooks return bounded outcomes.
- [x] A timeout does not lose content or incorrectly imply that publication
      itself was rolled back.
- [x] Retry succeeds with zero remaining drafts and does not republish content.
- [x] The browser leaves `Publishing…` and gives an actionable result.
- [x] Missing hooks and successful hooks continue to behave correctly.

The current UI already reports explicit unsuccessful webhook responses. Knowing
whether a remote deployment finished is separate work under EXT-005.

**Verification record:** Unit tests cover successful, absent, failed, unreachable,
and aborted hooks, plus retry payload reuse with unchanged content revision and
history. A production Node fixture and a real local hanging HTTP hook returned
in **5.897 seconds** through the browser with `Rebuild webhook timed out`,
`Published, deploy failed`, zero drafts, and a visible Retry deploy button.
Reload retained the button; retry succeeded with `published: []`, unchanged
source bytes, and revision 1 before and after.

**Chosen scope:** Manual retry only. Persistent receipts depend on the adapter;
HTTP acknowledgement is not deployment completion or exactly-once delivery.

### FIX-005 — Distinguish unreadable content from missing content

**Status:** Verified locally · **Priority:** Medium · **Owner / PR:** `main` / direct integration

**Confirmed behavior:** An existing Markdown entry with a YAML multiline caption
(`caption: |`) returned HTTP 500. Studio displayed `Entry not found.` The file
existed and otherwise matched the collection schema.

**Reproduce:** Add a valid multiline YAML string to a disposable Markdown entry,
open that entry in Studio, and inspect its entries API response.

**Code starting points:** [frontmatter codec](../../packages/core/src/runtime/storage/frontmatter-codec.ts),
[Markdown adapter](../../packages/core/src/runtime/storage/markdown-adapter.ts),
[entries API](../../packages/core/src/runtime/routes/entries.ts),
[entry UI](../../packages/core/static/cms/admin-entry.js),
[messages](../../packages/core/src/runtime/i18n.ts).

The codec intentionally rejects multiline block scalars. The defect here is the
unhandled read error and misleading not-found screen. Broader YAML support is
tracked separately as EXT-002.

**Changes to make:**

- [x] Separate missing-entry, unsupported-format, malformed-content, and storage
      failure outcomes where the adapter can identify them.
- [x] Return safe structured errors from the read API.
- [x] Show useful error and retry/help states in Studio instead of the missing
      entry screen for every failed read.
- [x] Prevent initialization or saves from overwriting content that failed to parse.
- [x] Define collection-list behavior when an entry cannot be read, so users can
      identify the affected entry without misleading counts or missing-data claims.

**Acceptance checks:**

- [x] Unsupported syntax is identified accurately without changing bytes.
      Literal/folded multiline YAML is now supported by EXT-002.
- [x] Truly missing entries still display a missing-entry state.
- [x] Permission/I/O failures and malformed content produce useful, distinct
      diagnostics where possible, without exposing secrets or stack traces.
- [x] Correcting the source and retrying loads the existing entry normally.
- [x] Verify the error and recovery path in the browser.

**Verification record:** Unit tests distinguish unsupported, invalid, storage,
and missing-entry responses while preserving other collection cards. The
Markdown browser suite now uses an unsupported anchor to verify the error
message, unchanged bytes, and Retry after source correction. Block scalars,
which demonstrated the original defect, are supported by EXT-002 below. The
affected collection card remains visible.

### FIX-006 — Prevent development-toolbar overlap

**Status:** Verified locally · **Priority:** Medium · **Owner / PR:** `main` / direct integration

**Confirmed behavior:** At 1280×850, tabbing out of the starter's final editable
heading activated Astro's development toolbar over Caret's bottom toolbar.
Publish clicks were intercepted by `<astro-dev-toolbar>`. The main publishing
reproductions succeeded at a 1920-pixel viewport.

**Reproduce:** Run the starter in static authoring mode with Astro's dev toolbar
enabled. At 1280×850, focus the last editable heading, press Tab, and attempt to
click Caret's Publish button.

**Code starting points:** [toolbar styles](../../packages/core/static/cms/editor/toolbar.css),
[toolbar behavior](../../packages/core/static/cms/editor/toolbar.js),
[existing dev-toolbar tests](../../tests/e2e/dev-toolbar.spec.ts).

**Changes to make:**

- [x] Give both toolbars usable space in development, including when Astro's
      toolbar opens or gains keyboard focus.
- [x] Preserve normal production placement and responsive controls.
- [x] Avoid solving one blocked toolbar by covering the other with a higher
      stacking order.

**Acceptance checks:**

- [x] At 1280×850 with Astro's toolbar open, a real click reaches Publish and
      completes the confirmation and publish flow.
- [x] Keyboard users can reach and operate controls in both toolbars.
- [x] Verify narrow and wide viewports, plus production without Astro's toolbar.

**Verification record:** The static browser suite activates keyboard focus from
the editable heading and clicks Publish at 1280×850. Separate Chromium checks
at widths **390, 1280, and 1920** verify the Publish button receives hit testing
and accepts pointer interaction after Tab. Keyboard focus + Enter also opens
Astro's CaretCMS panel. Production Markdown/CSP suites pass without the dev dock.
The adjustment reserves 72px above Astro's dock rather than increasing z-index.

### FIX-007 — Make the Studio delete confirmation a real modal

**Status:** Verified locally · **Priority:** Medium · **Owner / PR:** `main` / direct integration

**Confirmed behavior:** Chromium displayed the destructive confirmation, but
`getByRole("dialog", { name: "Delete Entry" })` could not find it because the
overlay had no dialog semantics or accessible name. Opening it left focus on
the background Delete button. Cancel, backdrop click, and Escape hid the overlay
without restoring focus, and Tab was free to leave the visible modal. Inside the
sidebar Studio, Escape could also reach the parent iframe listener and close the
entire Studio drawer. Once exposed as a dialog, axe also confirmed insufficient
contrast on the destructive action and a skipped heading level.

**Changes made:** The overlay is now a named `aria-modal` dialog with its copy
connected as the description. Opening focuses Cancel as the safe action. Tab and
Shift+Tab cycle through enabled dialog buttons. Cancel, backdrop click, failed
deletion, and Escape share one close path that restores the invoking control.
The dialog consumes its own Escape event so an embedded Studio drawer remains
open. The modal title follows the page heading order, and the destructive action
uses a theme-derived dark danger surface with a fixed fallback that retains white
text contrast.

**Acceptance checks:**

- [x] Chromium locates the confirmation by its dialog role and accessible name.
- [x] Opening focuses Cancel and keyboard traversal remains inside the dialog.
- [x] Escape closes the confirmation and restores focus to Delete.
- [x] Embedded Escape leaves the parent Content Studio drawer open.
- [x] The open modal passes axe, including heading order and color contrast.
- [x] Successful confirmation still deletes and returns to the collection.

**Verification record:** The original focused Chromium run failed because no
dialog role existed. The first open-dialog axe run then exposed the contrast and
heading failures. After the repair, the complete CRUD flow, open-modal axe scan,
and a dedicated embedded-drawer regression pass. Strict browser JavaScript
checking also passes.

### FIX-008 — Make Studio history a keyboard-managed disclosure

**Status:** Verified locally · **Priority:** Medium · **Owner / PR:** `main` / direct integration

**Confirmed behavior:** Chromium found no `aria-controls` relationship on the
History button, and the revealed panel had no named region semantics. Opening
left focus on the toolbar action before the newly visible content. Closing by
button, Escape, or successful restore did not update expanded state or return
focus. In embedded Studio, the uncontained Escape event could also close the
parent Studio drawer.

**Changes made:** History now controls a named Version History region and reports
`aria-expanded`. Opening moves focus to the region's Close action. Button close,
Escape, and successful restore share one cleanup path that collapses the region,
clears stale rows, and restores the History button. Studio handles open-overlay
Escape during window capture, before an iframe parent listener receives it.

**Acceptance checks:**

- [x] Chromium locates the open panel as the named Version History region.
- [x] The History button reports its controlled panel and current expanded state.
- [x] Open and close move focus into the panel and back to History.
- [x] Embedded Escape closes history while preserving the Studio drawer.
- [x] The open history region passes axe and restore behavior remains intact.

**Verification record:** The initial Chromium run failed on the missing
`aria-controls` attribute. After the repair, standalone restore, embedded Escape,
strict browser checking, and the open-region axe scan pass.

### FIX-009 — Make the Studio Create Entry overlay a real modal

**Status:** Verified locally · **Priority:** Medium · **Owner / PR:** `main` / direct integration

**Confirmed behavior:** Chromium displayed the Create Entry overlay, but
`getByRole("dialog", { name: "New Entry" })` could not find it. The backdrop had
no dialog semantics or accessible name. Source inspection also confirmed that
Tab could leave the overlay, closing did not restore the New button, and Escape
was not contained before the embedded Studio drawer listener.

**Changes made:** The overlay is now a named `aria-modal` dialog whose entry-ID
guidance is its accessible description. It retains the existing initial focus
on the ID field, cycles Tab and Shift+Tab across enabled dialog controls, and
uses one close path for Close, Cancel, backdrop click, and Escape. That path
restores the exact New or Create First Entry control that opened it. Escape is
handled during capture and stopped before an embedded parent drawer can act.

**Acceptance checks:**

- [x] Chromium locates the overlay by its dialog role and New Entry name.
- [x] Initial focus lands on the ID field and keyboard traversal stays inside.
- [x] Escape closes the dialog and restores its invoking create control.
- [x] Embedded Escape leaves the parent Content Studio drawer open.
- [x] The open create dialog passes axe.
- [x] Creating a valid entry still navigates to its schema-backed editor.

**Verification record:** Before the repair, both focused interaction and
accessibility runs failed because the visible overlay had no dialog role. After
the repair, the complete Studio CRUD flow, embedded-overlay regression, open
dialog axe scan, and strict browser checking pass.

### FIX-010 — Make collection reordering keyboard operable

**Status:** Verified locally · **Priority:** Medium · **Owner / PR:** `main` / direct integration

**Confirmed behavior:** The collection reorder view exposed only draggable
`div` rows, so keyboard users could not change entry order. Chromium also found
no `aria-controls` or expanded state on Reorder. Entering the mode disabled the
focused trigger without moving focus into the revealed controls. The mode had
no Escape cancellation, and exiting did not deliberately restore focus. A
valid collection with `creatable: false` and `orderable: true` also crashed on
entry because the mode assumed its absent New button existed.

**Changes made:** Reorder now controls a named region with expanded state and a
semantic list. Every row retains drag-and-drop and gains native, localized Move
up and Move down buttons with unavailable directions disabled. Entering focuses
the first available move control, or Cancel for a single-entry collection.
Moving a row preserves useful focus on that row. Cancel and Escape reload the
collection and restore the Reorder trigger; Escape is contained inside an
embedded Studio drawer. Saving reloads current revisions and restores focus.
Optional create controls are guarded independently from ordering capability.

**Acceptance checks:**

- [x] Reorder reports its controlled region and expanded state.
- [x] Keyboard controls can change row order and the real mutation persists it.
- [x] Moving a row retains a usable focus target on that row.
- [x] Escape cancels the mode and restores the Reorder trigger.
- [x] Embedded Escape preserves the parent Content Studio drawer.
- [x] A non-creatable, orderable collection opens and exits reorder mode.
- [x] The open reorder region passes axe and pointer dragging remains available.

**Verification record:** The initial Chromium run failed on the missing
`aria-controls` relationship. After the repair, a focused browser flow moves,
cancels, repeats, saves, and reads the resulting order through the API. Embedded
Escape and an open-region axe scan also pass. A second before-fix Chromium run
reproduced the non-creatable collection crash; the guarded configuration now
opens, focuses, and exits normally.

### FIX-011 — Show complete collection counts on Studio home

**Status:** Verified locally · **Priority:** Medium · **Owner / PR:** `main` / direct integration

**Confirmed behavior:** Studio home fetched the default first page for every
collection and displayed `entries.length`. Chromium created 31 entries, opened
Studio home, and saw “24 entries” on the collection card even though the
collection page and API pagination both reported 31.

**Changes made:** Collection cards now use a safe, nonnegative integer from
`pagination.total`, which represents the complete filtered collection. The
returned page length remains the fallback when an older or malformed response
does not supply a valid total.

**Acceptance checks:**

- [x] A collection larger than the 24-entry page size shows its complete count.
- [x] Singular and plural labels still use the existing localized messages.
- [x] Missing or malformed pagination totals fall back to the page array length.
- [x] Collection pagination and cross-page search continue to work.

**Verification record:** The focused before-fix Chromium run expected “31
entries” and received “24 entries.” The same 31-entry flow passes after the
change and continues through next-page navigation and cross-page title search.

### FIX-012 — Identify duplicate entry IDs across pages

**Status:** Verified locally · **Priority:** Medium · **Owner / PR:** `main` / direct integration

**Confirmed behavior:** Create Entry checked duplicate IDs only against the
currently loaded page. With 31 entries, Chromium entered `post-30` while page
one was visible. Studio enabled Create, the server correctly rejected the
`createOnly` mutation with HTTP 409, and the dialog replaced that useful conflict
with the generic “Failed to create entry” message.

**Changes made:** A create-only 409 now stays inside the dialog and maps to the
localized duplicate-ID message. Studio remembers server-confirmed duplicates
for later input validation, disables Create, selects the conflicting ID, and
returns focus to the field so the editor can replace it. Visible-page duplicate
checks remain immediate, while the server remains authoritative across pages
and concurrent creation attempts.

**Acceptance checks:**

- [x] A duplicate on another page receives an authoritative HTTP 409.
- [x] The dialog shows the localized duplicate-ID message instead of a generic failure.
- [x] Create is disabled and focus returns to the selected ID field.
- [x] The dialog remains open so a different ID can be entered.
- [x] Pagination and cross-page search still complete after dismissing the dialog.

**Verification record:** Before the change, Chromium received 409 and displayed
“Failed to create entry. Try again.” After the change, the same 31-entry flow
displays “An entry with this ID already exists.”, retains the dialog, restores
field focus, and continues through pagination and cross-page search.

## Optional extensions and maintenance

These are backlog candidates, not additional confirmed urgent defects. Their
checkboxes track future work; inclusion does not set a release commitment.

| ID | Candidate | Evidence / scope | Status |
| --- | --- | --- | --- |
| EXT-001 | Create and restructure Markdown paragraphs | Browser verified split/merge, undo, publish/rebuild/restore | Verified locally |
| EXT-002 | Preserve multiline YAML frontmatter | Literal/folded strings and unchanged field blocks preserved | Verified locally |
| EXT-003 | Permissions and editorial review | Server and browser verify scoped, isolated write permissions | Verified locally |
| EXT-004 | Coordinated Cloudflare writes | Atomic Durable Object adapter passes local and deployed Worker concurrency checks | Verified deployed |
| EXT-005 | Track deployment completion | Simulated and GitHub providers verified; GitHub status pointed to a live Cloudflare Worker | Verified deployed |
| MAINT-001 | Smaller browser modules and type checking | Studio, inline editor, and development-toolbar entries strictly checked | Verified locally |

### EXT-001 — Markdown paragraph creation and restructuring

- [x] Scope initial operations to paragraph insertion, splitting, merging, and
      deletion before expanding to complex blocks or MDX.
- [x] Preserve source-range/hash conflict checks and draft-only body writes.
- [x] Test Enter, Backspace, paste, undo, nested content, and Unicode through
      edit → draft → publish → rebuild → restore.
- [x] Preserve or explicitly document link-title and reference-link behavior;
      the current serializer normalizes some link syntax.

**Status:** Verified locally · **Owner / PR:** `main` / direct integration

**Delivered scope:** Consecutive supported top-level paragraphs form one native
editing region. Enter splits/inserts, Backspace/Delete merge, selections delete,
and browser undo restores operations. Plain-text paste preserves paragraph breaks
and Unicode. Failed saves keep edits for retry. Inline code now survives the
shared sanitizers, with core/browser/caretize contract parity preserved.

**Source and preview behavior:** One group owns a combined source range; each
original source and its adjacency are verified before saving. Publishing checks
the complete range again. Preview reload renders the group once and removes its
consumed original stamps. A stale single-block editor cannot overwrite part of a
group. Untouched paragraphs retain their original Markdown spelling.

**Verification:** Unit tests cover structural boundaries, injection-safe
serialization, unchanged source, invalid requests, and conflicting draft ranges.
Chromium exercises split, merge in both directions, insert, selection deletion,
undo, Unicode paste, formatting, retry, nested boundaries, stale source, preview
reload, toolbar publish, a fresh build, and exact source restoration from history.
The browser also exposed stale Astro render caches; stamp versions now participate
in the rendering configuration so an upgrade rebuild refreshes markers.

**Gate:** `npm run check:all` passed: 920 unit tests in 91 files, both example
builds, and 45 browser tests (30 standard, 2 CSP, 11 Markdown, 2 static).

**Limits:** Complex/nested block restructuring and MDX remain outside this scope.
Regions and requests are bounded; unusual source syntax keeps the existing
single-block editor. Preview wrappers can affect direct-child CSS selectors.
Changed paragraphs normalize reference links and remove link titles. Browser
coverage is Chromium; other engines and mobile IME need additional validation.
See [paragraph editing](../markdown-paragraph-editing.md) for the full behavior.

### EXT-002 — Multiline YAML compatibility

- [x] Support the chosen literal/folded scalar forms without losing content,
      indentation, or chomping semantics on writes.
- [x] Preserve unrelated frontmatter formatting where possible and test round trips.
- [x] Keep unsupported constructs explicit. Full YAML support is not required to
      resolve FIX-005; use an optional package if a runtime dependency is needed.

**Status:** Verified locally · **Owner / PR:** `main` / direct integration

**Delivered scope:** Literal/folded block strings with strip/clip/keep chomping,
explicit indentation, mapping/sequence nesting, Unicode, and content whitespace.
Studio uses textareas for multiline values regardless of their length. Saves
and publication preserve unchanged top-level field blocks and body bytes.
Changed fields are serialized canonically; comments inside a changed top-level
object may be removed. Full YAML and standalone headers remain out of scope.

**Verification:** `frontmatter-codec.test.ts` covers block variants, invalid
headers/indentation, source preservation, and generated round trips. The
Markdown browser suite exercises both `|+` and `>+`: read, edit another field
without changing the scalar block, edit the value, save, reload, and compare
API values and stored bytes. Final `npm run check:all` passes with **902 unit
tests, 41 browser tests, and both example builds**. No runtime dependency added.

Details: [frontmatter compatibility](../markdown-frontmatter.md).

Starting point: [frontmatter codec](../../packages/core/src/runtime/storage/frontmatter-codec.ts).

### EXT-003 — Permissions and editorial review

- [x] Define a policy interface for editing, publishing, deleting, and managing
      collections, with documented backward-compatible defaults.
- [x] Enforce policy on server routes and mutations; UI visibility is not enforcement.
- [x] Verify allowed and denied operations with test identities and draft isolation.
- [x] Treat reviewer approval, content branches, and PR workflows as follow-on
      features with explicit behavior and audit history.

**Status:** Verified locally · **Owner / PR:** `main` / direct integration

**Delivered scope:** An authoritative identity adapter may define `authorize`
for edit, publish, delete, collection-management, and upload operations. Missing
policies preserve authenticated-editor access. Active policies fail closed and
force content writes into isolated editor overlays in server delivery. Delete
requires edit plus delete; restore requires edit plus publish. Reorder and bulk
publish preflight every affected entry before any write. Deployment retries are
also reauthorized. Direct API calls return curated 403 responses.

**Browser and server behavior:** Studio labels private saves as drafts and hides
publish, delete, and restore controls when their scoped permission is denied.
Server enforcement remains authoritative. A Chromium fixture verifies that a
writer edits a private draft while anonymous content remains unchanged; publish,
delete, collection management, upload, and restore are denied. A reviewer sees
an isolated overlay, publishes their own draft, and appears in publish history.
Unit tests also cover bulk preflight, permission changes between requests,
exceptions/non-boolean decisions, and adapters without draft support.

**Gate:** `npm run check:all` passed: 926 unit tests in 92 files, both example
builds, and 47 browser tests (30 standard, 2 CSP, 11 Markdown, 2 static,
2 permissions).

**Follow-on boundary:** This policy controls writes; it does not hide readable
content or history. It does not let reviewers access another editor's overlay.
Submission queues, explicit approval records, comments, shared drafts, content
branches, and PR workflows need a separate review-state model. Connecting a real
identity provider still requires provider configuration and deployment testing.
See [authorization policy](../authorization-policy.md).

Starting points: [identity contracts](../../packages/core/src/types.ts),
[middleware](../../packages/core/src/runtime/middleware.ts),
[design principles](../design-principles.md).

### EXT-004 — Coordinated Cloudflare writes

- [x] Define atomic/coordinated write capabilities for entries, revisions, and
      collection indexes without importing platform code into core.
- [x] Implement the platform-specific coordinator in the Cloudflare package.
- [x] Test concurrent edits, index updates, retries, and independent Worker
      request/client boundaries in the local Wrangler runtime.
- [x] Verify against configured Cloudflare resources before advertising production
      multi-editor guarantees; retain single-writer guidance for the KV adapter.

**Status:** Verified locally and on deployed Cloudflare infrastructure · **Owner / PR:** `main` / direct integration

**Delivered scope:** Core adapters may implement an atomic `commitEntries`
compare-and-commit operation. Mutation saves, deletes, layout changes, Markdown
drafts, reorders, non-source publication, normal history restores, draft-plan
persistence, and draft cleanup use it. `CloudflareDurableStorageAdapter` stores
the coordinated state in a SQLite-backed Durable Object; per-editor and demo
overlays use separate object identities. The KV adapter remains available and
retains its explicit single-writer guidance.

**Verification:** Unit tests use independent adapter clients and a scheduled
transaction store to prove one-winner revision conflicts, lossless concurrent
index updates, all-or-none stale batches, overlay isolation, and expiry alarms.
Chromium triggers simultaneous HTTP requests through a real local Wrangler
Worker and Durable Object binding and verifies the same conflict, index, batch,
and retry outcomes.

On 2026-09-13, a temporary Astro Worker was deployed to the selected Cloudflare
account with the generated custom entrypoint, SQLite Durable Object migration,
and existing KV/R2 bindings. Browser inspection loaded the public site from the
live Worker. Authenticated API checks persisted a first edit at revision 1; two
simultaneous writes at that revision produced exactly one revision-2 success and
one 409 conflict reporting revision 2. A same-session read returned the winning
value and two history snapshots, while a fresh session retained the bundled
revision-0 value. The temporary Worker was deleted after validation, and the
pre-existing KV namespaces and R2 bucket remained present.

**Gate:** `npm run check:all` passed: 933 unit tests in 93 files, all three
example builds, and 48 Chromium tests (30 standard, 2 CSP, 11 Markdown,
2 static, 2 permissions, 1 local Wrangler/Durable Object).

**Deployment result:** The configured-resource gate is complete. Existing
KV-only content still needs an explicit migration when adopting the Durable
Object adapter; the adapter only carries build-bundled seed data forward
automatically.

Details: [coordinated Cloudflare storage](../cloudflare-durable-storage.md).

Starting points: [Cloudflare concurrency guidance](../../packages/cloudflare/README.md#kv-concurrency-single-writer-only),
[Durable adapter](../../packages/cloudflare/src/adapters/durable-storage.ts).

### EXT-005 — Deployment completion status

- [x] Define a provider contract for build identity, completion/failure status,
      and the content revision included in the deployed build.
- [x] Display deploying/live/failed states using actual provider evidence.
- [x] Test locally with a simulated provider.
- [x] Validate real integration behavior with the configured deployment service.
- [x] Keep this independent from the bounded webhook and retry repair in FIX-004.

**Status:** Verified locally and against GitHub Deployments plus a deployed
Cloudflare Worker · **Owner / PR:** `main` / direct integration

**Delivered:** Added a `DeploymentStatusProvider` contract and runtime provider
reference, persistent per-editor deployment targets, webhook correlation IDs, an
authenticated status route, evidence normalization, and toolbar polling. Caret
shows Live only when the provider proves the deployed commit or covers every
published entry revision. The deterministic `simulatedDeployment()` provider
supports live and failure paths without external credentials. The built-in
`githubDeployment()` provider requires the exact Caret correlation ID in the
GitHub deployment payload, maps provider statuses, and reads an optional token
from a named server-side environment variable.

**Verification:** Unit regressions cover revision/commit evidence, unsafe URLs,
provider errors, simulated transitions, authenticated lookup, webhook
correlation, and persistence. The static Playwright fixture uses a real local
webhook plus the simulated provider and observes the toolbar change from
`Deploying…` to `Live`, including the provider build ID and target revisions.
It also repeats the flow with provider-confirmed failure. Final
`npm run check:all` passes: **944 unit tests, all three example builds, and 49
Chromium tests** across the standard, CSP, Markdown, static, permissions, and
Cloudflare suites. The package dry run includes the simulated provider's
JavaScript and declarations.

On 2026-09-13, a transient GitHub deployment carried the exact Caret
`deploymentId`, current repository commit, and published revision payload. The
new provider first returned Deploying with GitHub build ID `6423903985`, then
returned Live with the same ID, the matching commit/revisions, and the URL of a
temporary Worker deployed on the selected Cloudflare account. Chromium loaded
that Worker and confirmed the public site. The first status poll immediately
after GitHub accepted success briefly retained the prior state; the next poll
returned Live, matching the toolbar's existing retry behavior. Browser checking
also caught and removed a guessed GitHub activity link that returned 404, so the
provider now returns only GitHub-supplied environment or log URLs. The transient
GitHub deployment and Cloudflare Worker were deleted after validation.

**Deployment result:** The real-provider gate is complete. Production pipelines
must still carry Caret's webhook metadata into their own GitHub deployment
records. See [deployment completion status](../deployment-status.md).

### MAINT-001 — Browser code maintainability

- [x] Split the large Studio entry script along functional boundaries as touched
      features are changed, preserving how static editor assets are served.
- [x] Add incremental browser JavaScript type checking or compile typed sources
      into the existing static asset surface.
- [x] Keep sanitizer/parser/serializer parity checks and public exports intact.
- [x] Verify no regression in CSP, editor loading, or production asset paths.

**Status:** Complete browser module graph strictly checked, including Studio, inline editing, and the development toolbar · **Owner / PR:** `main` / direct integration

**Delivered:** Studio's schema defaults/presentation helpers and field rendering
now live in two ES modules under `static/cms/studio/`. The entry orchestrator
supplies callbacks for field updates and specialized widgets, retaining current
state for publication controls. Nested field IDs and label ownership stay shared.
`npm run typecheck:browser` applies strict JavaScript checks to these modules;
core type checking, the normal check command, and existing CI run it too.

The EXT-005 follow-up extracts deployment polling and toolbar-state translation
to `static/cms/editor/deployment-status.js`. Its typed callback boundary keeps
network/status logic testable without taking ownership of the toolbar DOM.

Publish outcome classification now lives in the typed
`static/cms/editor/publish-result.js` module. Recovery, conflict, webhook failure,
accepted rebuild, manual-deploy, and no-op results resolve to one explicit UI
presentation before the toolbar applies DOM effects.

Draft-state reads, publication, discard, and deployment retry now use the typed
`static/cms/editor/draft-client.js` module. It owns request construction and
response validation while the toolbar retains confirmations and DOM effects.

Static/server preview-cookie transitions now use the typed
`static/cms/editor/preview-mode.js` module. The controller owns cookie detection,
enablement/removal, and reload decisions while respecting policy-managed draft
sessions.

Nested Studio field reads and writes now share the strictly checked
`static/cms/studio/field-model.js` contract. Missing object and array segments,
legacy scalar replacement, and missing-path reads no longer depend on duplicate
untyped helpers in the entry orchestrator.

Studio save and delete requests now use the strictly checked
`static/cms/studio/mutation-client.js` module. Request construction,
authentication detection, JSON parsing, validation outcomes, revision conflicts,
and deletion outcomes are normalized before the orchestrator applies UI effects.
Browser verification also found and fixed an existing status bug: save
finalization replaced the actionable revision-conflict message with the generic
“Unsaved changes” status even though the form correctly retained its edits.

Studio history reads and restores now use the strictly checked
`static/cms/studio/history-client.js` module. It owns encoded history queries,
restore request construction, authentication detection, response validation,
and safe history-row normalization while the orchestrator retains DOM rendering
and form replacement.

Studio image preparation and upload requests now use the strictly checked
`static/cms/studio/upload-client.js` module. It owns accepted image MIME types,
bitmap scaling, canvas encoding, normalized dimensions, multipart request
construction, authentication callbacks, and response validation. The entry
orchestrator retains gallery and single-image DOM behavior.

Studio entry and schema loading now uses the strictly checked
`static/cms/studio/entry-loader.js` module. It owns concurrent request
construction, authentication across both responses, curated source-read errors,
missing/new entry classification, schema-derived initialization, revisions,
validation issues, and publication metadata. The orchestrator retains screen
selection and field rendering.

Studio preview and field-selection coordination now uses the strictly checked
`static/cms/studio/sync-client.js` module. It owns debounced embedded preview
messages, save/delete and ready announcements, same-origin window filtering,
standalone BroadcastChannel selection, and channel cleanup. The orchestrator
retains field lookup, scrolling, and pending selection before entry loading.

The remaining `static/cms/admin-entry.js` orchestrator is now included directly
in strict browser checking. Its config, DOM contract, entry state, schema,
validation, gallery/tag/object-array values, drag-and-drop data, file inputs,
restore payloads, and load-error elements have explicit types and runtime guards.
Malformed successful entry responses, non-object entry/restore data, invalid
collection values, and non-object schema templates now fail safely instead of
flowing into field rendering.

The complete `static/cms/editor/toolbar.js` orchestrator is also included in
strict browser checking together with its imported configuration and highlight
dependencies. Injected configuration, cloud paths and session keys, navigation
links, status callbacks, draft/deployment controls, and optional DOM elements
now have explicit types and safe normalization.

The page-side `static/cms/editor/sync.js` controller and its binding/sanitizer
dependencies are now included in strict browser checking. Iframe,
BroadcastChannel, and session-storage messages are normalized before their
collection, entry, field, route, or data values reach selectors, navigation, or
DOM updates. Malformed message shapes, unsupported actions, empty binding
segments, array payloads, and invalid persisted timestamps are ignored.

The inline `static/cms/editor/text-edit.js` controller and
`text-link-interactions.js` dependency are now included in strict browser
checking. Contenteditable elements, snapshots, save results, conflict callbacks,
link popovers, and DOM events have explicit contracts. Browser checking exposed
a real disappearing-selection failure: applying a rich-text link assumed
`window.getSelection()` still returned a selection after the popover opened.
The controller now exits safely when it does not.

The inline `static/cms/editor/image-edit.js` controller, `image-utils.js`, and
request-security dependency are now included in strict browser checking. Upload
response URLs are validated before DOM or storage use, request tokens are
normalized, and carousel targets have explicit element guards. A missing 2D
canvas context previously threw during compression and aborted an otherwise
valid upload; the utility now closes the bitmap and uploads the original file.

The floating `static/cms/editor/rich-toolbar.js` controller is now included in
strict browser checking. Selection ranges, command buttons, positioning, active
editable elements, and link callbacks have explicit browser contracts. Browser
verification found that opening the shared link popover cleared its own field
ownership, allowing blur sanitization to replace the selected anchor; Apply then
updated a detached node and left the visible link unchanged. Popover ownership
is now assigned after cleanup, the live anchor is resolved before mutation, and
both rich fields and Markdown blocks defer premature blur saves.

The Markdown block, paragraph grouping, and DOM-to-Markdown serializer modules
are now included in strict browser checking. Binding attributes, editable state,
save outcomes, DOM events, and paragraph source lists have explicit contracts.
Strict checking exposed unchecked `data-caret-md-sources` parsing and assumptions
that every stamped paragraph retained valid binding and source attributes.
Malformed structural metadata now leaves that group visible and read-only instead
of crashing editor boot or being echoed into a mutation. Source hints, bounds,
top-level block paths, sequence, group size, and the bound first source are
validated before editing is enabled.

The shared inline `static/cms/editor/save-queue.js` is now included in strict
browser checking. Entry snapshots, revision caches, mutation payloads, nested
field reads, status callbacks, and save/conflict results have explicit contracts.
Response validation exposed a concrete failure: accessing `revision` or
`currentRevision` directly on a successful `null` JSON body threw after the
server had already committed, causing the editor to report failure and restore
old text. Mutation bodies are now normalized before property access. A successful
write can infer the next guarded revision, while a malformed 409 body retains
conflict behavior and refreshes the latest revision/value. Malformed successful
entry snapshots fail safely instead of resetting an existing entry to revision 0.

The `static/cms/editor/content-map.js` controller is now included in strict
browser checking. Entry responses, nested override paths, resolved bindings,
panel elements, and asynchronous refreshes have explicit contracts and runtime
guards. Browser verification exposed a concrete duplicate-binding bug: every
row with the same collection, entry, and field used a first-match lookup, so all
duplicate rows scrolled to and highlighted the first element. Rows now retain
their exact binding index and use native buttons for keyboard activation.
Malformed entry data is ignored, inherited nested properties are excluded,
stale refreshes cannot replace a newer or closed panel, repeated mounts do not
duplicate listeners, and the named map region leaves the accessibility tree
when closed.

The complete `static/cms/editor/section-controls/` family is now included in
strict browser checking. Layout data, section mutations, page context, picker
state, drag state, DOM maps, and fetch responses have explicit contracts.
Layout mutation requests now carry the resolved collection instead of relying
on the server's `pages` default, successful or conflicting `null` JSON bodies
are normalized before property access, and duplicate section IDs become unique
before they enter controller maps. Insert and spacing pickers expose named
dialogs, move focus into their options, and restore the trigger on Escape.
Chromium also exposed an existing overlay bug on short sections: the visible
control container covered editable content and intercepted its clicks. Only the
actual visible buttons now accept pointer input, preserving both editing and
layout controls.

The top-level `static/cms/editor.js` entry is now included in strict checking,
which closes the remaining inline runtime gap across panel mounting, dirty-state
guards, toast rendering, link-follow affordances, and stega hydration. The stale
query-string import on Studio synchronization was removed so the entry resolves
through the same checked module path it serves. Studio panel storage reads and
writes now tolerate unavailable session storage, and the parent registers its
Escape handler in the same-origin iframe because keyboard events do not cross
document boundaries. Link-follow focus cancels its pending mouseout timer, so a
keyboard-focused affordance remains available. Async toast actions are handled
as promises, and stega hydration validates a complete binding before promoting
an element while still removing hidden metadata from malformed values.

**Verification:** Unit checks cover independent nested defaults and schema-valid
row templates. Studio CRUD, preview linking, accessibility, and multiline browser
regressions pass. A production browser test confirms both modules load and saves
survive reload under an explicit script CSP, without page errors or violations.
The package dry run includes the extracted modules. Final `npm run check:all`
passes: **944 unit tests in 95 files, 49 browser tests, and all three example
builds**.

Focused unit checks cover deploying/live, failed, unknown, unconfigured, and
transport-failure behavior. The static Chromium suite verifies the extracted
module through real live and failed provider flows; the CSP suite verifies its
module import remains permitted.

Five publish-presentation regressions cover every server outcome and malformed
optional data. `npm run check` passes with **949 unit tests in 96 files**. The
static and Markdown Chromium suites pass **14 tests**, covering conflict,
recovery, success, verified deployment, and deployment failure through the real
toolbar.

Six draft-client regressions cover normalized state, request headers and bodies,
discard semantics, tracked deploy retries, HTTP errors, webhook errors, and
malformed optional data. The static, Markdown, and permissions Chromium suites
pass **17 tests** with the client loaded through the packaged editor runtime. A
static browser regression also performs real toolbar clicks to discard a draft,
receive a 503 rebuild response, reveal Retry deploy, and complete the retry with
a tracked deployment target. `npm run check` passes with **955 unit tests in 97
files**.

Four preview-mode regressions cover static enablement, already-active preview,
stale server cookies, and policy-managed drafts. The static Chromium suite passes
**5 tests**, including a cookie-free login that reloads into preview mode before
mounting the static editor. `npm run check` passes with **959 unit tests in 98
files**.

Two additional field-path regressions cover nested array creation, reads, scalar
replacement, and missing values. The Studio CRUD and sidebar-preview Chromium
suites pass **9 tests**, exercising nested forms, validation paths, save/reload,
and cross-window field selection through the shared helpers. `npm run check`
passes with **961 unit tests in 98 files**.

Five mutation-client regressions cover save/delete payloads, expected revisions,
validation issue filtering, authentication, malformed failures, and conflicts.
The Studio CRUD Chromium suite passes **7 tests**. Its new two-writer regression
receives HTTP 409, keeps the local form value and conflict guidance visible, then
saves successfully on retry with the refreshed revision. `npm run check` passes
with **966 unit tests in 99 files**.

Four history-client regressions cover encoded identifiers, normalized rows and
editor attribution, restore payloads and revisions, authentication, HTTP errors,
and malformed JSON. Chromium restores the prior entry value, reports “Restored,”
and verifies through the API that the replaced value remains as an undo snapshot.
`npm run check` passes with **970 unit tests in 100 files**.

Six upload-client regressions cover accepted formats, same-origin multipart
requests, large-image resizing and encoding, scaled dimensions, decode failure,
authentication, HTTP errors, and malformed responses. The Studio CRUD Chromium
suite passes **7 tests**, including real PNG selection, preview rendering,
filename-derived title/alt metadata, dimension validation, persistence, and
API readback. `npm run check` passes with **976 unit tests in 101 files**.

Five entry-loader regressions cover existing entries, missing and initialized
entries, schema-derived templates, authentication from either parallel request,
curated read-error codes, and malformed successful responses. Seven Studio CRUD
Chromium tests and the Markdown unsupported-frontmatter regression pass through
the packaged loader, including source repair followed by a successful Retry.
`npm run check` passes with **981 unit tests in 102 files**.

Five sync-client regressions cover embedded and standalone preview/selection
messages, saved-change broadcasting, origin filtering, readiness, and channel
cleanup. The Studio CRUD and sidebar-preview Chromium suites pass **10 tests**,
covering bidirectional iframe selection, live form preview, save refresh,
cross-tab selection, route navigation, and post-navigation highlighting.
`npm run check` passes with **986 unit tests in 103 files**.

The complete `npm run check:all` release gate passes with **1,007 unit tests in
110 files**, all three example production builds, and **65 Chromium tests**:
40 primary, 2 CSP, 15 Markdown, 5 static, 2 permissions, and 1 local
Cloudflare Durable Object test. The CSP regression verifies all seven packaged
Studio modules load and save under the script policy without violations.

The development-toolbar app now completes the strict browser configuration.
Its binding parser, DOM scan, grouped entry model, highlighting, escaping, and
toolbar-event boundaries are checked. Browser verification confirms highlight
controls retain the open inspector, repeated scroll flashes restore the original
inline style, and rescan refreshes the toolbar warning badge in both directions.
See [browser maintenance](../browser-maintenance.md).

Starting points: [Studio entry script](../../packages/core/static/cms/admin-entry.js),
[core TypeScript config](../../packages/core/tsconfig.json).

## Completion and release checklist

- [x] Every selected FIX item records passing regression tests.
- [x] Land the implementation on `main`; direct integration was requested, so no PR was created.
- [x] Repeat each original browser reproduction against the fixed code; capture
      UI, API, and stored-state evidence where relevant.
- [x] `npm run check` passes on the integrated changes.
- [x] Run relevant E2E suites separately from unit tests. Keep filesystem-backed
      E2E writers serial; use the static and Markdown configurations for their
      respective publishing paths.
- [x] Before release, run `npm run check:all` for the combined package, example,
      and E2E gate and record the result.
- [x] Document public contract changes, draft migration/recovery behavior, and
      adapter guarantees. Update the changelog with the final behavior.
- [x] Stop test servers and restore or remove disposable fixtures.

## Work log

| Date | Item | Update | Validation / PR |
| --- | --- | --- | --- |
| 2026-09-05 | Audit | Six defects reproduced; optional extensions separated; implementation still open | Browser/API/file checks and one backend characterization test; initial 858 unit tests passed |
| 2026-09-05 | Tracker | Added implementation tasks and acceptance checks | Documentation only |
| 2026-09-05 | FIX-001–006 | Implemented conflict baselines, publish recovery, pagination, bounded hooks/manual retry, read diagnostics, and toolbar spacing | Final `npm run check:all`: 883 unit + 39 browser tests; both example builds passed |
| 2026-09-05 | Browser verification | Repeated original conflict and hanging-hook cases with UI/API/file checks; toolbar widths 390/1280/1920 | New repeatable regressions in static, Markdown, and Studio suites; local hook returned in 5.897 seconds |
| 2026-09-05 | Test reliability | Existing linked-image hover test now waits for the lazy editor before hovering | Final combined gate passed; no arbitrary delay added |
| 2026-09-05 | EXT-002 | Added literal/folded YAML support, source-preserving field updates, and multiline Studio controls | `npm run check:all`: 902 unit + 41 browser tests; both example builds passed |
| 2026-09-05 | MAINT-001 | Extracted Studio field modules, added strict browser checks to the regular gate, verified package assets and CSP save/reload | `npm run check:all`: 904 unit + 42 browser tests; both example builds passed |
| 2026-09-08 | EXT-005 | Added evidence-backed deployment status providers, persistent targets, webhook correlation, an authenticated status route, and toolbar polling | `npm run check:all`: 941 unit + 49 browser tests; all three example builds passed; real provider validation remains gated on an account |
| 2026-09-08 | MAINT-001 | Extracted deployment polling from the toolbar and added it to strict browser checking | `npm run check:all`: 944 unit + 49 browser tests; all three example builds passed |
| 2026-09-08 | MAINT-001 | Extracted typed publish-result presentation from the toolbar | `npm run check`: 949 unit tests; 14 relevant static/Markdown Chromium tests passed |
| 2026-09-08 | MAINT-001 | Extracted the typed draft/publish/discard/deploy-retry HTTP client from the toolbar | `npm run check`: 955 unit tests; 17 relevant Chromium tests passed, including toolbar discard and deploy retry |
| 2026-09-08 | MAINT-001 | Extracted typed preview-cookie and reload decisions from the toolbar | `npm run check`: 959 unit tests; 4 focused regressions and 5 static Chromium tests passed, including automatic cookie-free preview enablement |
| 2026-09-08 | MAINT-001 | Moved nested Studio field reads and writes into the strictly checked field model | `npm run check`: 961 unit tests; 2 focused regressions and 9 Studio Chromium tests passed across CRUD and sidebar preview |
| 2026-09-08 | MAINT-001 | Extracted typed Studio save/delete requests and fixed conflict-status replacement | `npm run check`: 966 unit tests; 5 focused regressions and 7 Studio CRUD Chromium tests passed, including 409 retention and retry |
| 2026-09-09 | MAINT-001 | Extracted typed Studio history reads and restores | `npm run check`: 970 unit tests; 4 focused regressions passed; Chromium verified restored form state, status, revision flow, and undo history |
| 2026-09-09 | MAINT-001 | Extracted typed Studio image preparation and upload requests | `npm run check`: 976 unit tests; 6 focused regressions and 7 Studio CRUD Chromium tests passed, including real PNG upload and persisted metadata |
| 2026-09-09 | MAINT-001 | Extracted typed Studio entry/schema loading and initialization | `npm run check`: 981 unit tests; 5 focused regressions, 7 Studio CRUD Chromium tests, and the unsupported-frontmatter recovery regression passed |
| 2026-09-09 | MAINT-001 | Extracted typed Studio preview and field-selection synchronization | `npm run check`: 986 unit tests; 5 focused regressions and 10 Studio CRUD/sidebar-preview Chromium tests passed across iframe and BroadcastChannel transports |
| 2026-09-10 | MAINT-001 | Added the complete Studio entry orchestrator to strict browser checking and guarded its remaining dynamic boundaries | `npm run check:all`: 986 unit tests, all three example builds, and 52 Chromium tests passed |
| 2026-09-10 | MAINT-001 | Added the inline toolbar plus configuration and highlight dependencies to strict browser checking | `npm run check:all`: 989 unit tests, all three example builds, and 52 Chromium tests passed |
| 2026-09-10 | MAINT-001 | Added page-side iframe/cross-tab synchronization and its binding/sanitizer dependencies to strict browser checking with runtime message validation | `npm run check:all`: 993 unit tests, all three example builds, and 52 Chromium tests passed |
| 2026-09-11 | MAINT-001 | Added inline text editing, link interactions, and linkification to strict browser checking; guarded selection restoration | `npm run check:all`: 993 unit tests, all three example builds, and 53 Chromium tests passed |
| 2026-09-11 | MAINT-001 | Added inline image editing, compression/carousel utilities, and request security to strict browser checking; guarded upload responses and canvas fallback | `npm run check:all`: 996 unit tests, all three example builds, and 54 Chromium tests passed |
| 2026-09-11 | MAINT-001 | Added the rich toolbar to strict browser checking and fixed shared link-popover ownership across rich fields and Markdown blocks | `npm run check:all`: 996 unit tests, all three example builds, and 56 Chromium tests passed |
| 2026-09-13 | MAINT-001 | Added Markdown block editing, paragraph grouping, and browser serialization to strict checking; made malformed structural metadata fail read-only | `npm run check:all`: 1,000 unit tests, all three example builds, and 57 Chromium tests passed |
| 2026-09-13 | MAINT-001 | Added the inline save queue to strict checking; normalized malformed mutation and entry responses without losing committed saves or conflicts; made the multi-context permissions test wait for editor mount | `npm run check:all`: 1,003 unit tests, all three example builds, and 58 Chromium tests passed |
| 2026-09-13 | MAINT-001 | Added the content map to strict checking; targeted duplicate bindings by exact row, validated entry data, guarded stale refreshes, and made map navigation keyboard-accessible | `npm run check:all`: 1,004 unit tests, all three example builds, and 59 Chromium tests passed |
| 2026-09-13 | MAINT-001 | Added section/layout controls to strict checking; preserved collection context, normalized malformed responses and duplicate IDs, improved picker focus, and stopped overlays from blocking content | `npm run check:all`: 1,007 unit tests, all three example builds, and 60 Chromium tests passed |
| 2026-09-13 | MAINT-001 | Added the complete inline editor entry graph to strict checking; guarded panel storage, iframe Escape, async toast actions, link focus timers, and stega promotion | `npm run check:all`: 1,007 unit tests, all three example builds, and 62 Chromium tests passed |
| 2026-09-13 | MAINT-001 | Added the development-toolbar app to strict checking; fixed panel closure, overlapping scroll flashes, pressed state, and stale rescan notifications | `npm run check:all`: 1,007 unit tests, all three example builds, and 63 Chromium tests passed |
| 2026-09-13 | FIX-007 | Made Studio deletion a named modal with safe initial focus, contained keyboard traversal, focus restoration, and nested Escape handling | `npm run check:all`: 1,007 unit tests, all three example builds, and 64 Chromium tests passed |
| 2026-09-13 | FIX-008 | Made Studio history a named disclosure with expanded state, focus transfer/restoration, shared cleanup, and nested Escape containment | `npm run check:all`: 1,007 unit tests, all three example builds, and 64 Chromium tests passed |
| 2026-09-13 | FIX-009 | Made Studio entry creation a named modal with contained keyboard traversal, opener restoration, and nested Escape handling | `npm run check:all`: 1,007 unit tests, all three example builds, and 64 Chromium tests passed |
| 2026-09-13 | FIX-010 | Added keyboard collection ordering, disclosure state, managed focus, Escape cancellation, and embedded containment | `npm run check:all`: 1,007 unit tests, all three example builds, and 65 Chromium tests passed |
| 2026-09-13 | FIX-011 | Changed Studio home collection cards from first-page length to validated pagination totals | `npm run check:all`: 1,007 unit tests, all three example builds, and 65 Chromium tests passed |
| 2026-09-13 | FIX-012 | Preserved server duplicate-ID conflicts across paginated collection creation with localized recovery focus | `npm run check:all`: 1,007 unit tests, all three example builds, and 65 Chromium tests passed |
| 2026-09-13 | EXT-004 | Deployed a temporary Astro Worker with the SQLite Durable Object and existing KV/R2 bindings; verified the public site, session isolation, history, and one-winner concurrent revisions; deleted the Worker afterward | Live browser load; API revisions 1 and 2 persisted; simultaneous writes returned 200/409; Worker deletion confirmed while existing KV/R2 resources remained |
| 2026-09-13 | EXT-005 | Added the GitHub Deployments provider and validated an exact-correlation transient deployment against a live Cloudflare Worker; removed a browser-confirmed 404 fallback link; deleted both temporary external records | Provider observed Deploying then Live with build ID, commit, revisions, and live URL; Chromium loaded the Worker; `npm run check:all` passed with 1,012 unit tests, all three example builds, and 65 Chromium tests |
| 2026-09-13 | Integration | Organized the completed cycle into logical commits and integrated it directly into `main` as requested | Full gate passed before integration; remote branch cleanup followed the main update |
