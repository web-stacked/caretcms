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

/** A value that may be absent: a field the entry doesn't have is not the same as an empty one. */
type Slot = { has: boolean; value?: unknown };
const ABSENT: Slot = { has: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function slotOf(holder: Record<string, unknown> | null | undefined, key: string): Slot {
  return holder && Object.hasOwn(holder, key) ? { has: true, value: holder[key] } : ABSENT;
}

function sameSlot(a: Slot, b: Slot): boolean {
  return a.has === b.has && (!a.has || sameContent(a.value, b.value));
}

/** One place where a draft, the entry it started from and the published entry differ. */
interface Difference {
  path: string[];
  kind: "mine" | "site" | "both";
  started: Slot;
  mine: Slot;
  site: Slot;
}

/**
 * Compare one value three ways and return what the draft shows for it.
 *
 * Objects are compared key by key, so two people who change different keys of
 * the same object don't collide. An array both sides changed is one value: its
 * items have no identity to match them by, so merging it item by item could
 * put an edit on the wrong item. `found` receives each difference; with
 * `leaves`, a list only one side changed is reported item by item when its
 * length is unchanged, so a single edited item is named.
 */
function compare(path: string[], started: Slot, mine: Slot, site: Slot, found: Difference[], leaves: boolean): Slot {
  const edited = !sameSlot(mine, started);
  const moved = !sameSlot(site, started);
  if (!edited && !moved) return site;
  if (edited && moved && sameSlot(mine, site)) return mine;
  const present = [started, mine, site].filter(slot => slot.has).map(slot => slot.value);
  const kind = edited && moved ? "both" : edited ? "mine" : "site";
  if (present.every(isRecord)) {
    const keys = new Set(present.flatMap(value => Object.keys(value as Record<string, unknown>)));
    // Nothing inside differs, so the object itself does: one side has it, empty, and another doesn't.
    if (keys.size === 0) {
      found.push({ path, kind, started, mine, site });
      return edited ? mine : site;
    }
    const merged: Record<string, unknown> = {};
    for (const key of keys) {
      const child = compare([...path, key],
        started.has ? slotOf(started.value as Record<string, unknown>, key) : ABSENT,
        mine.has ? slotOf(mine.value as Record<string, unknown>, key) : ABSENT,
        site.has ? slotOf(site.value as Record<string, unknown>, key) : ABSENT, found, leaves);
      if (child.has) merged[key] = child.value;
    }
    // An object every key of which is gone on the side that wins is gone too.
    const winner = edited ? mine : site;
    return winner.has ? { has: true, value: merged } : ABSENT;
  }
  const lists = present as unknown[][];
  if (leaves && kind !== "both" && present.every(Array.isArray) && lists.every(list => list.length === lists[0].length)) {
    // An empty place in a list (the items before the one that was saved, when
    // the list wasn't stored yet) holds nothing, like a list that isn't there.
    const at = (slot: Slot, index: number): Slot => {
      const item = slot.has ? (slot.value as unknown[])[index] : undefined;
      return item === undefined || item === null ? ABSENT : { has: true, value: item };
    };
    for (let index = 0; index < lists[0].length; index++) {
      compare([...path, String(index)], at(started, index), at(mine, index), at(site, index), found, leaves);
    }
  } else {
    found.push({ path, kind, started, mine, site });
  }
  // The editor's value stays, also in a conflict, until they decide.
  return edited ? mine : site;
}

/** Every difference between a draft and the published entry, and the entry the draft shows. */
function compareEntries(state: DraftState, content: Record<string, unknown>, base: Record<string, unknown> | null, leaves: boolean) {
  const started = state.baseData ?? {};
  const current = base ?? {};
  const data: Record<string, unknown> = {};
  const found: Difference[] = [];
  const privateKeys: readonly string[] = PRIVATE_ENTRY_KEYS;
  for (const key of new Set([...Object.keys(current), ...Object.keys(content), ...Object.keys(started)])) {
    // The template-text record belongs to the published entry, never to a draft.
    if (key === TEMPLATE_TEXT_KEY) continue;
    // Other private keys (`__body`) are the draft's own and are never merged.
    const whole = privateKeys.includes(key);
    const result = whole
      ? (sameSlot(slotOf(content, key), slotOf(started, key)) ? slotOf(current, key) : slotOf(content, key))
      : compare([key], slotOf(started, key), slotOf(content, key), slotOf(current, key), found, leaves);
    if (result.has) data[key] = result.value;
  }
  return { data, found };
}

/** A field path as the editor's bindings write it: `hero.headline`, `items.0.title`. */
export function fieldPath(path: string[]): string {
  return path.join(".");
}

/** The value at a path, or undefined. */
export function valueAt(data: Record<string, unknown> | null | undefined, path: string[]): unknown {
  let value: unknown = data;
  for (const key of path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function hasAt(data: Record<string, unknown> | null | undefined, path: string[]): boolean {
  let value: unknown = data;
  for (const key of path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return false;
    value = (value as Record<string, unknown>)[key];
  }
  return true;
}

/**
 * A copy of `target` whose value at `path` is the one `source` has there. When
 * `source` has none, the value is removed, along with any object that held
 * only it and that `source` doesn't have either.
 */
export function takeAt(target: Record<string, unknown>, source: Record<string, unknown> | null, path: string[]): Record<string, unknown> {
  const [key, ...rest] = path;
  const copy: Record<string, unknown> | unknown[] = Array.isArray(target) ? [...target] : { ...target };
  const holder = copy as Record<string, unknown>;
  if (rest.length === 0) {
    if (hasAt(source, [key])) holder[key] = (source as Record<string, unknown>)[key];
    else delete holder[key];
    return holder;
  }
  const inner = holder[key];
  const from = hasAt(source, [key]) ? (source as Record<string, unknown>)[key] : null;
  const next = takeAt(inner !== null && typeof inner === "object" ? inner as Record<string, unknown> : {},
    from !== null && typeof from === "object" ? from as Record<string, unknown> : null, rest);
  if (Object.keys(next).length === 0 && !hasAt(source, [key])) delete holder[key];
  else holder[key] = next;
  return holder;
}

/**
 * `target` with the difference between `from` and `to` applied to it: only
 * what changed between the two is written, key by key inside objects, so the
 * rest of `target` stays as it was.
 */
export function applyDifference(target: Record<string, unknown>, from: Record<string, unknown>, to: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    const before = slotOf(from, key), after = slotOf(to, key);
    if (sameSlot(before, after)) continue;
    if (!after.has) delete result[key];
    else if (before.has && isRecord(before.value) && isRecord(after.value) && isRecord(result[key])) {
      result[key] = applyDifference(result[key] as Record<string, unknown>, before.value, after.value);
    } else result[key] = after.value;
  }
  return result;
}

export interface DraftRebase {
  /** The draft as it applies to the current published entry. */
  data: Record<string, unknown>;
  /** Fields changed both in the draft and in the published entry, to different values, as `fieldPath`s. */
  conflicts: string[];
  /** The same fields as key paths, in the same order. */
  conflictPaths: string[][];
  /** The published entry was deleted after the draft was started. */
  removed: boolean;
}

/**
 * Carry a structured draft over to the current published entry. The draft
 * stores the entry it started from, so the editor's own change is the
 * difference between that and the draft, field by field and key by key inside
 * objects. What the editor didn't change follows the published entry; what
 * only the editor changed keeps the draft's value. A value changed on both
 * sides to different values is a conflict: the draft's value is kept and the
 * field is reported.
 * `content` must not carry draft state; other private keys (`__body`) pass through.
 */
export function rebaseDraft(
  state: DraftState, content: Record<string, unknown>, base: Record<string, unknown> | null,
): DraftRebase {
  if (!isStaleDraft(state, base)) return { data: content, conflicts: [], conflictPaths: [], removed: false };
  const removed = base === null && state.baseData !== null;
  const { data, found } = compareEntries(state, content, base, false);
  const conflictPaths = found.filter(difference => difference.kind === "both").map(difference => difference.path)
    .sort((a, b) => fieldPath(a).localeCompare(fieldPath(b)));
  // The entry was deleted underneath the draft: nothing to carry it over to.
  return { data: removed ? content : data, conflicts: conflictPaths.map(fieldPath), conflictPaths, removed };
}

/** One field that differs between a draft, the entry it started from and the published entry now. */
export interface DraftFieldChange {
  /** Where the value is, as the editor's bindings write it: `headline`, `hero.headline`, `items.0.title`. */
  field: string;
  /** The same place as a key path. */
  path: string[];
  /** `mine`: only the editor changed it. `site`: only the published entry changed. `both`: each changed it to a different value. */
  kind: "mine" | "site" | "both";
  /** The value when the draft was started, the editor's value and the published value now; `undefined` where the field is absent. */
  started: unknown;
  mine: unknown;
  site: unknown;
}

/**
 * What a structured draft changes and what changed underneath it, value by
 * value, by the same rules as `rebaseDraft`. A value both sides changed to the
 * same thing is no change. Private keys and a deleted entry are left to the
 * conflict report.
 */
export function draftFieldChanges(
  state: DraftState, content: Record<string, unknown>, base: Record<string, unknown> | null,
): DraftFieldChange[] {
  if (base === null && state.baseData !== null) return [];
  return compareEntries(state, content, base, true).found
    .filter(difference => !(PRIVATE_ENTRY_KEYS as readonly string[]).includes(difference.path[0]))
    .map(({ path, kind, started, mine, site }) => ({ field: fieldPath(path), path, kind,
      started: started.value, mine: kind === "site" ? site.value : mine.value, site: site.value }))
    .sort((a, b) => a.field.localeCompare(b.field));
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
