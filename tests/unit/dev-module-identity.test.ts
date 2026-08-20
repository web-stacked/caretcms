import { describe, expect, it, vi } from "vitest";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";

describe("Astro dev module identity", () => {
  it("shares request context after the runtime module is evaluated again", async () => {
    const first = await import("../../packages/core/src/runtime/request-context");
    vi.resetModules();
    const second = await import("../../packages/core/src/runtime/request-context");
    const adapter = new InMemoryAdapter();

    await first.runWithRequestContext({
      adapter,
      uploadHandler: {} as never,
      sessionId: null,
      demoMode: false,
    }, async () => {
      expect(second.requireRequestContext().adapter).toBe(adapter);
    });
  });

  it("shares explicit schemas after the registry module is evaluated again", async () => {
    const first = await import("../../packages/core/src/runtime/schema-registry");
    first.registerCollectionSchema("module-identity-fixture", {
      type: "object",
      properties: { title: { type: "string" } },
    }, null);

    vi.resetModules();
    const second = await import("../../packages/core/src/runtime/schema-registry");
    expect(second.getRegisteredSchema("module-identity-fixture")?.schema).toMatchObject({
      properties: { title: { type: "string" } },
    });
  });
});
