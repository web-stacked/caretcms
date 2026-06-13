/**
 * Escalation-tier descriptors — the single source of truth for the opinionated
 * tiers that are OFF by default and unlocked by a flag (or, later, the in-flow
 * prompt). Pure data, no I/O. The default/"safe" tiers (the data-caret tag pass
 * and the editable() wrap tiers) are always applied and are NOT listed here —
 * this table governs only what the user must opt into.
 *
 * Consumers:
 *   - select-policy.ts (`selectTiers`) maps an Intent → the set of enabled ids.
 *   - cli.ts renders the unlock copy and derives the per-tier booleans.
 *   - output.ts uses `label`/`note` for the "what's left" summary.
 *
 * Kept deliberately minimal (a static table + one pure selector). This is NOT a
 * plugin registry — see PRD-caretize-coverage.md "defer the registry to ~10
 * tiers". Adding a UX surface (config/IDE/watch) means a new Intent source, not
 * an edit here.
 */

export type TierId = "collections" | "routes" | "rich" | "lowconf";

/**
 * How much the tier "decides" on the user's behalf:
 *   - "judgment" — an intent call (is this markup actually editable content?).
 *   - "guess"    — an invasive per-row transform that assumes an identity
 *                  (`entry.id`) + a correct receiver→collection mapping.
 */
export type RiskClass = "judgment" | "guess";

export interface TierDescriptor {
  id: TierId;
  /** Prompt/summary copy, e.g. "Dynamic lists". */
  label: string;
  /** Short qualifier shown alongside the label, e.g. "per-row · assumes .id". */
  note: string;
  risk: RiskClass;
  /** In the interactive [Y] bundle (the curated "standard" escalation). The
   *  explicit `--all` flag ignores this and turns on every tier. */
  recommended: boolean;
  /** The existing individual flag, for back-compat + help text. */
  flag: string;
}

export const TIERS: readonly TierDescriptor[] = [
  {
    id: "collections",
    label: "items in dynamic lists",
    note: "per-row · assumes entry .id",
    risk: "guess",
    recommended: true,
    flag: "--bind-collections",
  },
  {
    id: "routes",
    label: "dynamic detail routes",
    note: "per-row · assumes entry .id",
    risk: "guess",
    recommended: true,
    flag: "--bind-routes",
  },
  {
    id: "rich",
    label: "rich headings",
    note: "bold & links inside",
    risk: "judgment",
    recommended: true,
    flag: "--rich",
  },
  {
    id: "lowconf",
    label: "lower-confidence spots",
    note: "list items, links, inline — sometimes noise",
    risk: "judgment",
    recommended: false,
    flag: "--min-confidence low",
  },
];

/** Look up a descriptor by id (table is tiny; linear scan is fine). */
export function tierById(id: TierId): TierDescriptor {
  const t = TIERS.find((d) => d.id === id);
  if (!t) throw new Error(`unknown tier id: ${id}`);
  return t;
}
