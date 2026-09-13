# Markdown paragraph editing

Consecutive, supported top-level paragraphs share one editing region. Enter
splits at the caret or inserts a paragraph at its end. Backspace at a paragraph's
start merges it with the previous paragraph; Delete at its end merges the next.
Selection deletion, undo, redo, and Shift+Enter use the browser's editing history.
Undo is retained when leaving and returning to a region. Reload starts a new
browser history; saved drafts and published history remain available separately.

Paste inserts plain text. Blank lines separate paragraphs, while single newlines
become hard breaks. Unicode text is preserved. Inline bold, emphasis, links and
code are sanitized and serialized independently in each paragraph. An empty
region can be edited again before publishing; publishing removes empty paragraphs
because Markdown does not represent empty paragraph nodes.

Saving leaves the source file unchanged. A structural draft records the original
paragraph stamps and one combined source range. Every source hash and the blank
separators between consecutive paragraphs are checked before saving. Publishing
checks the combined range again, then uses the existing recoverable source-write
and history workflow. Older tabs cannot overwrite only part of a merged draft.
A failed network save keeps edits in the page; focus and leave the region to retry.
On conflict, copy unsaved edits before reloading.

Unchanged paragraph HTML retains the corresponding original Markdown text, even
if its position within the region changes. Changed paragraphs use the existing
inline serializer. Paragraph separators normalize to a blank line. Within a
changed paragraph, reference links normalize to inline links and link titles are
removed; definitions elsewhere in the document remain untouched.

The initial scope has deliberate boundaries:

- Groups stop at headings, lists, blockquotes, code, HTML, tables, definitions,
  unsupported inline elements, or nonconsecutive source stamps. Nested blocks
  keep their existing single-block editor; Enter cannot restructure them.
- Conservative source checks leave unusual paragraphs (such as literal pipes or
  indented continuation lines) in the existing single-block editor. MDX and
  arbitrary block conversion are outside this feature.
- Each request allows up to 128 source paragraphs, 128 resulting paragraphs, and
  65,536 combined HTML characters (UTF-16 code units). Initial browser regions are smaller to leave edit room.
- Editor previews add a `div[data-caret-md-sources]` around their paragraphs.
  Sites should style prose descendants instead of depending on paragraphs being
  direct children of the article. Public rendering uses the normal Markdown HTML.
- Validation covers Chromium. Safari, Firefox, and mobile IME behavior require
  additional browser coverage before claiming support for those editing details.

The stamp format participates in Astro's content-cache configuration, so an
upgrade rebuild regenerates paragraph markers. Previously generated pages retain
their existing single-block behavior until rebuilt.

Verification lives in `md-paragraphs.test.ts`, `md-block-mutation.test.ts`,
`md-preview-swap.test.ts`, stamping/parity tests, and `markdown-body.spec.ts`.
Browser checks cover split, merge in both directions, insertion, selection
deletion, undo, Unicode paste, formatting, failed-save retry, nested boundaries,
stale source, preview reload, publish, fresh rebuild, and exact history restore.
