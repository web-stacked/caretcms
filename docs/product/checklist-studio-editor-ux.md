# Studio and editor UX checklist

Working backlog from the September 13, 2026 UX review. All 35 review items are
represented below. All six phases are implemented and visually reviewed.

Goal: make content easier to find and edit, reduce persistent controls and
instructions, and make save and publication outcomes clear.

Follow [Design principles](../design-principles.md): editing on the page remains
the primary experience; Studio supports structure, non-visual fields, and fallback
editing. Keep core free of runtime dependencies and storage-specific assumptions.

## How we will work through this

Start with Phase 1. Request a phase or individual ID, for example:
“Work on UX-01 through UX-03” or “Let's decide D-01.”

For each batch, inspect the current behavior, implement a small coherent change,
verify it, and update this file with the result and any remaining limitations.
Check an implementation item only after its acceptance condition is verified.
Keep user visual review separate from implementation completion. Record deferred
items explicitly rather than checking them off.

The review used the running content-site example and source inspection. Recheck
conditional features in their supported modes before changing them. Distinguish
example configuration from core defaults.

## Decisions before dependent work

These do not block the straightforward cleanup in Phase 1.

- [x] **D-01 — Saving model.** Before UX-28/29, choose whether to preserve the
  existing live/draft modes with consistent presentation or introduce a broader
  draft-first workflow. Document how inline fields, Studio forms, Markdown body
  edits, static delivery, permissions, and private previews behave. A label must
  never promise persistence or publication that has not happened.
- [x] **D-02 — Page and sidebar layout.** Before UX-12, choose an isolated split
  preview or another approach that keeps the selected content visible without
  depending on a host site's selectors or breaking its layout.
- [x] **D-03 — Rich editing scope.** Before UX-15, choose the supported formatting
  controls and source-editing access. Preserve existing supported markup and
  sanitization; keep editing on the page the preferred route where available.

Record decisions here as they are made:

| Decision | Chosen behavior | Date |
| --- | --- | --- |
| D-01 | Preserve the existing targets and state them precisely: ordinary inline and Studio fields save live in ungoverned server delivery; static delivery and authorization policies save private drafts; Markdown body blocks always draft until Publish. Show configured Public/Hidden visibility separately from whether the latest edit is unsaved, saved as a draft, or live. | 2026-09-13 |
| D-02 | Adaptive overlay: place the drawer opposite selected content and provide a manual side switch, without reflowing or targeting host layout. Use a full-width drawer on small screens. | 2026-09-13 |
| D-03 | Studio rich fields use a sanitized formatted editor with Bold, Italic, and Link controls. Existing allowed inline markup remains intact; Edit HTML is available as a secondary mode for the full supported allowlist. On-page editing remains the preferred route when a binding is present. | 2026-09-13 |

## Phase 1 — Remove everyday clutter

- [x] **UX-01 — Replace the permanent help banner.** Use dismissible onboarding
  or accessible Help; returning editors reach fields without a repeated paragraph.
- [x] **UX-02 — Simplify the entry action bar.** Prioritize title, one save status,
  and the primary action. Move occasional actions and internal metadata into
  appropriate secondary UI; keep destructive actions distinguishable.
  - [x] **Review finding UX-02a — Keep More actions inside the viewport.** At
    phone width and in the embedded drawer, the popover stays within the view so
    its context and History action remain visible.
- [x] **UX-03 — Consolidate navigation and account actions.** Embedded Studio
  avoids duplicate Studio/Sign out controls; standalone Studio remains navigable.
- [x] **UX-04 — Move Content Map into advanced tools.** Developer binding details
  remain available without occupying the everyday toolbar.
- [x] **UX-05 — Rename “Show all.”** Use “Show editable areas” or equivalent;
  expose an understandable active state and placement in view controls.
- [x] **UX-06 — Simplify toolbar styling.** Reduce dividers, competing borders,
  and decorative emphasis while preserving clear focus and selection states.
- [x] **UX-07 — Improve text readability.** Establish comfortable sizes and
  contrast for labels, values, help, and status across full Studio and the drawer.
- [x] **UX-08 — Use sentence case.** Normalize built-in labels and actions;
  preserve intentional content and configured branding.
- [x] **UX-09 — Reduce optional-label repetition.** Mark required fields clearly
  and explain the convention once; retain accessible required-field information.
- [x] **UX-10 — Hide unnecessary pagination.** Single-page collections have no
  disabled Previous/Next pair; multi-page and filtered results remain clear.

Acceptance walkthrough: open an existing page entry in full Studio and in the
drawer. The content and primary action should be easy to find without reading help.

- [x] **Review 1 — User has reviewed the simplified controls and typography.**

## Phase 2 — Make the sidebar and preview usable

- [x] **UX-11 — Create a compact embedded layout.** Use a short header and save
  area so ordinary fields appear early; long titles must not dominate the drawer.
- [x] **UX-12 — Keep edited content visible.** Implement D-02; selected text and
  images remain inspectable alongside their controls across representative sites.
- [x] **UX-13 — Add Close and Expand controls.** Make them visible inside the
  drawer, keyboard accessible, and usable on small screens. Preserve pending edits
  or provide a clear navigation guard when changing surfaces.
- [x] **UX-14 — Add an explicit Edit / Preview interaction mode.** Preview lets
  users navigate and inspect without activating editing. Switching modes preserves
  work and does not imply that a draft is already public.

Acceptance walkthrough: open the drawer, select on-page content, switch to preview,
return to editing, expand, and close. Verify keyboard focus and a narrow viewport.

- [x] **Review 2 — User has reviewed the sidebar and preview behavior.**

## Phase 3 — Make fields easier to edit

- [x] **UX-15 — Provide formatted rich-field editing.** Implement D-03 so ordinary
  editing does not require HTML knowledge. Preserve supported formatting and links
  through save/reload, with source editing secondary if retained.
- [x] **UX-16 — Group fields by purpose.** Add coherent groups such as Hero,
  Selected work, and Call to action. Support configuration and sensible fallback
  rendering instead of hard-coding example field names.
- [x] **UX-17 — Improve field names.** Replace example jargon such as “Eyebrow”
  and “CTA” with understandable labels; honor project-supplied labels in core.
- [x] **UX-18 — Show relevant field help.** Render schema descriptions where
  useful, associate them with controls, and remove repeated generic guidance.
- [x] **UX-19 — Collapse repeatable items.** Show a useful summary or thumbnail
  and expand the item being edited. Reveal collapsed items with validation errors
  or linked selections from the page.
- [x] **UX-20 — Simplify repeatable-item actions.** Reduce persistent controls
  while preserving keyboard/touch reordering, focus after moves, and clear removal.
- [x] **UX-21 — Consolidate image replacement.** Provide one obvious Replace
  action and a secondary image-URL option, with clear upload progress and recovery.
- [x] **UX-22 — Group image metadata.** Keep image, alternative text, and caption
  together where the schema permits; make technical dimensions/identifiers secondary.
  Do not hide alternative text behind advanced settings.

Acceptance walkthrough: edit rich text, replace an image, update its alternative
text, and add/reorder a repeatable item. Save and reload to verify the result.

- [x] **Review 3 — User has reviewed fields, images, and repeatable items.**

## Phase 4 — Improve collections and content navigation

- [x] **UX-23 — Start entry creation with a title.** Suggest an internal ID and
  allow adjustment before creation. Handle duplicates and collections without a
  title field; use specific action labels where configuration supports them.
- [x] **UX-24 — Add compact collection switching.** Move between collections
  without repeatedly returning to the dashboard; protect unsaved form changes.
- [x] **UX-25 — Improve entry recognition.** Use titles, suitable thumbnails, and
  meaningful status/metadata with fallbacks. Keep raw IDs visually secondary.
- [x] **UX-26 — Simplify dashboard cards.** Remove redundant descriptions and
  singleton counts; replace mixed emoji defaults with a consistent icon family
  while respecting configured icons.
- [x] **UX-27 — Align reordering interactions.** Use consistent terminology and
  feedback for collection and nested-item ordering. Make persistence explicit and
  explain genuine search/pagination restrictions only when relevant.

Acceptance walkthrough: find an entry, switch collections, create an entry in a
creatable collection, and reorder supported content without losing orientation.

- [x] **Review 4 — User has reviewed collection navigation and creation.**

## Phase 5 — Clarify saving, visibility, and leaving the editor

- [x] **UX-28 — Implement the agreed saving model.** Follow D-01 with consistent
  labels and states for unsaved, saving, saved draft, saved live, and failures.
  Verify the actual persistence target for each supported editing surface.
- [x] **UX-29 — Distinguish entry visibility from pending edits.** Users can tell
  whether an entry is public and whether their latest changes are public. Describe
  static deployment delays accurately and show only authorized actions.
- [x] **UX-30 — Support keeping drafts when signing out.** Provide a clear route
  that neither publishes nor discards saved drafts. Verify retention for the
  relevant identity/session model; explain when private session data cannot survive.
- [x] **UX-31 — Unify confirmations and recovery wording.** Use consistent product
  dialogs for supported actions, retaining unavoidable browser navigation guards.
  Describe deletion honestly and provide the promised recovery route when available.

Acceptance walkthrough: make edits, save, inspect visibility, publish where allowed,
and sign out with drafts. Repeat for live/server, static, Markdown, and restricted
roles as applicable. Do not change runtime guarantees merely to simplify wording.

- [x] **Review 5 — User has reviewed save, publish, and sign-out behavior.**

## Phase 6 — Refine structural editing and recovery

- [x] **UX-32 — Reduce section-control overload.** Keep common actions visible
  and place occasional actions in a menu. Replace “Space”/“Y” jargon with clear
  spacing labels; retain keyboard alternatives and discoverable insertion controls.
- [x] **UX-33 — Guide validation recovery.** Surface the first invalid field,
  expand its group if necessary, and explain corrections. Keep entered content and
  associate errors with controls for assistive technology.
- [x] **UX-34 — Improve concurrent-edit recovery.** Offer review/reload of newer
  content and an explicit choice to retain local edits. Avoid accidental overwrite
  and preserve local work while the user compares the alternatives.
- [x] **UX-35 — Make history reviewable.** Show understandable change summaries
  and a preview or comparison before Restore. Keep recovery available without
  making technical action names and timestamps the only clues.

Acceptance walkthrough: select a section, adjust its structure, recover from invalid
fields, resolve competing edits, and inspect a prior version before restoring it.

- [x] **Review 6 — User has reviewed structural editing and recovery.**

## Verification for implementation batches

Use relevant checks for each batch; this planning document requires no test run.

- Inspect the rendered result in full Studio and the embedded drawer, including a
  narrow viewport, long titles, and long forms when relevant.
- Check keyboard navigation, focus restoration, accessible names, contrast, and
  reduced motion for changed controls. Do not make essential actions hover-only.
- Preserve localized built-in copy, configured branding, and schema-driven behavior.
- Exercise affected empty, loading, failure, permission, and unsaved-change states.
- For behavior changes, run focused unit/E2E coverage and update meaningful tests
  where needed. Run `npm run check` for completed implementation phases. Run E2E
  separately from unit tests with the repository's serial configuration.
- Record what was verified and any deferred work below; check completed IDs only.

## Progress log

| Date | Items | Result and verification | Remaining work |
| --- | --- | --- | --- |
| 2026-09-13 | Planning | Checklist created from the 35-item review; no implementation changes | Start Phase 1; decisions pending |
| 2026-09-13 | UX-01–UX-10 | Simplified entry and inline toolbars, collapsed help, consolidated embedded navigation, improved type/labels, and hid one-page pagination. `npm run check` passed (111 files, 1012 tests); focused Chromium E2E passed (23 tests); visually checked standalone Studio and the embedded drawer. | User Review 1; then Phase 2 and D-02 |
| 2026-09-13 | Review 1 | Computer-use review covered the dashboard, collection list, entry form, embedded drawer, Tools menu, editable-area toggle, keyboard focus, and a 390px standalone viewport. The simplified hierarchy, collapsed help, toolbar grouping, readable focus state, and hidden one-page pagination passed. | Fix UX-02a: More actions is clipped off-screen in the drawer and at 390px; rerun Review 1 |
| 2026-09-13 | UX-02a, Review 1 | Anchored More actions to the left at narrow widths so its context and actions remain visible. Added a Chromium regression test for a 390px Studio and the embedded drawer; the focused E2E test and `npm run check` passed. Computer-use review confirmed both layouts. | Phase 2 and D-02 |
| 2026-09-13 | D-02, UX-11–UX-14, Review 2 | Added compact drawer chrome with Back, Move, Expand, and Close; the drawer automatically moves opposite selected content without reflowing the host page. Close preserves unfinished form state. Added explicit Edit and Preview modes, with Preview suppressing editing chrome and restoring editable state on return. Computer-use review covered desktop and 390px layouts. `npm run check` and four focused Chromium E2E tests passed. | Phase 3 and D-03 |
| 2026-09-13 | D-03, UX-15–UX-22, Review 3 | Replaced raw rich HTML fields with sanitized formatted editing and secondary source access; added schema-configured field sections and associated descriptions; simplified labels in the content example; collapsed repeatable records into summaries with optional thumbnails; moved their actions into the open item; consolidated image upload and URL entry; and moved IDs/dimensions into Technical details while keeping alternative text visible. Chrome computer-use review covered full Studio, the embedded drawer, and a 390px viewport. `npm run typecheck:browser`, `npm run check` (111 files, 1013 tests), 11 focused Studio Chromium tests, and 2 strict-CSP tests passed. | Phase 4 |
| 2026-09-13 | UX-23–UX-27, Review 4 | Added title-first creation with editable slug suggestions and collection-specific action labels; added compact collection switching; made configured title, thumbnail, and subtitle fields drive entry recognition; simplified dashboard cards with a consistent line-icon family; and aligned collection arranging language while hiding unavailable arranging controls. Computer-use review covered the dashboard, Gallery list and creation flow, configured entry heading, full Studio, and a 390px viewport. All 12 Studio CRUD Chromium tests passed. | Phase 5 and D-01 |
| 2026-09-13 | D-01, UX-28–UX-30 | Documented the save model and changed Studio, inline-field, image, and layout status copy to distinguish saved drafts from live changes. Added a separate Public/Hidden entry indicator. Sign-out now offers Keep drafts only for stable provider identities, explains why password-session drafts cannot be reopened, and completes Publish before logout. `npm run check` passed (111 files, 1013 tests); Studio CRUD (12), permission-policy (2), static-delivery (6), and Markdown (15) Chromium tests passed. Computer-use review confirmed the configured entry title and live-save label in current assets at desktop and 390px. | UX-31 and Review 5 |
| 2026-09-13 | UX-31, Review 5 | Replaced save-live, publish, discard, and restore browser prompts with keyboard-contained product dialogs and focus restoration. Corrected deletion wording so it no longer promises an unavailable post-delete Studio recovery path. Computer-use review confirmed the live-save dialog, copy, initial focus, cancellation, and restored clean form state. Static, policy, Markdown, Studio, and strict-CSP suites passed. | Phase 6 |
| 2026-09-13 | UX-32–UX-35, Review 6 | Kept drag and keyboard movement visible while moving visibility, spacing, duplicate, and delete into a section More menu; replaced “Space” and “Y” with clear spacing labels. Validation now opens collapsed controls, focuses the first invalid field, and associates its error. Studio conflicts list changed fields and offer Keep my edits or Load latest. History uses readable actions, changed-field summaries, field previews, and explicit restore labels. `npm run check` passed (111 files, 1013 tests), the full default Chromium suite passed (45 tests), and strict CSP passed (2 tests); focused recovery and section-control tests also passed. | Complete |
| 2026-09-13 | Final acceptance review | Chrome computer-use review covered the dashboard, every content example collection, grouped and formatted fields, images, creation, arrangement, mobile layouts, save/delete dialogs, history empty state, embedded Edit/Preview and drawer controls, repeatable records, and section controls. The audit fixed five issues found in context: restored the visible dashboard title, prevented source-view toggling from creating a false dirty state, gave singleton entries their collection label instead of “Untitled,” named entries by title in delete confirmation, and kept the section-insert menu above the fixed toolbar with a viewport-safe scroll area. `npm run check` passed (111 files, 1013 tests), the full Chromium suite passed (45 tests), and strict CSP passed (2 tests). | Accepted |
