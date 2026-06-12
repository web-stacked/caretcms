import { describe, expect, it, vi } from 'vitest';
import {
  clearEditorSessionCookie,
  isEditorAuthenticated,
  issueEditorSessionCookie,
} from '../../packages/core/src/runtime/auth/session';

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

  it('uses the production fallback when no request context is available', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    vi.stubEnv('NODE_ENV', 'production');

    const cookie = issueEditorSessionCookie('/');

    expect(cookie).toContain('Secure');

    vi.unstubAllEnvs();
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
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
