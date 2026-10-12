import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, platform, arch } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { InMemoryAdapter } from "../packages/core/dist/runtime/storage/in-memory-adapter.js";
import { FilesystemAdapter } from "../packages/core/dist/runtime/storage/filesystem-adapter.js";
import { readEntrySnapshots } from "../packages/core/dist/runtime/storage/read-snapshot.js";

// Local reference-adapter baseline, not a simulation of remote storage latency.
const samples = Number(process.argv[2] ?? 3);
if (!Number.isInteger(samples) || samples < 1 || samples > 20) throw new Error("Pass a sample count from 1 to 20");
const report = { node: process.version, platform: platform(), arch: arch(), samples, results: [] };
for (const size of [1000, 10000]) {
  const root = await mkdtemp(join(tmpdir(), "caret-read-bench-"));
  try {
    const collection = "benchmark";
    const entries = Array.from({ length: size }, (_, index) => ({ id: `entry-${String(index).padStart(5, "0")}`,
      data: { title: `${index % 10 === 0 ? "Target" : "Other"} entry ${index}`, summary: "A representative content summary.", order: index, nested: { tags: ["one", "two"] } } }));
    const memory = new InMemoryAdapter();
    memory.preload(collection, entries);
    for (const { id } of entries) await memory.bumpRevision(collection, id);
    const filesystem = new FilesystemAdapter({ dataRoot: join(root, "data"), metaRoot: join(root, "meta") });
    await mkdir(join(root, "data", collection), { recursive: true });
    await mkdir(join(root, "meta"), { recursive: true });
    // Seed outside measured operations; repeated revision-map rewrites would
    // measure fixture setup rather than reads over an existing collection.
    for (let offset = 0; offset < size; offset += 64) await Promise.all(entries.slice(offset, offset + 64).map(({ id, data }) =>
      writeFile(join(root, "data", collection, `${id}.json`), JSON.stringify(data))));
    await writeFile(join(root, "meta/revisions.json"), JSON.stringify(Object.fromEntries(entries.map(({ id }) => [`${collection}::${id}`, 1]))));
    for (const [provider, adapter] of [["memory", memory], ["filesystem", filesystem]]) {
      const operations = {
        "list IDs": () => adapter.listEntryIds(collection),
        "first page with revisions": async () => {
          const ids = await adapter.listEntryIds(collection);
          return readEntrySnapshots(adapter, collection, ids.slice(0, 25));
        },
        "read all content": () => adapter.listEntries(collection),
        "search with revisions (20 at a time)": async () => {
          const ids = await adapter.listEntryIds(collection), matches = [];
          for (let offset = 0; offset < ids.length; offset += 20) {
            const batch = await readEntrySnapshots(adapter, collection, ids.slice(offset, offset + 20));
            for (const snapshot of batch) if (String(snapshot.entry?.data.title).toLowerCase().includes("target")) matches.push(snapshot);
          }
          return matches.slice(0, 25);
        },
      };
      for (const [operation, task] of Object.entries(operations)) {
        // Full search is deliberately one observation: expensive scans should
        // remain practical to profile. Report that count, never imply precision.
        const count = operation.startsWith("search") ? 1 : samples;
        console.error(`${provider}, ${size} entries: ${operation} (${count} sample${count === 1 ? "" : "s"})`);
        const durations = [];
        for (let sample = 0; sample < count; sample++) {
          const start = performance.now(); await task(); durations.push(performance.now() - start);
        }
        durations.sort((a, b) => a - b);
        const round = value => Math.round(value * 100) / 100;
        report.results.push({ provider, entries: size, operation, samples: count,
          medianMs: round(durations[Math.floor(count / 2)]), minMs: round(durations[0]), maxMs: round(durations.at(-1)) });
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}
console.log(JSON.stringify(report, null, 2));
