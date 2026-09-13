import { describe, expect, it, vi } from "vitest";
import { createDeploymentStatusPoller } from "../../packages/core/static/cms/editor/deployment-status.js";

function response(body: object): Response {
  return Response.json(body);
}

describe("browser deployment status poller", () => {
  it("schedules while deploying and stops after verified live status", async () => {
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce(response({ configured: true, state: "deploying", target: {}, buildId: "build-1" }))
      .mockResolvedValueOnce(response({ configured: true, state: "live", target: {}, buildId: "build-1" }));
    const setStatus = vi.fn();
    const setBuildId = vi.fn();
    let scheduled: (() => void) | null = null;
    const poller = createDeploymentStatusPoller({
      fetchStatus,
      setStatus,
      setBuildId,
      setTimer(callback) { scheduled = callback; return 7; },
      clearTimer: vi.fn(),
    });

    await poller.refresh();
    expect(setStatus).toHaveBeenLastCalledWith("saving", "Deploying…");
    expect(setBuildId).toHaveBeenLastCalledWith("build-1");
    expect(scheduled).not.toBeNull();
    const next = scheduled as unknown as () => void;
    next();
    await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith("idle", "Live"));
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("renders provider failure and unknown evidence without another poll", async () => {
    const states: Array<[string, string]> = [];
    const timers: Array<() => void> = [];
    const poller = createDeploymentStatusPoller({
      fetchStatus: async () => response({ configured: true, state: "failed", target: {}, buildId: "build-2" }),
      setStatus(state, text) { states.push([state, text]); },
      setBuildId() {},
      setTimer(callback) { timers.push(callback); return 1; },
      clearTimer() {},
    });
    await poller.refresh();
    expect(states).toEqual([["error", "Deploy failed"]]);
    expect(timers).toHaveLength(0);

    const unknown = createDeploymentStatusPoller({
      fetchStatus: async () => response({ configured: true, state: "unknown", target: {}, buildId: null }),
      setStatus(state, text) { states.push([state, text]); },
      setBuildId() {},
      setTimer(callback) { timers.push(callback); return 1; },
      clearTimer() {},
    });
    await unknown.refresh();
    expect(states.at(-1)).toEqual(["error", "Deploy status unknown"]);
    expect(timers).toHaveLength(0);
  });

  it("stays quiet when status is unconfigured or temporarily unavailable", async () => {
    const setStatus = vi.fn();
    const unconfigured = createDeploymentStatusPoller({
      fetchStatus: async () => response({ configured: false, state: "unknown" }),
      setStatus,
      setBuildId() {},
    });
    await unconfigured.refresh();

    const unavailable = createDeploymentStatusPoller({
      fetchStatus: async () => { throw new Error("offline"); },
      setStatus,
      setBuildId() {},
    });
    await unavailable.refresh();
    expect(setStatus).not.toHaveBeenCalled();
  });
});
