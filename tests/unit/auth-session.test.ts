import { describe, expect, it, vi } from 'vitest';
import {
  clearEditorSessionCookie,
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
});
