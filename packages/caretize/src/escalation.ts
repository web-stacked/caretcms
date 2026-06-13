/**
 * Pure helpers for the in-flow escalation step (the interactive "I can also make
 * these editable" prompt). Kept out of cli.ts — which self-executes on import —
 * so the decision/merge logic is unit-testable. cli.ts owns only the readline
 * I/O and the (cheap, side-effect-free) re-analysis; everything it decides flows
 * through these functions and `selectTiers`.
 */

import type { FilePlan, PlannedTag } from "./plan.js";
import type { CollectionBindTarget } from "./bind-collection.js";
import type { TierId } from "./tiers.js";

export type EscalationCounts = Record<TierId, number>;

/**
 * Tally the remaining opt-in coverage per tier, from the CONSERVATIVE analysis
 * plus the collection/route bind targets detected for the offer:
 *   - rich    = elements skipped as "rich-eligible" (would tag with --rich)
 *   - lowconf = candidates dropped by the confidence floor (`belowConfidence`)
 *   - collections / routes = the bind targets, split by kind
 */
export function escalationCounts(
  conservativePlans: FilePlan[],
  offerBinds: Map<string, CollectionBindTarget[]>,
): EscalationCounts {
  let rich = 0;
  let lowconf = 0;
  let collections = 0;
  let routes = 0;
  for (const p of conservativePlans) {
    lowconf += p.belowConfidence;
    for (const s of p.skipped) if (s.reason === "rich-eligible") rich++;
  }
  for (const binds of offerBinds.values()) {
    for (const b of binds) {
      if (b.kind === "route") routes++;
      else collections++;
    }
  }
  return { collections, routes, rich, lowconf };
}

/** Total across all tiers — 0 means there's nothing to offer. */
export function totalOffer(counts: EscalationCounts): number {
  return counts.collections + counts.routes + counts.rich + counts.lowconf;
}

/**
 * The escalation-only tags: tags in the FINAL (chosen-tier) analysis at offsets
 * the CONSERVATIVE analysis did not already produce — i.e. the rich promotions
 * and below-floor tags the chosen tiers unlocked. The default-tier tags (same
 * offsets in both passes) are excluded; the user already reviewed those.
 * Returned per relPath, ready to merge into the reviewed selection.
 */
export function deltaTags(
  conservativePlans: FilePlan[],
  finalPlans: FilePlan[],
): Map<string, PlannedTag[]> {
  const seenByPath = new Map<string, Set<number>>(
    conservativePlans.map((p) => [p.relPath, new Set(p.tags.map((t) => t.startOffset))]),
  );
  const out = new Map<string, PlannedTag[]>();
  for (const p of finalPlans) {
    const seen = seenByPath.get(p.relPath) ?? new Set<number>();
    const delta = p.tags.filter((t) => !seen.has(t.startOffset));
    if (delta.length) out.set(p.relPath, delta);
  }
  return out;
}

/** Append `delta` tag lists onto a copy of `base`, per relPath. */
export function mergeTagMaps(
  base: Map<string, PlannedTag[]>,
  delta: Map<string, PlannedTag[]>,
): Map<string, PlannedTag[]> {
  const out = new Map(base);
  for (const [rel, tags] of delta) {
    out.set(rel, [...(out.get(rel) ?? []), ...tags]);
  }
  return out;
}

export type RawAnswer = "yes" | "no" | "customize" | "unknown";

/** Classify the top-level escalation answer. Empty = the [Y] default. */
export function parseAnswer(raw: string): RawAnswer {
  const a = raw.trim().toLowerCase();
  if (a === "" || a === "y" || a === "yes") return "yes";
  if (a === "n" || a === "no") return "no";
  if (a === "c" || a === "customize") return "customize";
  return "unknown";
}

/** Classify a per-tier customize answer. Empty = keep the tier's recommendation. */
export function parseToggle(raw: string, recommended: boolean): boolean {
  const a = raw.trim().toLowerCase();
  if (a === "") return recommended;
  return a === "y" || a === "yes";
}
