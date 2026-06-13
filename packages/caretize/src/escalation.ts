/**
 * Pure helpers for the in-flow escalation step (the interactive "I can also make
 * these editable" prompt). Kept out of cli.ts — which self-executes on import —
 * so the decision/merge logic is unit-testable. cli.ts owns only the readline
 * I/O and the (cheap, side-effect-free) re-analysis; everything it decides flows
 * through these functions and `selectTiers`.
 */

import type { FilePlan, PlannedTag } from "./plan.js";
import type { CollectionBindTarget } from "./bind-collection.js";
import { TIERS, type TierId } from "./tiers.js";
import { recommendedTiers } from "./select-policy.js";

export type EscalationCounts = Record<TierId, number>;

/**
 * Tally the remaining opt-in coverage per tier, from the CONSERVATIVE analysis
 * plus the collection/route bind targets detected for the offer:
 *   - rich       = elements skipped as "rich-eligible" (would tag with --rich)
 *   - rich-class = elements skipped as "rich-class-promotable" (need --rich-class)
 *   - lowconf    = candidates dropped by the confidence floor (`belowConfidence`)
 *   - collections / routes = the bind targets, split by kind
 */
export function escalationCounts(
  conservativePlans: FilePlan[],
  offerBinds: Map<string, CollectionBindTarget[]>,
): EscalationCounts {
  let rich = 0;
  let richClass = 0;
  let lowconf = 0;
  let collections = 0;
  let routes = 0;
  for (const p of conservativePlans) {
    lowconf += p.belowConfidence;
    for (const s of p.skipped) {
      if (s.reason === "rich-eligible") rich++;
      else if (s.reason === "rich-class-promotable") richClass++;
    }
  }
  for (const binds of offerBinds.values()) {
    for (const b of binds) {
      if (b.kind === "route") routes++;
      else collections++;
    }
  }
  return { collections, routes, rich, "rich-class": richClass, lowconf };
}

/** Total across all tiers — 0 means there's nothing to offer. */
export function totalOffer(counts: EscalationCounts): number {
  return counts.collections + counts.routes + counts.rich + counts["rich-class"] + counts.lowconf;
}

/** Zero out tiers that are already on (Phase A flags / --all) so the offer never
 *  re-counts coverage the conservative pass already applied. Returns a copy. */
export function offerableCounts(
  counts: EscalationCounts,
  active: ReadonlySet<TierId>,
): EscalationCounts {
  const out = { ...counts };
  for (const id of active) out[id] = 0;
  return out;
}

/** Tier ids with a non-zero count, in TIERS order — what the prompt can offer. */
export function offeredTiers(counts: Partial<Record<TierId, number>>): TierId[] {
  return TIERS.filter((t) => (counts[t.id] ?? 0) > 0).map((t) => t.id);
}

/** The set the in-flow [Y] applies: the recommended tiers that are actually on
 *  offer. Falls back to ALL offered tiers when none of the offered ones are
 *  recommended (e.g. only low-confidence is left), so [Y] is never a no-op. */
export function recommendedBundle(counts: Partial<Record<TierId, number>>): TierId[] {
  const offered = offeredTiers(counts);
  const rec = recommendedTiers();
  const recOffered = offered.filter((id) => rec.has(id));
  return recOffered.length > 0 ? recOffered : offered;
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
