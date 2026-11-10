import { afterEach, describe, expect, it, vi } from "vitest";
import { missingProductionSettings } from "../../packages/core/src/runtime/auth/session";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("missingProductionSettings", () => {
  it("names both settings a production sign-in needs", () => {
    vi.stubGlobal("__ASTRO_CARET_DEV__", false);
    vi.stubEnv("CARET_EDIT_PASSWORD", "");
    vi.stubEnv("EDIT_PASSWORD", "");
    vi.stubEnv("CARET_SESSION_SECRET", "");
    expect(missingProductionSettings()).toEqual(["CARET_EDIT_PASSWORD", "CARET_SESSION_SECRET"]);
  });

  it("names the secret alone when only the password is set", () => {
    vi.stubGlobal("__ASTRO_CARET_DEV__", false);
    vi.stubEnv("CARET_EDIT_PASSWORD", "a-strong-password");
    vi.stubEnv("CARET_SESSION_SECRET", "");
    expect(missingProductionSettings()).toEqual(["CARET_SESSION_SECRET"]);
  });

  it("asks for nothing in dev, where temporary ones stand in", () => {
    vi.stubGlobal("__ASTRO_CARET_DEV__", true);
    vi.stubEnv("CARET_EDIT_PASSWORD", "");
    vi.stubEnv("CARET_SESSION_SECRET", "");
    expect(missingProductionSettings()).toEqual([]);
  });
});
