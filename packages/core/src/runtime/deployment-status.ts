import type {
  DeploymentStatusEvidence,
  DeploymentTarget,
  RebuildReceipt,
} from "../types.js";

const MAX_TEXT = 512;

function cleanText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, MAX_TEXT)
    : undefined;
}

function validBuildUrl(value: unknown): string | undefined {
  const text = cleanText(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** True when provider evidence proves the target revision was in the build. */
export function deploymentCoversTarget(
  target: DeploymentTarget,
  deployed: RebuildReceipt | undefined,
): boolean {
  if (!deployed) return false;
  if (target.commit && deployed.commit === target.commit) return true;
  if (target.published.length === 0) return false;

  const revisions = new Map(
    deployed.published.map(entry => [`${entry.collection}::${entry.id}`, entry]),
  );
  return target.published.every(targetEntry => {
    const evidence = revisions.get(`${targetEntry.collection}::${targetEntry.id}`);
    return Boolean(evidence && evidence.revision >= targetEntry.revision);
  });
}

export type PublicDeploymentStatus = {
  configured: true;
  state: "deploying" | "live" | "failed" | "unknown";
  buildId: string | null;
  buildUrl?: string;
  message?: string;
  target: DeploymentTarget;
  checkedAt: number;
};

export function normalizeDeploymentEvidence(
  target: DeploymentTarget,
  evidence: DeploymentStatusEvidence,
  checkedAt = Date.now(),
): PublicDeploymentStatus {
  const buildId = cleanText(evidence.buildId) ?? null;
  const buildUrl = validBuildUrl(evidence.buildUrl);
  const message = cleanText(evidence.message);
  if (!["deploying", "live", "failed"].includes(evidence.state)) {
    return { configured: true, state: "unknown", buildId, target, checkedAt,
      message: "Deployment provider returned an invalid state" };
  }
  if (evidence.state === "live" && (!buildId || !deploymentCoversTarget(target, evidence.deployed))) {
    return { configured: true, state: "unknown", buildId, target, checkedAt,
      message: buildId
        ? "The live build did not prove it contains this published revision"
        : "The live deployment did not include a build identity" };
  }
  return {
    configured: true,
    state: evidence.state,
    buildId,
    ...(buildUrl ? { buildUrl } : {}),
    ...(message ? { message } : {}),
    target,
    checkedAt,
  };
}
