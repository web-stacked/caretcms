/**
 * A tiny line-level diff (LCS) — no dependency. caretize's writes are pure
 * insertions plus a few rewritten frontmatter lines (the `editable()` wraps), so
 * a line diff renders "what changed" faithfully for the `--diff` preview. O(n·m)
 * over line counts, which is fine for source files.
 */

export interface DiffLine {
  /** " " unchanged · "-" removed (original) · "+" added (output). */
  kind: " " | "-" | "+";
  text: string;
}

/** Line-level diff of `before` → `after` via a longest-common-subsequence walk. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const m = a.length;
  const n = b.length;

  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: " ", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "-", text: a[i] });
      i++;
    } else {
      out.push({ kind: "+", text: b[j] });
      j++;
    }
  }
  while (i < m) out.push({ kind: "-", text: a[i++] });
  while (j < n) out.push({ kind: "+", text: b[j++] });
  return out;
}

/**
 * Collapse a full diff into hunks: changed lines plus up to `context` unchanged
 * lines around them; long unchanged runs become a single `…` marker. Returns the
 * rendered hunk body (no file header). Empty string when nothing changed.
 */
export function formatHunks(lines: DiffLine[], context = 2): string {
  // Mark which unchanged lines are within `context` of a change → kept.
  const changed = lines.map((l) => l.kind !== " ");
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!changed[i]) continue;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
      keep[k] = true;
    }
  }

  const rows: string[] = [];
  let gap = false;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      rows.push(`  ${lines[i].kind} ${lines[i].text}`);
      gap = false;
    } else if (!gap) {
      rows.push("  …");
      gap = true;
    }
  }
  // A pure-gap result (no kept lines) means no changes.
  return rows.some((r) => r !== "  …") ? rows.join("\n") + "\n" : "";
}
