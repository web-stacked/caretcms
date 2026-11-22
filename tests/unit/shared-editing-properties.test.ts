import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { publishOverlay } from "../../packages/core/src/runtime/publish";
import type { StorageAdapter } from "../../packages/core/src/types";

/**
 * Several people work on one entry: a developer changes the published content
 * directly, and two editors save drafts, publish, undo single fields and settle
 * conflicts, in any order. Whatever the order:
 *
 *  - an editor sees their own value on every field they changed, and the
 *    site's current value everywhere else;
 *  - Publish either reports a conflict and changes nothing, or writes exactly
 *    the editor's own changes on top of the site as it is now;
 *  - a conflict is reported exactly for the fields an editor changed whose
 *    published value is no longer the one their draft last agreed with. That
 *    is deliberately cautious: an editor who changes a field a developer just
 *    changed is asked, because the server can't know which value they saw.
 *
 * Every write uses a value never used before, so "changed" is unambiguous.
 */

const FIELDS = ["title", "hero", "cta", "note"] as const;
type Field = (typeof FIELDS)[number];
type Step =
  | { kind: "developer"; field: Field }
  | { kind: "edit"; editor: 0 | 1; field: Field }
  | { kind: "publish"; editor: 0 | 1 }
  | { kind: "undo"; editor: 0 | 1; field: Field }
  | { kind: "settle"; editor: 0 | 1; keep: "mine" | "site" };

const field = fc.constantFrom(...FIELDS);
const editor = fc.constantFrom<0 | 1>(0, 1);
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("developer" as const), field }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("edit" as const), editor, field }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("publish" as const), editor }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("undo" as const), editor, field }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("settle" as const), editor, keep: fc.constantFrom<"mine" | "site">("mine", "site") }) },
);

interface Person {
  overlay: StorageAdapter;
  draft: SessionOverlayAdapter;
  /** Fields this editor changed and hasn't published, with their value. */
  edited: Map<Field, string>;
  /** The published values the draft last agreed with; null without a draft. */
  agreed: Record<string, string> | null;
}

async function run(steps: Step[]): Promise<void> {
  const base = new InMemoryAdapter();
  const site: Record<string, string> = Object.fromEntries(FIELDS.map(name => [name, `${name}-0`]));
  await base.writeEntry("pages", "home", { ...site });
  const people: Person[] = [];
  for (const name of ["editor-a", "editor-b"]) {
    const overlay = await base.makeEditorOverlay(name);
    people.push({ overlay, draft: new SessionOverlayAdapter(base, overlay), edited: new Map(), agreed: null });
  }
  let counter = 0;
  const fresh = (who: string) => `${who}-${++counter}`;
  const expectedView = (person: Person) => ({ ...site, ...Object.fromEntries(person.edited) });
  /** The editor's fields whose published value moved away from the one the draft agreed with. */
  const collided = (person: Person) => [...person.edited.keys()].filter(name => person.agreed !== null && site[name] !== person.agreed[name]).sort();
  /** The draft agrees with the site as it is now, or is gone when it holds no change. */
  const settle = (person: Person) => { person.agreed = person.edited.size ? { ...site } : null; };

  for (const [index, current] of steps.entries()) {
    const at = `step ${index + 1} ${JSON.stringify(current)}`;
    if (current.kind === "developer") {
      site[current.field] = fresh("dev");
      await base.writeEntry("pages", "home", { ...site });
    } else {
      const person = people[current.editor];
      if (current.kind === "edit") {
        const value = fresh(`editor${current.editor}`);
        const shown = (await person.draft.getEntry("pages", "home"))!.data;
        await person.draft.writeEntry("pages", "home", { ...shown, [current.field]: value });
        person.agreed ??= { ...site };
        person.edited.set(current.field, value);
        // A save with nothing in conflict restarts the draft from the site as it is now.
        if (collided(person).length === 0) settle(person);
      } else if (current.kind === "undo") {
        const had = person.edited.has(current.field);
        expect(await person.draft.revertDraftField("pages", "home", current.field), at).toBe(had);
        person.edited.delete(current.field);
        if (had && person.agreed) person.agreed[current.field] = site[current.field];
        if (person.edited.size === 0) person.agreed = null;
      } else if (current.kind === "settle") {
        const fields = collided(person);
        expect(await person.draft.resolveDraftConflict("pages", "home", current.keep), at).toBe(fields.length > 0);
        if (fields.length && current.keep === "site") for (const name of fields) person.edited.delete(name);
        if (fields.length) settle(person);
      } else {
        const fields = collided(person);
        const outcome = await publishOverlay(base, person.overlay);
        if (fields.length) {
          expect(outcome.conflicts.map(conflict => conflict.fields), at).toEqual([fields]);
        } else {
          expect(outcome.conflicts, at).toEqual([]);
          for (const [name, value] of person.edited) site[name] = value;
          person.edited.clear();
          person.agreed = null;
        }
      }
    }

    // After every step: the site holds what the model says, and each editor sees their own changes on top of it.
    expect((await base.getEntry("pages", "home"))?.data, `site after ${at}`).toEqual(site);
    for (const [who, person] of people.entries()) {
      expect((await person.draft.getEntry("pages", "home"))?.data, `editor ${who} sees, after ${at}`).toEqual(expectedView(person));
      const changes = await person.draft.draftChanges("pages", "home");
      expect(changes.filter(change => change.kind !== "site").map(change => change.field), `editor ${who} changes, after ${at}`).toEqual([...person.edited.keys()].sort());
      expect(changes.filter(change => change.kind === "both").map(change => change.field), `editor ${who} collisions, after ${at}`).toEqual(collided(person));
      const conflict = await person.draft.draftConflict("pages", "home");
      expect(conflict?.fields.map(entry => entry.field) ?? [], `editor ${who} conflict, after ${at}`).toEqual(collided(person));
    }
  }
}

describe("a developer and two editors working on one entry, in any order", () => {
  it("never loses anyone's change and never reports a conflict that isn't one", async () => {
    await fc.assert(fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 14 }), run), { numRuns: 1500 });
  });
});
