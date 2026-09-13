# Authorization policy

CaretCMS can apply a write policy supplied by an authoritative identity
adapter. Authentication answers who the editor is. The policy independently
answers which write operations that identity may perform.

Without an `authorize` function, authenticated editors retain the existing full
access behavior. Password and demo modes are unchanged. A policy is active only
on an identity adapter; this avoids assigning trusted roles from a public cookie
or browser input.

```ts
import type { IdentityAdapter } from "@caretcms/core";

export function identityProvider(): IdentityAdapter {
  return {
    async authenticate(request) {
      const user = await authenticateTrustedRequest(request);
      return user && { id: user.id, name: user.name, roles: user.roles };
    },
    loginUrl: ({ redirectTo }) => `/login?returnTo=${encodeURIComponent(redirectTo)}`,
    async authorize({ identity, action, collection, id }) {
      if (identity.roles?.includes("admin")) return true;
      if (action === "edit") return collection === "pages";
      if (action === "publish") return identity.roles?.includes("reviewer") === true;
      return false;
    },
  };
}
```

The policy receives the authenticated identity, original request, action, and
the most specific collection and entry ID available. It must return literal
`true` to grant access. `false`, another value, or an exception denies access.
Decisions are cached only within one request and evaluated again on later
requests, so a role change takes effect without restarting CaretCMS.

The actions are:

| Action | Protected operations |
| --- | --- |
| `edit` | field/body saves, entry creation, reordering, and layout changes |
| `publish` | publishing drafts, deployment retries, and history restore |
| `delete` | drafting an entry deletion and publishing that deletion |
| `manageCollections` | creating or deleting collection definitions |
| `upload` | file uploads |

Deletion requires both `edit` and `delete`. History restore requires both
`edit` and `publish`. A bulk reorder checks every entry. A bulk publish checks
every targeted draft, including delete permission for tombstones, before the
first content or history write. Collection metadata, entry reads, schemas, and
history reads remain available to authenticated Studio users; this interface is
a write policy rather than a content confidentiality boundary.

When a policy is active, all content edits use the authenticated editor's
private draft overlay even in server delivery. This prevents an editor who lacks
publish permission from writing directly to public content. If the configured
storage adapter cannot make editor overlays, writes fail with 503 and public
content stays unchanged. Studio labels saves as drafts; publish, delete, and
restore controls are hidden when the page has enough scope to evaluate them.
The server remains authoritative for uploads, when UI scope is incomplete, or
when a client calls an endpoint directly.

Drafts are isolated by identity. A reviewer cannot open or publish another
editor's draft through this API. A reviewer may edit and publish their own draft
when their policy permits it. Cross-editor submission, approval, comments,
shared review queues, content branches, and pull-request workflows require a
separate review model and are not implied by the `reviewer` role name.

Only trust identity headers when a proxy removes client-supplied copies and
writes verified values. Policy code should rely on server-verified identity and
server-side data. Do not accept roles or authorization decisions from request
bodies, query parameters, or browser storage.

Server coverage lives in `authorization.test.ts`. Chromium coverage uses a
test-only identity provider and verifies private writer drafts, denied direct
API calls, UI state, reviewer isolation and publication, anonymous rendering,
and attributed publish history.
