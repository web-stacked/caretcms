import { describe, expect, it } from "vitest";
import { rewriteCaretAttributes } from "../../packages/core/src/runtime/rewrite";
import { adapterWithOverrides, editablePage } from "../bench/fixtures";

/**
 * Catastrophic-regression tripwire for the per-request rewrite path — NOT a
 * microbenchmark (see `npm run bench` for real numbers). A large editable page
 * rewrites in ~1ms on dev hardware; the 50ms ceiling is huge headroom that only
 * a super-linear regression (e.g. O(n²) scope scanning) would breach, so it
 * won't flake on slow/shared CI runners.
 */
describe("rewrite engine performance", () => {
  it("rewrites a large editable page well within budget", async () => {
    const html = editablePage(150);
    const adapter = adapterWithOverrides(150, 0.5);

    await rewriteCaretAttributes(html, adapter); // warm up JIT

    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await rewriteCaretAttributes(html, adapter);
      times.push(performance.now() - start);
    }
    const median = times.sort((a, b) => a - b)[Math.floor(times.length / 2)];

    expect(median).toBeLessThan(50);
  });
});
