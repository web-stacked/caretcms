/**
 * Tier selection policy — the ONE pure function that decides which escalation
 * tiers apply, given the user's intent. Every entry point (individual flags,
 * `--all`, and later the in-flow prompt answer / a config file) converges here,
 * so the readline/CLI code only ever RENDERS what this returns — it never
 * decides *what* to apply. That separation is what lets later UX surfaces
 * (config, IDE, watch) be new Intent sources rather than policy rewrites.
 *
 * No I/O. Returns a Set of tier ids; the caller maps those onto the (deliberately
 * heterogeneous) mechanisms — a bind detector, a plan option, a confidence floor.
 */

import { TIERS, type TierId } from "./tiers.js";

export interface Intent {
  /** `--all`: turn on EVERY tier, including the un-recommended ones (lowconf).
   *  Named honestly — "all" means all. The curated bundle is `recommendedTiers`. */
  all?: boolean;
  /** Per-tier explicit opt-in from the individual flags (and, later, config). */
  flags?: Partial<Record<TierId, boolean>>;
}

/**
 * Resolve an intent to the set of enabled escalation tiers.
 *   - `all`            → every tier (incl. lowconf).
 *   - explicit `flags` → exactly the tiers flagged true.
 *   - nothing          → empty set (today's conservative default).
 */
export function selectTiers(intent: Intent): Set<TierId> {
  if (intent.all) return new Set(TIERS.map((t) => t.id));
  const set = new Set<TierId>();
  for (const t of TIERS) {
    if (intent.flags?.[t.id]) set.add(t.id);
  }
  return set;
}

/** The curated bundle the interactive [Y] applies — recommended tiers only
 *  (collections + routes + rich; lowconf is left to explicit opt-in / --all). */
export function recommendedTiers(): Set<TierId> {
  return new Set(TIERS.filter((t) => t.recommended).map((t) => t.id));
}
