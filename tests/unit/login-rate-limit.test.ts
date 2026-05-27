import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetLoginRateLimiter,
  checkLoginRateLimit,
  clearLoginAttempts,
  extractRateLimitKey,
  recordLoginFailure,
} from "../../packages/core/src/runtime/auth/rate-limiter";

describe("login rate limiter", () => {
  beforeEach(() => {
    __resetLoginRateLimiter();
  });

  it("allows attempts under the threshold", () => {
    for (let i = 0; i < 4; i++) {
      expect(checkLoginRateLimit("ip-a").allowed).toBe(true);
      recordLoginFailure("ip-a");
    }
    expect(checkLoginRateLimit("ip-a").allowed).toBe(true);
  });

  it("blocks the 6th attempt after 5 failures", () => {
    for (let i = 0; i < 5; i++) recordLoginFailure("ip-a");
    const result = checkLoginRateLimit("ip-a");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
    }
  });

  it("scopes attempts per key", () => {
    for (let i = 0; i < 5; i++) recordLoginFailure("ip-a");
    expect(checkLoginRateLimit("ip-a").allowed).toBe(false);
    expect(checkLoginRateLimit("ip-b").allowed).toBe(true);
  });

  it("clears on successful login", () => {
    for (let i = 0; i < 5; i++) recordLoginFailure("ip-a");
    clearLoginAttempts("ip-a");
    expect(checkLoginRateLimit("ip-a").allowed).toBe(true);
  });

  it("expires entries outside the window", () => {
    const start = 1_000_000;
    for (let i = 0; i < 5; i++) {
      recordLoginFailure("ip-a", { now: start + i });
    }
    expect(checkLoginRateLimit("ip-a", { now: start + 5 }).allowed).toBe(false);
    expect(
      checkLoginRateLimit("ip-a", { now: start + 15 * 60 * 1000 + 100 }).allowed,
    ).toBe(true);
  });

  it("extracts the key from common proxy headers", () => {
    const req = new Request("https://example.com/", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    expect(extractRateLimitKey(req)).toBe("1.2.3.4");

    const xff = new Request("https://example.com/", {
      headers: { "x-forwarded-for": "5.6.7.8, 9.10.11.12" },
    });
    expect(extractRateLimitKey(xff)).toBe("5.6.7.8");

    const none = new Request("https://example.com/");
    expect(extractRateLimitKey(none)).toBe("unknown");
  });
});
