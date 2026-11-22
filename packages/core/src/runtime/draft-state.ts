/** Private overlay state. Never accepted from mutation payloads or exposed as content. */
export const DRAFT_STATE_KEY = "__caret_draft__";
export const PUBLISH_RECOVERY_KEY = "__caret_publish__";
/** Published with the entry: a hash of the template text each saved value replaced (see template-text.ts). */
export const TEMPLATE_TEXT_KEY = "__caret_template__";
export const PRIVATE_ENTRY_KEYS = ["__body", "__caret_tombstone__", DRAFT_STATE_KEY, PUBLISH_RECOVERY_KEY, TEMPLATE_TEXT_KEY] as const;

export interface DraftState {
  version: 1;
  baseRevision: number;
  baseData: Record<string, unknown> | null;
  /** Structured saves replace the entry; body-only saves leave frontmatter alone. */
  structured: boolean;
}

export function contentWithoutState(data: Record<string, unknown>): Record<string, unknown> {
  const { [DRAFT_STATE_KEY]: _draft, [PUBLISH_RECOVERY_KEY]: _publish, ...content } = data;
  return content;
}

export function readDraftState(data: Record<string, unknown>): DraftState | null {
  const state = data[DRAFT_STATE_KEY] as DraftState | undefined;
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.baseRevision) || state.baseRevision < 0 ||
      typeof state.structured !== "boolean" ||
      (state.baseData !== null && (typeof state.baseData !== "object" || Array.isArray(state.baseData)))) return null;
  return state;
}

/** Same test as publish: the published entry moved since this draft was started. */
export function isStaleDraft(state: DraftState, base: Record<string, unknown> | null): boolean {
  return !sameContent(withoutTemplateRecord(state.baseData), withoutTemplateRecord(base));
}

function withoutTemplateRecord(data: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!data || !Object.hasOwn(data, TEMPLATE_TEXT_KEY)) return data;
  const { [TEMPLATE_TEXT_KEY]: _record, ...content } = data;
  return content;
}

export interface DraftRebase {
  /** The draft as it applies to the current published entry. */
  data: Record<string, unknown>;
  /** Top-level fields changed both in the draft and in the published entry, to different values. */
  conflicts: string[];
  /** The published entry was deleted after the draft was started. */
  removed: boolean;
}

/**
 * Carry a structured draft over to the current published entry. The draft
 * stores the entry it started from, so the editor's own change is the
 * difference between that and the draft, field by field. Fields the editor
 * didn't change follow the published entry; fields only the editor changed
 * keep the draft's value. A field changed on both sides to different values
 * is a conflict: the draft's value is kept and the field is reported.
 * `content` must not carry draft state; other private keys (`__body`) pass through.
 */
export function rebaseDraft(
  state: DraftState, content: Record<string, unknown>, base: Record<string, unknown> | null,
): DraftRebase {
  if (!isStaleDraft(state, base)) return { data: content, conflicts: [], removed: false };
  const removed = base === null && state.baseData !== null;
  const started = state.baseData ?? {};
  const current = base ?? {};
  const data: Record<string, unknown> = {};
  const conflicts: string[] = [];
  const keys = new Set([...Object.keys(current), ...Object.keys(content), ...Object.keys(started)]);
  for (const key of keys) {
    // The template-text record belongs to the published entry, never to a draft.
    if (key === TEMPLATE_TEXT_KEY) continue;
    const mine = Object.hasOwn(content, key), was = Object.hasOwn(started, key), now = Object.hasOwn(current, key);
    const edited = mine !== was || (mine && !sameContent(content[key], started[key]));
    if (!edited) {
      if (now) data[key] = current[key];
      continue;
    }
    const moved = now !== was || (now && !sameContent(current[key], started[key]));
    const agree = mine === now && (!mine || sameContent(content[key], current[key]));
    if (moved && !agree) conflicts.push(key);
    if (mine) data[key] = content[key];
  }
  // The entry was deleted underneath the draft: nothing to carry it over to.
  if (removed) return { data: content, conflicts: conflicts.sort(), removed };
  return { data, conflicts: conflicts.sort(), removed };
}

/** One field that differs between a draft, the entry it started from and the published entry now. */
export interface DraftFieldChange {
  field: string;
  /** `mine`: only the editor changed it. `site`: only the published entry changed. `both`: each changed it to a different value. */
  kind: "mine" | "site" | "both";
  /** The value when the draft was started, the editor's value and the published value now; `undefined` where the field is absent. */
  started: unknown;
  mine: unknown;
  site: unknown;
}

/**
 * What a structured draft changes and what changed underneath it, field by
 * field, by the same rules as `rebaseDraft`. A field both sides changed to
 * the same value is no change. Private keys and a deleted entry are left to
 * the conflict report.
 */
export function draftFieldChanges(
  state: DraftState, content: Record<string, unknown>, base: Record<string, unknown> | null,
): DraftFieldChange[] {
  if (base === null && state.baseData !== null) return [];
  const started = state.baseData ?? {};
  const current = base ?? {};
  const privateKeys: readonly string[] = PRIVATE_ENTRY_KEYS;
  const changes: DraftFieldChange[] = [];
  for (const field of new Set([...Object.keys(current), ...Object.keys(content), ...Object.keys(started)])) {
    if (privateKeys.includes(field)) continue;
    const mine = Object.hasOwn(content, field), was = Object.hasOwn(started, field), now = Object.hasOwn(current, field);
    const edited = mine !== was || (mine && !sameContent(content[field], started[field]));
    const moved = now !== was || (now && !sameContent(current[field], started[field]));
    if (!edited && !moved) continue;
    const agree = mine === now && (!mine || sameContent(content[field], current[field]));
    if (edited && moved && agree) continue;
    changes.push({ field, kind: edited && moved ? "both" : edited ? "mine" : "site",
      started: started[field], mine: edited ? content[field] : current[field], site: current[field] });
  }
  return changes.sort((a, b) => a.field.localeCompare(b.field));
}

/**
 * A short fingerprint of entry content: equal content (by `sameContent`) gives
 * an equal fingerprint. Used to tell that an entry is still exactly what a
 * publish wrote, since a developer's direct file edit doesn't bump a revision.
 */
export function contentFingerprint(data: unknown): string {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  };
  const text = stable(data);
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995) ^ (b >>> 15);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

/** Object key ordering is not a content change. Arrays retain their order. */
export function sameContent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length && left.every(key => Object.hasOwn(b, key) &&
    sameContent((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
