import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";

/**
 * Shared fixtures for the rewrite-engine benchmark (rewrite.bench.ts) and the
 * catastrophic-regression tripwire (tests/unit/rewrite-perf.test.ts).
 */

const LOREM = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ";

function editableBlock(i: number): string {
  return `<section data-caret-scope="pages::home">
    <h2 data-caret="title_${i}">Default heading ${i}</h2>
    <p data-caret="body_${i}">Default body ${i}. ${LOREM.repeat(4)}</p>
    <img data-caret="image_${i}" src="/default-${i}.png" alt="">
  </section>`;
}

function page(inner: string): string {
  return `<!doctype html><html><head><title>Bench</title></head><body><main>${inner}</main></body></html>`;
}

export function editablePage(bindings: number): string {
  return page(Array.from({ length: bindings }, (_, i) => editableBlock(i)).join("\n"));
}

/** A content-heavy page with zero data-caret bindings. */
export const plainPage = page(`<p>${LOREM.repeat(400)}</p>`);

export function adapterWithOverrides(bindings: number, ratio: number): InMemoryAdapter {
  const adapter = new InMemoryAdapter();
  const data: Record<string, unknown> = {};
  for (let i = 0; i < Math.floor(bindings * ratio); i++) {
    data[`title_${i}`] = `Edited heading ${i}`;
    data[`body_${i}`] = `Edited body ${i}`;
    data[`image_${i}`] = `/uploads/edited-${i}.webp`;
  }
  adapter.preload("pages", [{ id: "home", data }]);
  return adapter;
}
