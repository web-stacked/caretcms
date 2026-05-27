import { describe, expect, it } from "vitest";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";

describe("SessionOverlayAdapter tombstones", () => {
  it("deleting a base-only entry keeps it deleted on next read", async () => {
    const base = new InMemoryAdapter();
    const overlay = new InMemoryAdapter();
    await base.writeEntry("pages", "home", { title: "Seeded" });

    const adapter = new SessionOverlayAdapter(base, overlay);
    expect(await adapter.getEntry("pages", "home")).toEqual({
      id: "home",
      data: { title: "Seeded" },
    });

    await adapter.deleteEntry("pages", "home");
    expect(await adapter.getEntry("pages", "home")).toBeNull();
  });

  it("listEntryIds hides tombstoned base entries", async () => {
    const base = new InMemoryAdapter();
    const overlay = new InMemoryAdapter();
    await base.writeEntry("pages", "home", { title: "Home" });
    await base.writeEntry("pages", "about", { title: "About" });

    const adapter = new SessionOverlayAdapter(base, overlay);
    await adapter.deleteEntry("pages", "home");

    expect(await adapter.listEntryIds("pages")).toEqual(["about"]);
  });

  it("writing after delete brings the entry back with overlay data", async () => {
    const base = new InMemoryAdapter();
    const overlay = new InMemoryAdapter();
    await base.writeEntry("pages", "home", { title: "Seeded" });

    const adapter = new SessionOverlayAdapter(base, overlay);
    await adapter.deleteEntry("pages", "home");
    await adapter.writeEntry("pages", "home", { title: "Reborn" });

    expect(await adapter.getEntry("pages", "home")).toEqual({
      id: "home",
      data: { title: "Reborn" },
    });
  });

  it("base data is never mutated by overlay deletes", async () => {
    const base = new InMemoryAdapter();
    const overlay = new InMemoryAdapter();
    await base.writeEntry("pages", "home", { title: "Seeded" });

    const adapter = new SessionOverlayAdapter(base, overlay);
    await adapter.deleteEntry("pages", "home");

    expect(await base.getEntry("pages", "home")).toEqual({
      id: "home",
      data: { title: "Seeded" },
    });
  });
});
