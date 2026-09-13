import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubDeploymentStatusProvider,
  githubDeploymentProvider,
} from "../../packages/core/src/providers/deployment/github";
import type { DeploymentTarget } from "../../packages/core/src/types";

const target: DeploymentTarget = {
  id: "deploy-correlation-1",
  requestedAt: 1,
  commit: "abc123",
  published: [{ collection: "pages", id: "home", revision: 2, deleted: false }],
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function deployment(payload: unknown = {
  caret: { deploymentId: target.id, commit: target.commit, published: target.published },
}) {
  return {
    id: 42,
    sha: target.commit,
    environment: "production",
    payload,
    statuses_url: "https://api.github.com/repos/web-stacked/caretcms/deployments/42/statuses",
  };
}

describe("GitHub deployment status provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("requires the exact Caret correlation id before reading statuses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json([
      deployment({ caret: { deploymentId: "another-deploy" } }),
    ]));
    const provider = githubDeploymentProvider({ owner: "web-stacked", repo: "caretcms" });
    expect(await provider.getDeploymentStatus({ target, request: new Request("https://site.test") })).toEqual({
      state: "deploying",
      buildId: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps queued and successful statuses with provider identity and content evidence", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json([deployment()]))
      .mockResolvedValueOnce(json([{ state: "in_progress", description: "Building" }]))
      .mockResolvedValueOnce(json([deployment()]))
      .mockResolvedValueOnce(json([{
        state: "success",
        description: "Deployed",
        environment_url: "https://caretcms.example",
      }]));
    const provider = new GitHubDeploymentStatusProvider({
      owner: "web-stacked",
      repo: "caretcms",
      environment: "production",
    });

    expect(await provider.getDeploymentStatus({ target, request: new Request("https://site.test") })).toMatchObject({
      state: "deploying",
      buildId: "42",
      message: "Building",
    });
    expect(await provider.getDeploymentStatus({ target, request: new Request("https://site.test") })).toEqual({
      state: "live",
      buildId: "42",
      buildUrl: "https://caretcms.example",
      message: "Deployed",
      deployed: { commit: "abc123", published: target.published },
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("sha=abc123");
    expect(String(fetchMock.mock.calls[1][0])).toContain("per_page=1");
  });

  it("maps failure states and reads a token only from the configured environment variable", async () => {
    vi.stubEnv("CARET_GITHUB_TOKEN", "private-token");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json([deployment()]))
      .mockResolvedValueOnce(json([{ state: "failure", description: "Build failed", log_url: "https://github.com/log" }]));
    const provider = githubDeploymentProvider({
      owner: "web-stacked",
      repo: "caretcms",
      tokenEnv: "CARET_GITHUB_TOKEN",
    });
    expect(await provider.getDeploymentStatus({ target, request: new Request("https://site.test") })).toMatchObject({
      state: "failed",
      buildId: "42",
      buildUrl: "https://github.com/log",
      message: "Build failed",
    });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer private-token");
  });

  it("rejects unsafe repository and token environment names", () => {
    expect(() => githubDeploymentProvider({ owner: "../owner", repo: "caretcms" })).toThrow(/repository-safe/);
    expect(() => githubDeploymentProvider({ owner: "owner", repo: "caretcms", tokenEnv: "BAD-NAME" })).toThrow(/tokenEnv/);
  });

  it("rejects malformed or cross-origin GitHub API responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json([{
      ...deployment(),
      statuses_url: "https://attacker.example/statuses",
    }]));
    const provider = githubDeploymentProvider({ owner: "web-stacked", repo: "caretcms" });
    expect(await provider.getDeploymentStatus({ target, request: new Request("https://site.test") })).toEqual({
      state: "deploying",
      buildId: null,
    });
  });
});
