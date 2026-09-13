export const prerender = false;

import type { APIContext } from "astro";
import { getEditorId, isEditorAuthenticated } from "../auth/session.js";
import { normalizeDeploymentEvidence } from "../deployment-status.js";
import { getRuntimeServices } from "../providers.js";
import { json } from "./_helpers.js";

/** GET /api/cms/deployment — provider-backed status for the editor's latest deploy. */
export async function GET(context: APIContext): Promise<Response> {
  if (!isEditorAuthenticated(context)) return json({ error: "Unauthorized" }, 401);

  const editorId = getEditorId(context);
  const services = await getRuntimeServices();
  const provider = services.deploymentStatusProvider;
  if (!provider) return json({ configured: false, state: "unknown" });
  if (!editorId || !services.adapter.makeEditorOverlay) {
    return json({ configured: true, state: "unknown", target: null });
  }

  const overlay = await services.adapter.makeEditorOverlay(editorId);
  const target = await overlay.getDeploymentTarget?.() ?? null;
  if (!target) return json({ configured: true, state: "unknown", target: null });

  try {
    const evidence = await provider.getDeploymentStatus({ target, request: context.request });
    return json(normalizeDeploymentEvidence(target, evidence));
  } catch (error) {
    console.error("[caretcms] Deployment status provider failed:", error);
    return json({
      configured: true,
      state: "unknown",
      buildId: null,
      target,
      checkedAt: Date.now(),
      message: "Deployment status is temporarily unavailable",
    });
  }
}
