import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hasConfiguredEditorPassword,
  isEditorAuthenticated,
  issueEditorSessionCookie,
} from '../../packages/core/src/runtime/auth/session';

const SESSION_COOKIE_NAME = 'caret_session';

function cookieValueFromHeader(setCookie: string): string {
  // serializeEditorSessionCookie URI-encodes the token; mimic what cookie parsers
  // do — strip the leading "name=" and stop at the first "; " segment.
  const [pair] = setCookie.split('; ');
  const eq = pair.indexOf('=');
  return decodeURIComponent(pair.slice(eq + 1));
}

function asCookieBag(token: string | null) {
  return {
    cookies: {
      get(name: string) {
        if (name === SESSION_COOKIE_NAME && token !== null) return { value: token };
        return undefined;
      },
    },
  };
}

describe('auth token verification', () => {
  let originalEditPassword: string | undefined;
  let originalCaretPassword: string | undefined;
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalEditPassword = process.env.EDIT_PASSWORD;
    originalCaretPassword = process.env.CARET_EDIT_PASSWORD;
    originalSecret = process.env.CARET_SESSION_SECRET;
    process.env.CARET_EDIT_PASSWORD = 'pw-for-tests';
    process.env.CARET_SESSION_SECRET = 'secret-for-tests';
  });

  afterEach(() => {
    if (originalEditPassword === undefined) delete process.env.EDIT_PASSWORD;
    else process.env.EDIT_PASSWORD = originalEditPassword;
    if (originalCaretPassword === undefined) delete process.env.CARET_EDIT_PASSWORD;
    else process.env.CARET_EDIT_PASSWORD = originalCaretPassword;
    if (originalSecret === undefined) delete process.env.CARET_SESSION_SECRET;
    else process.env.CARET_SESSION_SECRET = originalSecret;
  });

  it('hasConfiguredEditorPassword reflects env vars', () => {
    expect(hasConfiguredEditorPassword()).toBe(true);
    delete process.env.CARET_EDIT_PASSWORD;
    delete process.env.EDIT_PASSWORD;
    expect(hasConfiguredEditorPassword()).toBe(false);
  });

  it('accepts a freshly issued token', () => {
    const cookie = issueEditorSessionCookie('/');
    const token = cookieValueFromHeader(cookie);
    expect(isEditorAuthenticated(asCookieBag(token))).toBe(true);
  });

  it('rejects a token with a tampered signature', () => {
    const cookie = issueEditorSessionCookie('/');
    const token = cookieValueFromHeader(cookie);
    const [payload, sig] = token.split('.');
    // Flip a character in the middle of the signature — flipping only the
    // last char of a base64url string isn't reliable because the trailing
    // bits may not be significant, so different chars can decode to the
    // same buffer.
    const mid = Math.floor(sig.length / 2);
    const flipped =
      sig.slice(0, mid) + (sig[mid] === 'A' ? 'B' : 'A') + sig.slice(mid + 1);
    expect(isEditorAuthenticated(asCookieBag(`${payload}.${flipped}`))).toBe(false);
  });

  it('rejects a token signed with a different secret', () => {
    const cookie = issueEditorSessionCookie('/');
    const token = cookieValueFromHeader(cookie);
    process.env.CARET_SESSION_SECRET = 'different-secret';
    expect(isEditorAuthenticated(asCookieBag(token))).toBe(false);
  });

  it('rejects an empty or malformed token', () => {
    expect(isEditorAuthenticated(asCookieBag(null))).toBe(false);
    expect(isEditorAuthenticated(asCookieBag(''))).toBe(false);
    expect(isEditorAuthenticated(asCookieBag('not-a-token'))).toBe(false);
    expect(isEditorAuthenticated(asCookieBag('only.parts'))).toBe(false);
  });
});

describe('session secret fallback', () => {
  let originalNodeEnv: string | undefined;
  let originalPassword: string | undefined;
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    originalPassword = process.env.CARET_EDIT_PASSWORD;
    originalSecret = process.env.CARET_SESSION_SECRET;
    delete process.env.CARET_SESSION_SECRET;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalPassword === undefined) delete process.env.CARET_EDIT_PASSWORD;
    else process.env.CARET_EDIT_PASSWORD = originalPassword;
    if (originalSecret === undefined) delete process.env.CARET_SESSION_SECRET;
    else process.env.CARET_SESSION_SECRET = originalSecret;
  });

  it('throws in production when password is set but secret is not', () => {
    process.env.NODE_ENV = 'production';
    process.env.CARET_EDIT_PASSWORD = 'pw';
    expect(() => issueEditorSessionCookie('/')).toThrow(/CARET_SESSION_SECRET/);
  });

  it('allows the dev fallback when no password is configured', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.CARET_EDIT_PASSWORD;
    delete process.env.EDIT_PASSWORD;
    expect(() => issueEditorSessionCookie('/')).not.toThrow();
  });
});
