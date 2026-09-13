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

Collection `publication.field` configuration describes entry visibility. Studio
shows **Public** or **Hidden** separately from the save state. In a draft workflow,
a saved change to that field remains private until publication. In direct server
delivery, saving it changes shared visibility immediately.

Private drafts belong to an editor identity. A stable identity from an identity
provider can reopen its drafts after signing out and back in, so the sign-out
dialog offers **Keep drafts and sign out**. A shared-password session uses a
session-specific draft identity; clearing that session makes its drafts
inaccessible, so the dialog asks the editor to publish, discard, or cancel instead.

See [static delivery](./static-delivery.md),
[authorization policy](./authorization-policy.md), and
[publish recovery](./publish-recovery.md) for the underlying runtime behavior.
