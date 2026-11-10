import { describe, expect, it } from "vitest";
import { dateInputValue, storedDateValue } from "../../packages/core/static/cms/studio/fields.js";

describe("date fields", () => {
  it("shows a stored calendar day as that day, whatever the time zone", () => {
    expect(dateInputValue("date", "2026-03-11")).toBe("2026-03-11");
    // A bare YAML date can come back as midnight UTC; it's still the 11th.
    expect(dateInputValue("date", "2026-03-11T00:00:00.000Z")).toBe("2026-03-11");
    expect(dateInputValue("date", "")).toBe("");
    expect(dateInputValue("date", "soon")).toBe("");
  });

  it("stores the picked day as written", () => {
    expect(storedDateValue("date", "2026-04-02", "2026-03-11")).toBe("2026-04-02");
    expect(storedDateValue("date", "", "2026-03-11")).toBe("");
  });

  it("keeps a date-time in the form the field already uses", () => {
    // Without a zone: local wall time in, local wall time out.
    expect(dateInputValue("date-time", "2026-03-11T09:30")).toBe("2026-03-11T09:30");
    expect(storedDateValue("date-time", "2026-03-11T10:00", "2026-03-11T09:30")).toBe("2026-03-11T10:00");
    // With a zone (and for new values): an instant, shown in local time.
    const instant = "2026-03-11T09:30:00.000Z";
    const shown = dateInputValue("date-time", instant);
    expect(new Date(shown).toISOString()).toBe(instant);
    expect(storedDateValue("date-time", shown, instant)).toBe(instant);
    expect(storedDateValue("date-time", shown, "")).toBe(instant);
  });
});
