import { TEMPLATE_TEXT_KEY, sameContent } from "./draft-state.js";
import { fnv1a32 } from "../markdown/contracts.js";
import { getNestedValue } from "./utils.js";

/**
 * Text written in a template and a value saved for the same binding are two
 * sources for one piece of content. A saved value normally replaces the
 * template's text. When a developer changes the template's text afterwards,
 * that newer text must show: otherwise their change seems to do nothing.
 *
 * To tell which is newer, an entry records a hash of the template text each
 * saved value replaced, under `TEMPLATE_TEXT_KEY`, keyed by field path. The
 * record lives in the entry itself so it is committed with the value and
 * reaches a build on another machine.
 */

/**
 * What an entry records for a piece of template text. The leading letter keeps
 * the value a string in YAML and JSON however a tool rewrites the file (a bare
 * hash such as `38925866` or `12e45678` would be read back as a number).
 */
export function templateHash(text: string): string {
  return `t${fnv1a32(text)}`;
}

/** field path → the template's text (or image src) for that binding. */
export type TemplateText = Record<string, string>;

function recorded(data: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const map = data?.[TEMPLATE_TEXT_KEY];
  return map && typeof map === "object" && !Array.isArray(map) ? map as Record<string, unknown> : {};
}

/**
 * Whether the template's text for a field is newer than the entry's saved
 * value: the value was saved against different template text. A value with no
 * record (saved before records existed) keeps replacing the template.
 */
export function templateWins(data: Record<string, unknown> | null | undefined, field: string, text: string | undefined): boolean {
  if (text === undefined) return false;
  const hash = recorded(data)[field];
  return typeof hash === "string" && hash !== templateHash(text);
}

function unset(data: Record<string, unknown>, path: string): void {
  const keys = path.split(".");
  const parents: Array<[Record<string, unknown>, string]> = [];
  let current: unknown = data;
  for (const key of keys) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, key)) return;
    parents.push([current as Record<string, unknown>, key]);
    current = (current as Record<string, unknown>)[key];
  }
  // Remove the value, then any object it leaves empty.
  for (let index = parents.length - 1; index >= 0; index--) {
    const [parent, key] = parents[index];
    delete parent[key];
    if (index > 0 && Object.keys(parent).length > 0) break;
  }
}

/**
 * The entry to store when `next` replaces `previous`, with its template-text
 * record brought up to date. A value saved now is recorded against the
 * template as it is now. A value left alone keeps its record; if the template
 * has changed since, the template already shows in its place, so the stale
 * value is removed and reported in `dropped`.
 */
export function trackTemplateText(
  previous: Record<string, unknown> | null, next: Record<string, unknown>, template: TemplateText | undefined,
): { data: Record<string, unknown>; dropped: string[] } {
  const { [TEMPLATE_TEXT_KEY]: _old, ...content } = next;
  if (!template) return { data: content, dropped: [] };
  const data = structuredClone(content);
  const before = recorded(previous);
  const record: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [field, text] of Object.entries(template)) {
    const value = getNestedValue(data, field);
    if (value === undefined) continue;
    const hash = templateHash(text);
    const untouched = previous !== null && sameContent(value, getNestedValue(previous, field));
    if (!untouched || typeof before[field] !== "string" || before[field] === hash) record[field] = hash;
    else { unset(data, field); dropped.push(field); }
  }
  return { data: Object.keys(record).length ? { ...data, [TEMPLATE_TEXT_KEY]: record } : data, dropped };
}

/**
 * The record an editor's draft view carries: the published entry's, minus the
 * fields the editor changed in the draft. Their newer value shows over the
 * template until it is published and recorded.
 */
export function draftTemplateRecord(
  view: Record<string, unknown>, published: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  const entries = Object.entries(recorded(published))
    .filter(([field]) => sameContent(getNestedValue(view, field), getNestedValue(published, field)));
  return entries.length ? Object.fromEntries(entries) : undefined;
}
