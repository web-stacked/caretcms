import { describe, expect, it, vi } from "vitest";
import { createStudioSync } from "../../packages/core/static/cms/studio/sync-client.js";

function setup(embedded = false) {
  const posted: unknown[] = [];
  const broadcast: unknown[] = [];
  let channelListener: ((event: MessageEvent) => void) | undefined;
  let windowListener: ((event: MessageEvent) => void) | undefined;
  let pagehide: (() => void) | undefined;
  const close = vi.fn();
  const onSelection = vi.fn();
  const sync = createStudioSync({
    collection: "pages", id: "home", previewPath: "/", origin: "https://site.test",
    isEmbedded: embedded, studioPath: () => "/admin/cms/pages/home",
    postToParent: message => posted.push(message), onSelection,
    addWindowMessageListener: listener => { windowListener = listener; },
    addPagehideListener: listener => { pagehide = listener; },
    openChannel: () => ({
      postMessage: message => broadcast.push(message),
      addEventListener: (_type, listener) => { channelListener = listener; }, close,
    }),
    schedule: callback => { callback(); return 1; }, cancel: vi.fn(), now: () => 123,
  });
  return { sync, posted, broadcast, onSelection, close,
    channelMessage: (data: unknown) => channelListener?.({ data } as MessageEvent),
    windowMessage: (origin: string, data: unknown) => windowListener?.({ origin, data } as MessageEvent),
    pagehide: () => pagehide?.(),
  };
}

describe("Studio sync client", () => {
  it("posts debounced preview data only from embedded Studio", () => {
    const embedded = setup(true);
    embedded.sync.queuePreview({ hero: { title: "Draft" } });
    expect(embedded.posted).toEqual([expect.objectContaining({
      type: "cms:preview", collection: "pages", id: "home",
      data: { hero: { title: "Draft" } }, embedded: true,
    })]);
    const standalone = setup(false);
    standalone.sync.queuePreview({ title: "Ignored" });
    expect(standalone.posted).toEqual([]);
  });

  it("announces saved changes to embedded parent and cross-tab channel", () => {
    const state = setup(true);
    state.sync.announceChange("cms:saved", { title: "Saved" });
    const expected = expect.objectContaining({ type: "cms:saved", savedAt: 123, embedded: true });
    expect(state.posted).toEqual([expected]);
    expect(state.broadcast).toEqual([expected]);
  });

  it("routes field selection to the parent or channel by context", () => {
    const embedded = setup(true);
    embedded.sync.announceFieldSelection("hero.title");
    expect(embedded.posted).toEqual([expect.objectContaining({ field: "hero.title", embedded: true })]);
    expect(embedded.broadcast).toEqual([]);
    const standalone = setup(false);
    standalone.sync.announceFieldSelection("hero.title");
    expect(standalone.broadcast).toEqual([expect.objectContaining({ field: "hero.title", source: "studio" })]);
  });

  it("accepts same-origin window and channel selections", () => {
    const state = setup();
    const selection = { type: "cms:field-selected", field: "hero.title" };
    state.windowMessage("https://other.test", selection);
    state.windowMessage("https://site.test", selection);
    state.channelMessage(selection);
    expect(state.onSelection).toHaveBeenCalledTimes(2);
  });

  it("announces readiness only when embedded and closes its channel", () => {
    const state = setup(true);
    state.sync.announceReady();
    expect(state.posted).toEqual([{ type: "cms:entry-ready", collection: "pages", id: "home", embedded: true }]);
    state.pagehide();
    expect(state.close).toHaveBeenCalledOnce();
  });
});
