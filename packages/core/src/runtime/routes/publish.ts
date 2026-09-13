import { requirePermission, PermissionDenied } from "../authorization.js";
export const prerender = false;

import type { APIContext } from "astro";
import { isEditorAuthenticated, getEditorId } from "../auth/session.js";
import { getRuntimeServices } from "../providers.js";
import { withEditorPublishLock } from "../mutations/engine.js";
import { publishOverlay, type PublishScope } from "../publish.js";
import { isGitRepo, commitPaths } from "../git-journal.js";
import { triggerRebuildWebhook } from "../rebuild-webhook.js";
import { json, enforceCsrfHeader, readJsonBody } from "./_helpers.js";
import type { DeploymentTarget, RebuildReceipt, StorageAdapter } from "../../types.js";

function commitMessage(scope: PublishScope, count: number): string {
  if (scope.collection && scope.id) return `publish ${scope.collection}/${scope.id}`;
  if (scope.collection) return `publish ${scope.collection} (${count})`;
  return `publish content (${count} ${count === 1 ? "entry" : "entries"})`;
}

function deploymentTarget(payload: RebuildReceipt): DeploymentTarget {
  return {
    ...payload,
    id: crypto.randomUUID(),
    requestedAt: Date.now(),
  };
}

async function rememberAcceptedDeployment(
  overlay: StorageAdapter,
  target: DeploymentTarget,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled || !overlay.setDeploymentTarget) return false;
  await overlay.setDeploymentTarget(target);
  return true;
}

/**
 * POST /api/cms/publish — flush the current editor's draft overlay into the base.
 * Body: `{ collection?, id? }` to scope to one entry/collection, or `{}` for all.
 * Returns the published entries with their NEW base revisions so the editor
 * client can reconcile its revision cache (avoiding a post-publish 409).
 */
export async function POST(context: APIContext): Promise<Response> {
  const csrf = enforceCsrfHeader(context.request);
  if (csrf) return csrf;
  if (!isEditorAuthenticated(context)) return json({ error: "Unauthorized" }, 401);

  const editorId = getEditorId(context);
  if (!editorId) return json({ error: "No editor draft session" }, 400);

  const parsed = await readJsonBody(context.request);
  if (!parsed.ok) return parsed.response;
  const body = (parsed.value ?? {}) as { collection?: unknown; id?: unknown; retryRebuild?: unknown };

  const scope: PublishScope = {};
  if (typeof body.collection === "string") scope.collection = body.collection;
  if (typeof body.id === "string") scope.id = body.id;
  if (scope.id && !scope.collection) {
    return json({ error: "id requires a collection" }, 400);
  }

  try {
    const services = await getRuntimeServices();
    const { adapter: base } = services;
    if (!base.makeEditorOverlay) {
      return json({ error: "Drafts are not supported by the configured storage adapter" }, 400);
    }
    const overlay = await base.makeEditorOverlay(editorId);
    return await withEditorPublishLock(editorId, async () => {
      if (body.retryRebuild === true) {
        const receipt = await overlay.getRebuildReceipt?.();
        if (!receipt) { await requirePermission("publish"); }
        if (!receipt) return json({ error: "No deployment retry is pending" }, 400);
        for (const entry of receipt.published) {
          await requirePermission("publish", entry.collection, entry.id);
          if (entry.deleted) await requirePermission("delete", entry.collection, entry.id);
        }
        const target = deploymentTarget(receipt);
        const rebuild = await triggerRebuildWebhook(services.delivery.publish, {
          ...receipt,
          deploymentId: target.id,
        });
        let receiptError = false;
        let deploymentTracked = false;
        if (rebuild.ok) {
          try {
            deploymentTracked = await rememberAcceptedDeployment(
              overlay,
              target,
              Boolean(services.deploymentStatusProvider),
            );
          } catch { deploymentTracked = false; }
          try { await overlay.setRebuildReceipt?.(null); } catch { receiptError = true; }
        }
        return json({ ok: true, published: [], conflicts: [], failed: [], rebuild,
          deploymentTracked, retryAvailable: !rebuild.ok, receiptError });
      }
      const { published, conflicts, failed } = await publishOverlay(base, overlay, scope);

      // Best-effort git journal (opt-in via CARET_GIT_ON_PUBLISH): turn the publish
      // into a commit when content lives in a git repo. Runs AFTER the publish, so a
      // git failure never blocks or reverts it; no-ops on non-filesystem adapters.
      let commit: string | null = null;
      if (
        published.length > 0 &&
        process.env.CARET_GIT_ON_PUBLISH === "true" &&
        base.committablePath
      ) {
        const cwd = process.cwd();
        if (await isGitRepo(cwd)) {
          commit = await commitPaths({
            cwd,
            paths: [base.committablePath()],
            message: commitMessage(scope, published.length),
            authorName: `CaretCMS editor ${editorId.slice(0, 8)}`,
            authorEmail: "editor@caretcms.local",
          });
        }
      }

      let receiptError = false;
      let payload = { published, commit };
      if (published.length > 0 && services.delivery.publish.webhookUrl && overlay.setRebuildReceipt) {
        try {
          const previous = await overlay.getRebuildReceipt?.();
          const entries = new Map([...(previous?.published ?? []), ...published].map(entry => [`${entry.collection}::${entry.id}`, entry]));
          payload = { published: [...entries.values()], commit };
          await overlay.setRebuildReceipt(payload);
        } catch { receiptError = true; }
      }
      const target = deploymentTarget(payload);
      const rebuild =
        published.length > 0
          ? await triggerRebuildWebhook(services.delivery.publish, {
              ...payload,
              deploymentId: target.id,
            })
          : { triggered: false, ok: true as const };

      let deploymentTracked = false;
      if (published.length > 0 && rebuild.triggered && rebuild.ok) {
        try {
          deploymentTracked = await rememberAcceptedDeployment(
            overlay,
            target,
            Boolean(services.deploymentStatusProvider),
          );
        } catch { deploymentTracked = false; }
      }

      // Conflicted entries keep their drafts; the client surfaces them so the
      // editor can reload (fresh stamps) and re-apply. `ok` reflects the whole
      // request having been processed, not per-entry success — check `conflicts`.
      if (published.length > 0 && rebuild.ok && !receiptError) {
        try { await overlay.setRebuildReceipt?.(null); } catch { receiptError = true; }
      }
      return json({ ok: true, published, conflicts, failed, commit, rebuild,
        deploymentTracked,
        retryAvailable: !rebuild.ok && !receiptError && Boolean(overlay.setRebuildReceipt), receiptError });
    });
  } catch (error) {
    if (error instanceof PermissionDenied) return json({ error: "Permission denied" }, 403);
    console.error("[caretcms] Publish request failed:", error);
    return json({ error: "Publication could not finish. Some content may already be published; retry to recover." }, 500);
  }
}
