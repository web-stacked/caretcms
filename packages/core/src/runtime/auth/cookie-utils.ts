function isProxyTrusted(): boolean {
  const raw = process.env.CARET_TRUST_PROXY;
  if (!raw) return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function shouldUseSecureCookies(request?: Request): boolean {
  // Only honor X-Forwarded-Proto when the deployment has explicitly opted in
  // via CARET_TRUST_PROXY. Otherwise any client could send
  // `X-Forwarded-Proto: http` to suppress the Secure flag on the session
  // cookie, leaking it on a TLS downgrade.
  if (isProxyTrusted()) {
    const forwarded = request?.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    if (forwarded) return forwarded === "https";
  }

  if (request) {
    try {
      return new URL(request.url).protocol === "https:";
    } catch {
      // fall through to NODE_ENV
    }
  }

  return process.env.NODE_ENV === "production";
}

export function sanitizeRedirect(
  value: string | null | undefined,
  fallback: string,
): string {
  if (!value) return fallback;
  return value.startsWith("/") && !value.startsWith("//") ? value : fallback;
}
