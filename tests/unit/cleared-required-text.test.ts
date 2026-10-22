import { describe, expect, it } from "vitest";
import { clearedRequiredText, type JsonSchemaNode } from "../../packages/core/src/schema-utils.js";

const schema: JsonSchemaNode = {
  type: "object",
  required: ["name", "profile"],
  properties: {
    name: { type: "string" },
    role: { type: "string" },
    profile: { $ref: "#/$defs/profile" },
    count: { type: "number" },
  },
  $defs: {
    profile: { type: "object", required: ["bio"], properties: { bio: { type: "string" } } },
  },
};

describe("clearedRequiredText", () => {
  it("flags a required text field a change empties", () => {
    expect(clearedRequiredText(schema, { name: "Mara" }, { name: "  " })).toEqual([
      { path: "name", code: "required", message: "This field can't be empty" },
    ]);
  });

  it("leaves fields that were already empty, so existing content stays savable", () => {
    expect(clearedRequiredText(schema, { name: "" }, { name: "" })).toEqual([]);
  });

  it("allows emptying an optional field", () => {
    expect(clearedRequiredText(schema, { name: "Mara", role: "Design" }, { name: "Mara", role: "" })).toEqual([]);
  });

  it("follows local references into nested objects", () => {
    expect(clearedRequiredText(schema, { profile: { bio: "Writes" } }, { profile: { bio: "" } }))
      .toEqual([{ path: "profile.bio", code: "required", message: "This field can't be empty" }]);
  });

  it("ignores non-text values and missing fields", () => {
    expect(clearedRequiredText(schema, { name: "Mara" }, {})).toEqual([]);
    expect(clearedRequiredText(schema, { count: 2 }, { count: 0 })).toEqual([]);
  });
});
