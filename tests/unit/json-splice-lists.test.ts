import { describe, expect, it } from "vitest";
import { spliceJson } from "../../packages/core/src/runtime/storage/json-splice";

const splice = (source: string, after: unknown) => spliceJson(source, JSON.parse(source), after, 2);

describe("spliceJson with a list that gains or loses an item", () => {
  const oneLine = `[
  { "id": "a", "question": "First?", "tags": ["x", "y"] },
  { "id": "b", "question": "Second?", "tags": [] }
]
`;

  it("adds an item in the style of the ones before it and leaves the rest alone", () => {
    const after = [...JSON.parse(oneLine), { id: "c", question: "Third?", tags: ["z"] }];
    expect(splice(oneLine, after)).toBe(`[
  { "id": "a", "question": "First?", "tags": ["x", "y"] },
  { "id": "b", "question": "Second?", "tags": [] },
  { "id": "c", "question": "Third?", "tags": ["z"] }
]
`);
  });

  it("adds an item to a list of multi-line objects", () => {
    const source = `[\n  {\n    "id": "a"\n  }\n]\n`;
    expect(splice(source, [{ id: "a" }, { id: "b" }])).toBe(`[\n  {\n    "id": "a"\n  },\n  {\n    "id": "b"\n  }\n]\n`);
  });

  it("adds to a compact list", () => {
    expect(splice(`["a","b"]`, ["a", "b", "c"])).toBe(`["a","b","c"]`);
  });

  it("changes an item and adds one in the same write", () => {
    const after = [{ id: "a", question: "Changed?", tags: ["x", "y"] }, JSON.parse(oneLine)[1], { id: "c", question: "Third?", tags: [] }];
    const out = splice(oneLine, after);
    expect(out).toContain(`{ "id": "a", "question": "Changed?", "tags": ["x", "y"] },`);
    expect(out).toContain(`{ "id": "c", "question": "Third?", "tags": [] }\n]`);
  });

  it("removes a first, middle or last item without touching the others", () => {
    const source = `[\n  { "id": "a" },\n  { "id": "b" },\n  { "id": "c" }\n]\n`;
    expect(splice(source, [{ id: "b" }, { id: "c" }])).toBe(`[\n  { "id": "b" },\n  { "id": "c" }\n]\n`);
    expect(splice(source, [{ id: "a" }, { id: "c" }])).toBe(`[\n  { "id": "a" },\n  { "id": "c" }\n]\n`);
    expect(splice(source, [{ id: "a" }, { id: "b" }])).toBe(`[\n  { "id": "a" },\n  { "id": "b" }\n]\n`);
  });

  it("always parses back to what was asked for", () => {
    const source = `{ "list": [ 1, 2 ], "other": "x" }`;
    for (const list of [[1, 2, 3], [2], [1], [1, 2, 3, 4], [2, 3]]) {
      const out = splice(source, { list, other: "x" });
      expect(JSON.parse(out)).toEqual({ list, other: "x" });
    }
  });
});
