import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deploymentCoversTarget,
  normalizeDeploymentEvidence,
} from "../../packages/core/src/runtime/deployment-status";
import { GET } from "../../packages/core/src/runtime/routes/deployment";
import { issueEditorSessionCookie, getEditorId } from "../../packages/core/src/runtime/auth/session";
import { __setRuntimeServicesForTests } from "../../packages/core/src/runtime/providers";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { simulatedDeploymentProvider } from "../../packages/core/src/providers/deployment/simulated";
import type { DeploymentTarget } from "../../packages/core/src/types";

const target: DeploymentTarget = {
  id: "deploy-1",
  requestedAt: 1_000,
  commit: null,
  published: [
    { collection: "pages", id: "home", revision: 2, deleted: false },
    { collection: "posts", id: "old", revision: 4, deleted: true },
  ],
};

function cookieValue(setCookie: string): string {
  const pair = setCookie.split(";")[0];
  return pair.slice(pair.indexOf("=") + 1);
}

describe("deployment status evidence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    __setRuntimeServicesForTests(null);
  });

  it("requires a live build to cover every published revision", () => {
    expect(deploymentCoversTarget(target, {
      commit: null,
      published: [
        { collection: "pages", id: "home", revision: 3, deleted: false },
        { collection: "posts", id: "old", revision: 4, deleted: true },
      ],
    })).toBe(true);
    expect(deploymentCoversTarget(target, {
      commit: null,
      published: [{ collection: "pages", id: "home", revision: 3, deleted: false }],
    })).toBe(false);
  });

  it("accepts an exact git commit as inclusion evidence", () => {
    const gitTarget = { ...target, commit: "abc123" };
    expect(deploymentCoversTarget(gitTarget, { commit: "abc123", published: [] })).toBe(true);
  });

  it("downgrades an unproven live result and rejects unsafe build URLs", () => {
    expect(normalizeDeploymentEvidence(target, {
      state: "live",
      buildId: " build-7 ",
      buildUrl: "javascript:alert(1)",
      deployed: { commit: null, published: [] },
    }, 2_000)).toEqual({
      configured: true,
      state: "unknown",
      buildId: "build-7",
      target,
      checkedAt: 2_000,
      message: "The live build did not prove it contains this published revision",
    });
  });

  it("simulates deterministic deploying, live, and failed builds", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_500);
    const live = simulatedDeploymentProvider({ durationMs: 1_000 });
    expect((await live.getDeploymentStatus({ target, request: new Request("https://site.test") })).state).toBe("deploying");
    now.mockReturnValue(2_100);
    expect(await live.getDeploymentStatus({ target, request: new Request("https://site.test") })).toMatchObject({
      state: "live",
      buildId: "simulated-deploy-1",
      deployed: { published: target.published },
    });
    const failed = simulatedDeploymentProvider({ durationMs: 0, result: "failed" });
    expect((await failed.getDeploymentStatus({ target, request: new Request("https://site.test") })).state).toBe("failed");
  });

  it("serves authenticated provider evidence for the editor's latest target", async () => {
    vi.stubEnv("CARET_SESSION_SECRET", "test-secret");
    const session = cookieValue(issueEditorSessionCookie("/"));
    const cookies = { get: (name: string) => name === "caret_session" ? { value: session } : undefined };
    const base = new InMemoryAdapter();
    const overlay = await base.makeEditorOverlay(getEditorId({ cookies })!);
    await overlay.setDeploymentTarget!(target);
    __setRuntimeServicesForTests({
      adapter: base,
      uploadHandler: { async upload() { return { url: "/unused" }; } },
      deploymentStatusProvider: {
        async getDeploymentStatus() {
          return { state: "live", buildId: "provider-build-9", deployed: target };
        },
      },
    });

    const response = await GET({
      cookies,
      request: new Request("https://site.test/api/cms/deployment"),
    } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      configured: true,
      state: "live",
      buildId: "provider-build-9",
      target: { id: "deploy-1" },
    });
  });

  it("does not expose provider errors as false completion", async () => {
    vi.stubEnv("CARET_SESSION_SECRET", "test-secret");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const session = cookieValue(issueEditorSessionCookie("/"));
    const cookies = { get: (name: string) => name === "caret_session" ? { value: session } : undefined };
    const base = new InMemoryAdapter();
    const overlay = await base.makeEditorOverlay(getEditorId({ cookies })!);
    await overlay.setDeploymentTarget!(target);
    __setRuntimeServicesForTests({
      adapter: base,
      uploadHandler: { async upload() { return { url: "/unused" }; } },
      deploymentStatusProvider: { async getDeploymentStatus() { throw new Error("secret provider detail"); } },
    });
    const response = await GET({ cookies, request: new Request("https://site.test/api/cms/deployment") } as never);
    const body = await response.json();
    expect(body).toMatchObject({
      configured: true,
      state: "unknown",
      message: "Deployment status is temporarily unavailable",
    });
    expect(JSON.stringify(body)).not.toContain("secret provider detail");
  });
});
