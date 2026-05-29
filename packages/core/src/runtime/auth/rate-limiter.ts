/**
 * Sliding-window failure counter for login attempts. Holds state in-process,
 * so single-Node deployments get a meaningful brute-force defense out of the
 * box. Multi-instance or Workers deployments should layer Durable Objects or
 * a WAF rate-limit rule on top — there's no shared state here.
 */

import { isProxyTrusted } from "./cookie-utils.js";

const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

type Window = {
  attempts: number[];
};

const windows = new Map<string, Window>();

function prune(window: Window, now: number, windowMs: number): void {
  const cutoff = now - windowMs;
  while (window.attempts.length > 0 && window.attempts[0] <= cutoff) {
    window.attempts.shift();
  }
}

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export function checkLoginRateLimit(
  key: string,
  options: { maxFailures?: number; windowMs?: number; now?: number } = {},
): RateLimitResult {
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const now = options.now ?? Date.now();

  const window = windows.get(key);
  if (!window) return { allowed: true };

  prune(window, now, windowMs);
  if (window.attempts.length < maxFailures) return { allowed: true };

  const earliest = window.attempts[0];
  const retryAfterMs = Math.max(0, earliest + windowMs - now);
  return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
}

export function recordLoginFailure(
  key: string,
  options: { windowMs?: number; now?: number } = {},
): void {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const now = options.now ?? Date.now();

  let window = windows.get(key);
  if (!window) {
    window = { attempts: [] };
    windows.set(key, window);
  }
  prune(window, now, windowMs);
  window.attempts.push(now);
}

export function clearLoginAttempts(key: string): void {
  windows.delete(key);
}

/** Test-only. Resets all counters. */
export function __resetLoginRateLimiter(): void {
  windows.clear();
}

export function extractRateLimitKey(request: Request): string {
  // Best-effort client identifier. Astro doesn't expose remote IP directly in
  // all adapters, so we fall back to a forwarded-for header — but ONLY when the
  // deployment has opted into trusting its proxy via CARET_TRUST_PROXY. These
  // headers are client-controlled: an untrusted attacker can rotate
  // X-Forwarded-For per request to mint unlimited fresh buckets and bypass the
  // brute-force limit entirely. When the proxy isn't trusted we fall back to a
  // single shared "unknown" bucket — a coarser limit, but not spoofable.
  if (isProxyTrusted()) {
    const headers = request.headers;
    const candidates = [
      headers.get("cf-connecting-ip"),
      headers.get("x-real-ip"),
      headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    ];
    for (const candidate of candidates) {
      if (candidate && candidate.length > 0) return candidate;
    }
  }
  return "unknown";
}
