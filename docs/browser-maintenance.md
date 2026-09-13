# Studio browser modules

The Studio entry page loads `static/cms/admin-entry.js` as a strictly checked ES module. It owns
entry state, network requests, preview synchronization, history, and specialized
image/array widgets. Field rendering lives in `static/cms/studio/fields.js`;
default templates and presentation helpers live in `field-model.js`.
Nested field reads and writes also live in `field-model.js`, including creation
of missing object and array segments. This gives the renderer and entry
orchestrator one strictly checked field-path contract.

Studio save and delete requests live in `static/cms/studio/mutation-client.js`.
The client owns mutation payloads, editor request headers, response parsing,
authentication detection, validation issues, and revision conflicts. The entry
orchestrator retains confirmations, field-error DOM, status text, and navigation.

Studio history reads and restores live in `static/cms/studio/history-client.js`.
The client owns query encoding, restore request headers and payloads,
authentication detection, response validation, and normalization of history
rows. The orchestrator still owns confirmation, history markup, form rerendering,
and preview announcements.

The Studio delete confirmation is a named modal dialog. It focuses Cancel when
opened, contains Tab traversal, and restores the invoking Delete button when it
is dismissed. Its Escape handler stops at the dialog boundary so the same key
does not also close a parent inline-editor Studio drawer. The open dialog passes
axe with sequential heading structure and sufficient contrast for its
destructive confirmation action.

Studio history is a named disclosure region connected to its History button.
Opening focuses the panel's Close action; close, Escape, and successful restore
collapse the region, update expanded state, and return focus. The open region
passes axe, and embedded Escape is contained before the parent drawer listener.

Studio entry creation uses a named modal dialog with the entry-ID guidance as
its description. It keeps focus within enabled dialog controls, restores the
New or Create First Entry opener on dismissal, and consumes Escape before an
embedded parent drawer can close. The open dialog passes axe.

Collection reordering is a named disclosure region and semantic list. Each row
supports pointer dragging plus localized Move up and Move down buttons. Entry,
movement, cancellation, saving, and Escape preserve useful keyboard focus;
embedded Escape stays within Studio. The open region passes axe.

Studio image preparation and upload requests live in
`static/cms/studio/upload-client.js`. The typed module owns accepted MIME types,
bitmap scaling, canvas encoding, dimension normalization, multipart requests,
authentication callbacks, and response validation. Gallery and single-image
rendering remain in the entry orchestrator.

Studio entry and schema loading lives in `static/cms/studio/entry-loader.js`.
The typed loader runs both requests concurrently and normalizes authentication,
curated source-read errors, missing entries, new-entry templates, revisions,
validation issues, and publication metadata before the orchestrator chooses a
screen and renders fields.

Studio outbound preview and field-selection coordination lives in
`static/cms/studio/sync-client.js`. The typed controller owns debounced embedded
previews, save/delete announcements, ready messages, same-origin selection
filtering, the cross-tab channel, and page-exit cleanup. The orchestrator retains
field lookup, scrolling, and pending selection state before entry loading.

The inline toolbar's deployment polling and state translation live in
`static/cms/editor/deployment-status.js`. The toolbar supplies its authenticated
fetch function and DOM callbacks, keeping the polling module independent of
toolbar markup and runtime configuration.

Publish API outcome classification lives in
`static/cms/editor/publish-result.js`. It turns recovery failures, conflicts,
webhook failures, accepted rebuilds, and no-op publishes into a typed status,
toast, retry visibility, and reload decision. The toolbar performs those effects
without duplicating the result branching.

Draft HTTP operations live in `static/cms/editor/draft-client.js`. It owns the
same-origin credentials, request header, methods and JSON bodies for draft state,
publish, discard, and deployment retry. It validates HTTP and webhook-level
failures and normalizes the small draft-state response before the toolbar changes
control visibility.

Preview-cookie transitions live in `static/cms/editor/preview-mode.js`. The typed
controller enables preview before mounting a static editor, removes a stale
preview cookie in server delivery, and leaves policy-managed draft sessions
alone. Its injected document and reload boundary keeps the behavior testable
without moving DOM ownership out of the toolbar.

The inline `static/cms/editor/toolbar.js` orchestrator and its configuration and
highlight dependencies are strictly checked. Runtime configuration normalizes
untrusted injected paths, modes, cloud endpoints, project IDs, environments,
and session storage keys. Toolbar callbacks, navigation links, status states,
and optional controls use explicit browser types.

Page-side Studio synchronization in `static/cms/editor/sync.js` is strictly
checked together with its binding and sanitizer dependencies. The controller
validates iframe, BroadcastChannel, and persisted selection messages before
using their collection, entry, field, route, or content values in selectors,
navigation, and DOM updates. Unsupported message types, malformed content data,
empty binding segments, and invalid timestamps are ignored.

Inline text editing in `static/cms/editor/text-edit.js` and its link interaction
controller are strictly checked. Element state, snapshots, binding resolution,
save outcomes, conflicts, and link-popover callbacks have explicit contracts.
Link application now exits safely if the browser selection disappears while
the popover is open.

Inline image editing in `static/cms/editor/image-edit.js`, image utilities, and
request-security helpers are strictly checked. Upload responses are validated
before their URL reaches the image or saved entry. Compression falls back to
the original image when the browser cannot provide a 2D canvas context, and
Turnstile tokens are normalized before becoming request headers.

The floating rich-text toolbar is strictly checked. Toolbar buttons, selection
ranges, active editable elements, positioning, and link callbacks use explicit
browser types. Link popovers now retain ownership of the editable field through
focus changes, resolve the live anchor after DOM normalization, and mark direct
attribute changes as dirty. Markdown blocks also defer blur saves while the
shared link popover is active.

Markdown block editing, structural paragraph grouping, and the browser-side
Markdown serializer are strictly checked. Paragraph source metadata is parsed
as an untrusted DOM boundary and must contain 1–128 consecutive top-level block
paths with valid, ordered source hints. A malformed group remains visible and
read-only, preventing an editor boot failure or a corrupt mutation. The first
source must also match the group's binding and source attributes before editing
is enabled.

The shared inline save queue is strictly checked. It validates entry snapshots,
safe nonnegative revisions, mutation response objects, and nested field paths.
A successful HTTP write with missing or `null` JSON now remains successful and
advances from the guarded expected revision. A malformed 409 body still follows
the conflict path and refreshes the latest entry, so local edits retain their
normal Keep mine or Load latest recovery choices.

The content-map controller is strictly checked. Map rows retain the exact page
binding they represent, so duplicate collection, entry, and field bindings
navigate independently instead of all selecting the first element. Entry data
and nested override paths are validated before use, overlapping refreshes cannot
render stale results, and repeated mounts cannot install duplicate listeners.
The map is a named region with native button rows and a named close control, and
it is removed from the accessibility tree while closed.

The section/layout controller family is strictly checked, including its model,
API client, pickers, selection, spacing drag, and reorder helpers. Mutation
requests preserve the resolved collection and normalize malformed response
bodies. Section data receives unique IDs before it enters node maps. Insert and
spacing pickers use named dialogs with managed focus and Escape restoration.
Overlay containers ignore pointer input outside their visible buttons, so they
cannot block editing content in short sections.

The top-level inline editor entry is strictly checked, so its complete imported
module graph now includes Studio panel mounting, editor guards, toasts,
link-follow affordances, and stega hydration. Panel state treats session storage
as optional and handles Escape inside the same-origin Studio iframe. Link
affordances cancel their hide timer when focused. Toast actions normalize sync
and async callbacks, while stega hydration promotes only complete parsed
bindings and still strips invalid hidden metadata from rendered text.

The Astro development-toolbar app is strictly checked as the final separate
browser entry. Its binding scan and grouped row model use explicit DOM contracts.
Highlight controls report their pressed state without changing whether the app
panel is open. Repeated scroll flashes share their original inline style, and a
rescan updates the toolbar warning badge when problems appear or are removed.

The renderer receives callbacks for field updates and specialized widgets. Its
publication-field callback reads current state after schema loading, so the
module does not capture an outdated initial configuration. Existing nested
field paths and accessible control IDs remain shared through `field-model.js`.

Run `npm run typecheck:browser` for strict JavaScript checking of the Studio
entry orchestrator and extracted modules. This also runs through core type
checking, `npm run check`, and CI. The browser tsconfig selects
`static/cms/dev-toolbar/app.js`, `static/cms/editor.js`, `static/cms/admin-entry.js`,
`static/cms/studio/**/*.js`, plus the deployment,
publish-result, draft-client, preview-mode, toolbar, save queue, content map, section/layout, page-side sync, text-editing,
image-editing, rich-toolbar, and Markdown editing modules and their imported dependencies and uses
JSDoc types; it does not
generate or relocate assets. Schema types come from core's existing TypeScript
contract via type-only references.

The Studio entry, complete inline editor module graph, and development-toolbar
app are all covered by the strict browser configuration.
When extracting more modules, add types and callbacks at their boundaries and
keep tests exercising the actual editor flow.

Static modules remain packaged under `static/` and served from `/__caret/` by
the existing asset route, including production builds. They do not introduce
runtime dependencies or new public package exports.

Verification includes Studio CRUD, nested forms, multiline Markdown fields,
    preview synchronization, deployment polling, every publish outcome, automatic
static preview enablement, and draft discard and deploy retry through real toolbar clicks, plus production asset
loading. The production CSP test applies a script policy to the
real Studio HTML with hashes for its existing inline shell scripts and `'self'`
for modules; it verifies save/reload without script errors or policy violations.
This test does not change the site's production CSP configuration.

Studio CRUD verification also forces a real revision conflict after local form
editing. The conflict status remains visible, the form value is retained, and a
second save succeeds using the server revision returned by the first response.
The same suite restores an earlier snapshot through the history client, verifies
the restored form and status, and confirms the replaced state remains available
as a new undo snapshot.
It also selects a real PNG through Chromium, checks the uploaded preview and
filename-derived metadata, validates dimensions, persists the entry, and reads
the stored result back through the API.
Loader verification covers existing, new, singleton-initialized, and unreadable
entries. The Markdown browser fixture confirms unsupported frontmatter opens the
actionable load-error screen and recovers after the source is repaired and Retry
is clicked.
The sidebar-preview suite verifies embedded messages in both directions,
debounced live form previews, save-driven page refresh, standalone
BroadcastChannel selection, cross-route navigation, and post-navigation field
highlighting.
The Markdown suite also intercepts a rendered document to inject malformed
paragraph metadata before editor boot. Chromium confirms the affected prose
stays visible and read-only without a page error, while valid structural editing,
formatting, retry, stale-source, publish, restore, and rebuild flows still pass.
The primary Chromium suite intercepts a successful mutation and replaces its
JSON with `null`; the toolbar still reports success, the editable text remains,
and an anonymous request confirms the committed value. Existing 409 tests cover
both loading the latest value and retrying with the local value.
It also opens the content map against two identical page bindings while the
entry API returns malformed data. Keyboard activation highlights the selected
duplicate, closing the panel hides its named region from accessibility roles,
and the page reports no runtime error.
The starter page now mounts two real layout sections. Chromium opens and closes
the insert picker by keyboard, sends collection-aware reorder and visibility
mutations through the real server while receiving `null` response bodies,
verifies their persisted layout, and confirms the section overlay does not
block a caretize-generated editable heading.
Additional primary tests inject valid and malformed stega payloads into a real
document, block panel session storage, send Escape from inside the Studio iframe,
and hold keyboard focus on the floating link affordance beyond its hide delay.
