import { bench, describe } from "vitest";
import { rewriteCaretAttributes } from "../../packages/core/src/runtime/rewrite";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { adapterWithOverrides, editablePage, plainPage } from "./fixtures";

/**
 * Per-request overhead of the rewrite engine — the only CaretCMS code on the
 * hot path of every HTML response (the `order: 'pre'` middleware calls
 * `rewriteCaretAttributes` on the rendered body). `npm run bench`.
 *
 * Scenarios, worst-to-typical:
 *   - plain page, no data-caret  → the cost added to a NON-editable page (scan + bail)
 *   - realistic editable page    → ~12 bindings, every field overridden
 *   - large editable page        → 150 bindings, half overridden (stress)
 */

const emptyAdapter = new InMemoryAdapter();
const realisticPage = editablePage(12);
const realisticAdapter = adapterWithOverrides(12, 1);
const largePage = editablePage(150);
const largeAdapter = adapterWithOverrides(150, 0.5);

describe("rewriteCaretAttributes", () => {
  bench("plain page, no bindings (cost on a non-editable page)", async () => {
    await rewriteCaretAttributes(plainPage, emptyAdapter);
  });

  bench("realistic editable page (~12 bindings, all overridden)", async () => {
    await rewriteCaretAttributes(realisticPage, realisticAdapter);
  });

  bench("large editable page (150 bindings, half overridden)", async () => {
    await rewriteCaretAttributes(largePage, largeAdapter);
  });
});
