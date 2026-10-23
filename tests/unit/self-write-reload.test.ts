import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createSelfWriteReloadPlugin } from "../../packages/core/src/runtime/self-write-reload-plugin.js";
import { recordSelfWrite } from "../../packages/core/src/runtime/self-writes.js";

function devServer() {
  const watcher = new EventEmitter();
  const sent = vi.fn();
  const server = { watcher, environments: { client: { hot: { send: sent } } } };
  createSelfWriteReloadPlugin().configureServer(server);
  return { watcher, send: (payload: unknown) => server.environments.client.hot.send(payload), sent };
}

describe("dev reloads after CaretCMS writes", () => {
  it("skips a reload caused only by an editor's save", () => {
    const { watcher, send, sent } = devServer();
    recordSelfWrite("/site/src/content/blog/post.md");
    watcher.emit("change", "/site/src/content/blog/post.md");
    send({ type: "full-reload", path: "*" });
    expect(sent).not.toHaveBeenCalled();
  });

  it("keeps a reload caused by a developer's edit", () => {
    const { watcher, send, sent } = devServer();
    watcher.emit("change", "/site/src/components/Hero.astro");
    send({ type: "full-reload", path: "*" });
    expect(sent).toHaveBeenCalledOnce();
  });

  it("keeps the reload when a developer edit lands alongside a save", () => {
    const { watcher, send, sent } = devServer();
    recordSelfWrite("/site/src/content/pages/home.md");
    watcher.emit("change", "/site/src/content/pages/home.md");
    watcher.emit("change", "/site/src/layouts/Base.astro");
    send({ type: "full-reload", path: "*" });
    expect(sent).toHaveBeenCalledOnce();
  });

  it("ignores Astro's own generated files and passes other messages through", () => {
    const { watcher, send, sent } = devServer();
    recordSelfWrite("/site/src/content/team/a.md");
    watcher.emit("change", "/site/src/content/team/a.md");
    watcher.emit("change", "/site/.astro/data-store.json");
    send({ type: "update", updates: [] });
    send({ type: "full-reload", path: "*" });
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledWith({ type: "update", updates: [] });
  });
});
