# Deployment completion status

A successful rebuild webhook only proves that a deployment service accepted a
request. It does not prove a build started, completed, or contains the content
that CaretCMS just published. Configure a deployment status provider when the
editor should show evidence-backed **Deploying**, **Live**, and **Deploy failed**
states.

## Configure a provider

Providers are runtime modules, like storage and identity providers:

```js
import caret, { defineDeploymentProvider } from '@caretcms/core';

caret({
  delivery: {
    mode: 'static',
    publish: { webhookUrl: process.env.CARET_REBUILD_WEBHOOK_URL },
  },
  deployment: defineDeploymentProvider({
    entrypoint: './src/caret-deployment.ts',
    exportName: 'deploymentStatusProvider',
  }),
});
```

The provider module exports a factory returning `DeploymentStatusProvider`:

```ts
import type { DeploymentStatusProvider } from '@caretcms/core';

export function deploymentStatusProvider(): DeploymentStatusProvider {
  return {
    async getDeploymentStatus({ target }) {
      const build = await lookupBuildByCorrelationId(target.id);
      if (!build || build.state === 'queued' || build.state === 'building') {
        return { state: 'deploying', buildId: build?.id ?? null };
      }
      if (build.state === 'failed') {
        return {
          state: 'failed',
          buildId: build.id,
          buildUrl: build.consoleUrl,
          message: build.summary,
        };
      }
      return {
        state: 'live',
        buildId: build.id,
        buildUrl: build.url,
        deployed: {
          commit: build.sourceCommit,
          published: build.caretPublishedRevisions,
        },
      };
    },
  };
}
```

The webhook body includes `deploymentId` alongside `published` and `commit`.
Carry those fields into deployment metadata so the status provider can locate
the build and report what it contains.

## GitHub Deployments

Caret ships a provider for the GitHub Deployments API:

```js
import caret, { githubDeployment } from '@caretcms/core';

caret({
  delivery: {
    mode: 'static',
    publish: { webhookUrl: process.env.CARET_REBUILD_WEBHOOK_URL },
  },
  deployment: githubDeployment({
    owner: 'acme',
    repo: 'website',
    environment: 'production',
    tokenEnv: 'CARET_GITHUB_TOKEN',
  }),
});
```

The webhook receiver creates a GitHub deployment whose payload preserves the
Caret target:

```json
{
  "environment": "production",
  "payload": {
    "caret": {
      "deploymentId": "the webhook deploymentId",
      "commit": "the deployed commit",
      "published": [
        { "collection": "pages", "id": "home", "revision": 2, "deleted": false }
      ]
    }
  }
}
```

Report progress with GitHub deployment statuses. `queued`, `pending`, and
`in_progress` map to Deploying; `success` maps to Live after core verifies the
commit or revisions; terminal non-success states map to Deploy failed. An exact
Caret `deploymentId` is required, so another deployment of the same commit
cannot satisfy the target accidentally. Caret only exposes a build link when
GitHub supplies `environment_url` or `log_url`.

Public repository deployment records can be read without authentication. For a
private repository or sustained polling, put a token with read access to
Deployments in a server-side environment variable. `tokenEnv` contains only the
variable name; the token is read at runtime and is never serialized into the
Astro provider module. See GitHub's documentation for
[deployments](https://docs.github.com/en/rest/deployments/deployments) and
[deployment statuses](https://docs.github.com/en/rest/deployments/statuses).

## Evidence rules

CaretCMS displays **Live** only when the provider reports one of these:

- The deployed git commit exactly matches the target commit.
- Every target `collection` and `id` has a deployed revision greater than or
  equal to the published target revision.

A provider response that says `live` without either form of proof is returned as
`unknown`. Build URLs are limited to HTTP(S), and provider errors become a generic
authenticated status response rather than a false success.

The latest accepted target is stored in the editor's persistent overlay,
separately from the failed-webhook retry receipt. A 2xx webhook response clears
the retry receipt as before; status polling cannot repeat content publication.

`GET /api/cms/deployment` requires an authenticated editor session. It returns
the normalized state, provider build ID, optional URL/message, the requested
target, and the check timestamp.

## Local simulation

Use the bundled deterministic provider to test the whole UI without a deployment
account:

```js
import caret, { simulatedDeployment } from '@caretcms/core';

caret({
  delivery: {
    mode: 'static',
    publish: { webhookUrl: 'http://127.0.0.1:4404/deploy' },
  },
  deployment: simulatedDeployment({ durationMs: 1500, result: 'live' }),
});
```

Set `result: 'failed'` to exercise the terminal failure state. This provider is
for local development and automated tests. A production integration still needs
the deployment service's authenticated API and build metadata described above.
