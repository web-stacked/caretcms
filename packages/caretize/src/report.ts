/**
 * Machine-readable report (for --report) and the human summary counts. Pure
 * functions over plans + the prepared results so they're easy to test.
 */

import type { FilePlan } from "./plan.js";
import type { PreparedFile } from "./run.js";

export interface CaretizeReport {
  version: 1;
  scope: { collection: string; id: string } | null;
  files: Array<{
    path: string;
    scope: { collection: string; id: string } | null;
    scopeSkip?: string;
    tags: Array<{ binding: string; tag: string; confidence: string; text: string }>;
    skipped: Array<{ tag: string; reason: string }>;
    flags: Array<{ method: string }>;
  }>;
  totals: { tagged: number; skipped: number; flagged: number; filesModified: number };
}

export function buildReport(
  plans: FilePlan[],
  prepared: PreparedFile[] = [],
): CaretizeReport {
  const modified = new Set(prepared.filter((p) => p.tagCount > 0).map((p) => p.relPath));

  let tagged = 0;
  let skipped = 0;
  let flagged = 0;

  const files = plans.map((plan) => {
    tagged += plan.tags.length;
    skipped += plan.skipped.length;
    flagged += plan.flags.length;
    return {
      path: plan.relPath,
      scope: plan.scope ?? null,
      ...(plan.scopeSkip ? { scopeSkip: plan.scopeSkip } : {}),
      tags: plan.tags.map((t) => ({
        binding: t.binding,
        tag: t.candidate.tag,
        confidence: t.confidence,
        text: t.candidate.text,
      })),
      skipped: plan.skipped.map((s) => ({ tag: s.tag, reason: s.reason })),
      flags: plan.flags.map((f) => ({ method: f.method })),
    };
  });

  return {
    version: 1,
    scope: plans.find((p) => p.scope)?.scope ?? null,
    files,
    totals: { tagged, skipped, flagged, filesModified: modified.size },
  };
}
