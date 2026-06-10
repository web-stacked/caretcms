import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "crypto";
import {
  getEditorId,
  isEditorAuthenticated,
  issueEditorSessionCookie,
} from "../../packages/core/src/runtime/auth/session";

const SESSION_COOKIE_NAME = "caret_session";
const SECRET = "secret-for-tests";

function tokenFromCookie(setCookie: string): string {
  const [pair] = setCookie.split("; ");
  return decodeURIComponent(pair.slice(pair.indexOf("=") + 1));
}

function decodePayload(token: string): Record<string, unknown> {
  const [payloadB64] = token.split(".");
  return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
}

/** Forge a validly-signed token with an arbitrary payload (for the legacy case). */
function signedToken(payload: Record<string, unknown>): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", SECRET).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
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

describe("editor identity in the session token", () => {
  let prevPassword: string | undefined;
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevPassword = process.env.CARET_EDIT_PASSWORD;
    prevSecret = process.env.CARET_SESSION_SECRET;
    process.env.CARET_EDIT_PASSWORD = "pw-for-tests";
    process.env.CARET_SESSION_SECRET = SECRET;
  });
  afterEach(() => {
    if (prevPassword === undefined) delete process.env.CARET_EDIT_PASSWORD;
    else process.env.CARET_EDIT_PASSWORD = prevPassword;
    if (prevSecret === undefined) delete process.env.CARET_SESSION_SECRET;
    else process.env.CARET_SESSION_SECRET = prevSecret;
  });

  it("mints a string editorId into every issued token", () => {
    const token = tokenFromCookie(issueEditorSessionCookie("/"));
    const payload = decodePayload(token);
    expect(typeof payload.editorId).toBe("string");
    expect((payload.editorId as string).length).toBeGreaterThan(0);
  });

  it("mints a distinct editorId per login", () => {
    const a = decodePayload(tokenFromCookie(issueEditorSessionCookie("/"))).editorId;
    const b = decodePayload(tokenFromCookie(issueEditorSessionCookie("/"))).editorId;
    expect(a).not.toBe(b);
  });

  it("getEditorId reads the id back from the cookie", () => {
    const token = tokenFromCookie(issueEditorSessionCookie("/"));
    const expected = decodePayload(token).editorId;
    expect(getEditorId(asCookieBag(token))).toBe(expected);
  });

  it("getEditorId returns null without a valid session", () => {
    expect(getEditorId(asCookieBag(null))).toBeNull();
    expect(getEditorId(asCookieBag("not-a-token"))).toBeNull();
  });

  it("stays backward compatible: a legacy token (no editorId) still authenticates", () => {
    const legacy = signedToken({ editor: true, exp: Date.now() + 60_000 });
    expect(isEditorAuthenticated(asCookieBag(legacy))).toBe(true);
    expect(getEditorId(asCookieBag(legacy))).toBeNull();
  });

  it("rejects a token whose editorId is the wrong type", () => {
    const bad = signedToken({ editor: true, exp: Date.now() + 60_000, editorId: 123 });
    expect(isEditorAuthenticated(asCookieBag(bad))).toBe(false);
  });
});
