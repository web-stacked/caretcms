import { describe, expect, it } from "vitest";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { stripBodyOverlay } from "../../packages/core/src/runtime/utils";
import { resolveBinding } from "../../packages/core/src/runtime/rewrite";
import { BODY_OVERLAY_KEY } from "../../packages/core/src/markdown/contracts";

/**
 * R5 regression: the reserved `__body` draft map must never surface through
 * any public read path — not entry APIs, not loaders, not schema inference,
 * not a crafted rewrite binding. These tests pin every boundary that Phase 3
 * strips; a new read path that forgets to strip should be added here.
 */

const DRAFTED = {
  title: "Hello",
  [BODY_OVERLAY_KEY]: {
    "1": { md: "secret draft", html: "<p>secret draft</p>", src: { start: 0, end: 5, hash: "00000000" }, ts: 1 },
  },
};

function seededAdapter(): InMemoryAdapter {
  const adapter = new InMemoryAdapter();
  return adapter;
}

describe("__body invisibility", () => {
  it("stripBodyOverlay removes exactly the reserved key (and copies)", () => {
    const stripped = stripBodyOverlay(DRAFTED);
    expect(stripped).toEqual({ title: "Hello" });
    expect(DRAFTED[BODY_OVERLAY_KEY]).toBeDefined(); // original untouched
    // No-op fast path: data without the key is returned as-is.
    const plain = { a: 1 };
    expect(stripBodyOverlay(plain)).toBe(plain);
  });

  it("loadEntry / loadCollection strip __body", async () => {
    const adapter = seededAdapter();
    await adapter.writeEntry("blog", "hello", DRAFTED);

    const { runWithRequestContext } = await import(
      "../../packages/core/src/runtime/request-context"
    );
    const { loadEntry, loadCollection } = await import(
      "../../packages/core/src/runtime/content"
    );

    await runWithRequestContext(
      { adapter, overlayActive: false } as never,
      async () => {
        const single = await loadEntry("blog", "hello");
        expect(single).toEqual({ title: "Hello" });
        const list = await loadCollection("blog");
        expect(list).toHaveLength(1);
        expect(list[0].data).toEqual({ title: "Hello" });
      },
    );
  });

  it("caretLoader strips __body for editor and visitor requests alike", async () => {
    const adapter = seededAdapter();
    await adapter.writeEntry("blog", "hello", DRAFTED);

    const { runWithRequestContext } = await import(
      "../../packages/core/src/runtime/request-context"
    );
    const { caretLoader } = await import("../../packages/core/src/loader");
    const loader = caretLoader("blog");

    await runWithRequestContext({ adapter, overlayActive: false } as never, async () => {
      const single = (await loader.loadEntry({ filter: { id: "hello" } })) as {
        data: Record<string, unknown>;
      };
      expect(Object.keys(single.data)).toEqual(["title"]);
      const all = (await loader.loadCollection({ filter: undefined as never })) as {
        entries: Array<{ data: Record<string, unknown> }>;
      };
      expect(Object.keys(all.entries[0].data)).toEqual(["title"]);
    });

    // Editor (overlay-active) requests get stega-encoded data — still no __body.
    await runWithRequestContext({ adapter, overlayActive: true } as never, async () => {
      const single = (await loader.loadEntry({ filter: { id: "hello" } })) as {
        data: Record<string, unknown>;
      };
      expect(Object.keys(single.data)).toEqual(["title"]);
    });
  });

  it("rewrite bindings targeting __body resolve to null", () => {
    expect(resolveBinding(`blog::hello::${BODY_OVERLAY_KEY}`, null)).toBeNull();
    expect(resolveBinding(`blog::hello::${BODY_OVERLAY_KEY}.1.md`, null)).toBeNull();
    expect(
      resolveBinding(`${BODY_OVERLAY_KEY}.1.md`, { collection: "blog", id: "hello" }),
    ).toBeNull();
    // Ordinary fields still resolve.
    expect(resolveBinding("blog::hello::title", null)).toEqual({
      collection: "blog",
      id: "hello",
      field: "title",
    });
  });
});

