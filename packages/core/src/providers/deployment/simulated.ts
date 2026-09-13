import type {
  DeploymentStatusEvidence,
  DeploymentStatusProvider,
  DeploymentTarget,
} from "../../types.js";

export interface SimulatedDeploymentOptions extends Record<string, unknown> {
  /** Time spent in `deploying`. Defaults to 1500ms. */
  durationMs?: number;
  /** Terminal state. Defaults to `live`. */
  result?: "live" | "failed";
}

class SimulatedDeploymentStatusProvider implements DeploymentStatusProvider {
  constructor(private readonly options: SimulatedDeploymentOptions = {}) {}

  async getDeploymentStatus({ target }: { target: DeploymentTarget; request: Request }): Promise<DeploymentStatusEvidence> {
    const configured = this.options.durationMs;
    const durationMs = Number.isFinite(configured)
      ? Math.max(0, Math.min(Number(configured), 60_000))
      : 1_500;
    const buildId = `simulated-${target.id}`;
    if (Date.now() - target.requestedAt < durationMs) {
      return { state: "deploying", buildId };
    }
    if (this.options.result === "failed") {
      return { state: "failed", buildId, message: "Simulated deployment failed" };
    }
    return {
      state: "live",
      buildId,
      deployed: { published: target.published, commit: target.commit },
    };
  }
}

export function simulatedDeploymentProvider(
  options?: SimulatedDeploymentOptions,
): DeploymentStatusProvider {
  return new SimulatedDeploymentStatusProvider(options);
}

export default simulatedDeploymentProvider;
