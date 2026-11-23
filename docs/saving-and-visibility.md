# Saving, drafts, and visibility

CaretCMS keeps its existing delivery and permission guarantees and labels each
editing surface according to where a successful save went.

| Context | Inline fields, images, and layout | Studio fields | Markdown body blocks |
| --- | --- | --- | --- |
| Server delivery without an authorization policy | Saved to shared content; changes are live | Saved to shared content; changes are live | Saved as a draft until Publish |
| Static delivery | Saved to the editor preview draft | Saved to the editor preview draft | Saved to the editor preview draft |
| Any delivery with an authorization policy | Saved to the authenticated editor's private draft | Saved to the authenticated editor's private draft | Saved to the authenticated editor's private draft |

“Unsaved changes” means the browser still contains edits that have not reached
storage. “Saving draft” and “Draft saved” mean the change is stored but is not in
shared published content. “Saving live changes” and “Changes are live” mean the
change is being written, or was written, to shared content.

Publish moves an authorized editor's stored drafts into shared content. With
static delivery, visitors still receive the previous build until the rebuild and
deployment finish. A webhook acceptance alone does not mean the deployment is
live. Markdown body blocks always require Publish because publication validates
and writes their source ranges.

Collection creation and deletion are immediate management operations for real
editors, including preview and static delivery. They change the base adapter's
collection state without waiting for Publish; demo sessions remain isolated.
Deletion follows the adapter's contract: the Markdown adapter removes collection
metadata rather than deleting its source directory. In static delivery, already
built pages remain until the next deployment.

Collection `publication.field` configuration describes entry visibility. Studio
shows **Public** or **Hidden** separately from the save state. In a draft workflow,
a saved change to that field remains private until publication: Studio labels it
**Hidden after publish** or **Public after publish** and shows **Matches live**
when the entry has no unpublished changes. In direct server delivery, saving it
changes shared visibility immediately.

Private drafts belong to an editor identity. A stable identity from an identity
provider can reopen its drafts after signing out and back in from any browser.
A shared-password sign-in remembers its editor identity per browser in a signed,
long-lived `caret_editor` cookie that signing out keeps, so the same browser
reopens its drafts after signing out or when the session expires, while people
sharing the password on different browsers keep separate drafts. In both cases
the sign-out dialog offers **Keep drafts and sign out**. Only throwaway demo
sessions lose their drafts on sign-out; there the dialog asks the editor to
publish, discard, or cancel instead.

## Text written in templates

Text typed straight into a template (`<h1 data-caret="pages::home::headline">Our work</h1>`)
has two possible sources once someone edits it: the template, and the value
saved for that binding. The saved value shows, as long as the template still
says what it said when the value was saved.

When a developer changes the template's text afterwards, the newer template
text shows instead, in dev and in builds. The dev server and the build log name
the binding. The next save or Publish of that entry removes the overtaken value
from storage; an editor who edits that text again replaces the template's text as
before.

To tell which is newer, an entry stores a short hash of the template text each
saved value replaced, under the reserved key `__caret_template__`:

```yaml
headline: "Our best work"
__caret_template__:
  headline: t38925866
```

Leave that key in place and commit it with the value. It never reaches pages,
the Studio or CaretCMS's schema validation. Astro's content collections drop
unknown keys by default; if a collection's Zod schema uses `.strict()`, declare
the key so the build accepts it (`npx @caretcms/caretize doctor` checks this):

```ts
__caret_template__: z.record(z.string(), z.string()).optional(),
``` A value saved before this record existed keeps
replacing the template until its entry is next published; delete the value from
the content file to use the template's text.

See [static delivery](./static-delivery.md),
[authorization policy](./authorization-policy.md), and
[publish recovery](./publish-recovery.md) for the underlying runtime behavior.

## Seeing what changed, and taking it back

Several people often work on one site: an editor in the browser, a developer
in Git, and sometimes a second editor. The on-page editor shows what changed
and lets an editor take a change back without the Studio.

- **Changes** (in the toolbar while you have drafts) puts a dot beside each
  element on the page that you changed (amber), that changed on the site after
  you started editing (blue), or both. A dot opens a card with the site's value
  and yours, with **Undo my change** for that one field. A change on both sides
  opens the **Keep mine** / **Use the site's version** choice. Edited body text
  gets a dot too.
- **What counts as the same content.** Two people only collide when they change
  the same value. In a group of values (a `hero` with a headline and a subtext),
  one person can change the headline and another the subtext, and both publish.
  A list is one value: when two people change the same list, the second is
  asked which version to keep.
- **Since you were last here.** When you come back to a page, content that
  changed and isn't your own edit is announced, and **Show me** steps through
  each change. What you last saw is remembered in your browser, per page.
- **Publish** lists each draft by name with what it changes. With more than one
  draft, untick the ones to keep as drafts.
- **Undo** in the message after a publish puts back what that publish replaced,
  as a new publish, so Git on publish commits it and a static site rebuilds. It
  refuses when the page changed after your publish (another publish, or a
  developer editing the file), while you have newer changes to the same page,
  and for a publish that changed Markdown body text (Undo isn't offered for
  those — restore them from Page history or History in the Studio). **Undo last
  publish** stays in the status panel for 30 minutes.
- **Tools → Page history** is a slider with a notch for each time this page's
  content was published. Clicking a notch or dragging shows what text, rich
  text, images, and Markdown body paragraphs said then, on the page itself, with
  what differs from today outlined (paragraphs added since are hidden and
  removed ones are shown again). **Restore this version** saves field-only
  changes as a draft on a site with drafts, or publishes them straight onto a
  site that saves live. When the restored version's Markdown body text differs,
  it restores that version's source file straight to the site — on a site with
  drafts, the panel says so before you click.
- **Tools → How editing works** shows the short explanation a new editor sees on
  their first sign-in in a browser.

