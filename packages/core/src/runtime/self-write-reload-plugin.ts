import { notifySelfWriteReload, selfWriteTime } from "./self-writes.js";

export type DevServerLike = {
  watcher: { on(event: string, listener: (file: string) => void): unknown };
  environments?: { client?: { hot: { send: (payload: unknown, ...rest: unknown[]) => unknown } } };
};

/**
 * Dev only: an editor's save writes content files, and Astro answers file
 * changes with a full page reload, which drops the editor's place and any edit
 * still in progress. Reloads caused only by CaretCMS's own writes are skipped;
 * Astro still refreshes its content store, so the next page load shows the
 * change. A developer's own edits reload as usual. A skipped reload also tells
 * anyone waiting (a publish) that Astro now has the new content.
 */
export function createSelfWriteReloadPlugin() {
  return {
    name: "caretcms:self-write-reload",
    apply: "serve" as const,
    configureServer(server: DevServerLike) {
      let selfChanges = 0;
      let otherChanges = 0;
      let lastChange = 0;
      let newestSelfWrite = 0;
      const note = (file: string) => {
        if (/[\\/](?:node_modules|\.astro)[\\/]/.test(file)) return;
        const writtenAt = selfWriteTime(file);
        if (writtenAt !== null) {
          selfChanges += 1;
          newestSelfWrite = Math.max(newestSelfWrite, writtenAt);
        } else otherChanges += 1;
        lastChange = Date.now();
      };
      for (const event of ["add", "change", "unlink"]) server.watcher.on(event, note);

      const hot = server.environments?.client?.hot;
      if (!hot) return;
      const send = hot.send.bind(hot);
      hot.send = (payload: unknown, ...rest: unknown[]) => {
        if ((payload as { type?: unknown } | null)?.type === "full-reload") {
          const onlySelf = selfChanges > 0 && otherChanges === 0 && Date.now() - lastChange < 5_000;
          const writtenAt = newestSelfWrite;
          selfChanges = 0;
          otherChanges = 0;
          newestSelfWrite = 0;
          if (onlySelf) {
            notifySelfWriteReload(writtenAt);
            return;
          }
        }
        return send(payload, ...rest);
      };
    },
  };
}
