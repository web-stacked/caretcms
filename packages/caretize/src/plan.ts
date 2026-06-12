/**
 * Planning: turn a `.astro` source + its path into a reviewable plan — the list
 * of concrete `data-caret` bindings to propose, plus what was skipped and
 * flagged. This is the integration point the CLI and the test harness drive.
 *
 * v1 emits self-contained full-triple bindings (`data-caret="collection::id::
 * field"`) rather than scope-on-wrapper + field-only, because a full triple
 * never depends on locating a common ancestor to host the scope — it is always
 * valid wherever it lands. (Scope-on-wrapper is a later readability pass.)
 */

import { parseAstro, walkTags, type AstroNode, type TagNode } from "./parse.js";
import {
  detect,
  type Candidate,
  type Confidence,
  type IteratorFlag,
  type Skipped,
} from "./detect.js";
import { assignFields, deriveScope, type Scope, type ScopeReason } from "./name.js";
import { frontmatterRange, imageComponentNames } from "./frontmatter.js";

export interface PlannedTag {
  candidate: Candidate;
  collection: string;
  id: string;
  field: string;
  /** Full binding value, `collection::id::field`. */
  binding: string;
  /** Attribute text without leading space, e.g. `data-caret="a::b::c"`. */
  attribute: string;
  startOffset: number;
  confidence: Confidence;
}

export interface FilePlan {
  relPath: string;
  scope?: Scope;
  /** Set when the whole file is skipped (dynamic route / unsupported location). */
  scopeSkip?: ScopeReason;
  tags: PlannedTag[];
  skipped: Skipped[];
  flags: IteratorFlag[];
}

export interface PlanOptions {
  /** Minimum confidence to include as a proposed tag (default "high"). */
  minConfidence?: Confidence;
  /** Skip image candidates entirely (--no-images). */
  noImages?: boolean;
  /** Override the derived scope, e.g. { collection: "pages", id: "about" }. */
  scope?: Scope;
  /** Promote sanitizer-safe mixed-content blocks to data-caret-rich (--rich). */
  rich?: boolean;
}

const RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

/** Field name carried by an existing data-caret value (full-triple or field-only). */
function fieldOf(value: string): string {
  const parts = value.split("::");
  return parts.length === 3 ? parts[2] : parts[0];
}

/** Collect field names already bound in the file, to seed unique naming. */
function existingFields(root: AstroNode): string[] {
  const fields: string[] = [];
  walkTags(root, (node: TagNode) => {
    const v = node.attributes.find((a) => a.name === "data-caret")?.value;
    if (v) fields.push(fieldOf(v));
  });
  return fields;
}

export async function planFile(
  source: string,
  relPath: string,
  options: PlanOptions = {},
  root?: AstroNode,
): Promise<FilePlan> {
  const minRank = RANK[options.minConfidence ?? "high"];
  const ast = root ?? (await parseAstro(source));
  // Resolve astro:assets <Image>/<Picture> local names so detect can recognize
  // them as image candidates (forwarded data-caret → rendered <img> src).
  const fm = frontmatterRange(source);
  const imageComponents = imageComponentNames(fm ? source.slice(fm.start, fm.end) : "");
  const { candidates, skipped, flags } = detect(ast, walkTags, {
    rich: options.rich,
    imageComponents,
  });

  // Resolve scope (explicit override wins; otherwise derive from path).
  let scope: Scope;
  if (options.scope) {
    scope = options.scope;
  } else {
    const derived = deriveScope(relPath);
    if ("skip" in derived) {
      return { relPath, scopeSkip: derived.skip, tags: [], skipped, flags };
    }
    scope = derived.scope;
  }

  // Filter candidates by confidence + image policy, preserving document order.
  // Rich candidates only exist when --rich was requested, so they're always
  // accepted (the confidence floor doesn't gate the explicit opt-in).
  const accepted = candidates.filter((c) => {
    if (options.noImages && c.kind === "image") return false;
    if (c.rich) return true;
    return RANK[c.confidence] >= minRank;
  });

  const fields = assignFields(accepted, existingFields(ast));

  const tags: PlannedTag[] = accepted.map((candidate) => {
    const field = fields.get(candidate)!;
    const binding = `${scope.collection}::${scope.id}::${field}`;
    const attribute = candidate.rich
      ? `data-caret="${binding}" data-caret-rich`
      : `data-caret="${binding}"`;
    return {
      candidate,
      collection: scope.collection,
      id: scope.id,
      field,
      binding,
      attribute,
      startOffset: candidate.startOffset,
      confidence: candidate.confidence,
    };
  });

  return { relPath, scope, tags, skipped, flags };
}
