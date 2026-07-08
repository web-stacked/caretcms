import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  clearEditorSessionCookie,
  isEditorAuthenticated,
  issueEditorSessionCookie,
} from '../../packages/core/src/runtime/auth/session';

const PUBLIC_DEV_SECRET = 'caretcms-dev-secret';

/** Forge a session cookie value signed with a given secret (attacker's view). */
function forgeSession(secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ editor: true, exp: Date.now() + 3_600_000 }),
    'utf8',
  ).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

describe('auth session cookies', () => {
  it('marks editor session cookies as HttpOnly by default', () => {
    const cookie = issueEditorSessionCookie('/');

    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toContain('Secure');
  });

  it('uses Secure for https requests and preserves deletion flags', () => {
    const request = new Request('https://example.com/admin');
    const issued = issueEditorSessionCookie('/', request);
    const cleared = clearEditorSessionCookie('/', request);

    expect(issued).toContain('Secure');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('Secure');
    expect(cleared).toContain('Max-Age=0');
  });

  it('refuses to mint a forgeable session in a locked production deployment', () => {
    // No password configured (the "locked, read-only" state the product
    // advertises) + no session secret + production. Minting a session here would
    // have to sign it with the publicly-known dev fallback secret — anyone could
    // then forge one. So it must fail closed rather than hand one out (S1).
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CARET_EDIT_PASSWORD', '');
    vi.stubEnv('CARET_SESSION_SECRET', '');
    try {
      expect(() => issueEditorSessionCookie('/')).toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects a session forged with the public dev secret in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CARET_EDIT_PASSWORD', '');
    vi.stubEnv('CARET_SESSION_SECRET', '');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const context = {
        cookies: { get: () => ({ value: forgeSession(PUBLIC_DEV_SECRET) }) },
      };
      expect(isEditorAuthenticated(context)).toBe(false);
    } finally {
      errorSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('accepts the public dev fallback secret in a dev context (zero-config)', () => {
    // With no explicit secret and a non-production NODE_ENV (the unit-test / dev
    // default), a freshly-installed site can still sign in without setup.
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('CARET_SESSION_SECRET', '');
    try {
      const context = {
        cookies: { get: () => ({ value: forgeSession(PUBLIC_DEV_SECRET) }) },
      };
      expect(isEditorAuthenticated(context)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fails closed (not 500) when the production session secret is missing', () => {
    // A cookie minted while a secret was available...
    vi.stubEnv('CARET_SESSION_SECRET', 'test-secret');
    const issued = issueEditorSessionCookie('/');
    const token = decodeURIComponent(
      issued.split(';')[0].replace('caret_session=', ''),
    );
    vi.unstubAllEnvs();

    // ...presented in production with the secret gone and a password set:
    // verification must return "not an editor", never throw — the middleware
    // calls this on every request carrying the cookie.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CARET_EDIT_PASSWORD', 'hunter2');
    vi.stubEnv('CARET_SESSION_SECRET', '');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const context = {
        cookies: { get: () => ({ value: token }) },
      };
      expect(() => isEditorAuthenticated(context)).not.toThrow();
      expect(isEditorAuthenticated(context)).toBe(false);
    } finally {
      errorSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
