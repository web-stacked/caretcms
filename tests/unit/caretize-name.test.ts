import { describe, it, expect } from "vitest";
import {
  slugifyText,
  assignFields,
  deriveScope,
  isValidField,
} from "../../packages/caretize/src/name";
import type { Candidate } from "../../packages/caretize/src/detect";

function textCandidate(tag: string, text: string, startOffset = 0): Candidate {
  return { decision: "tag", kind: "text", node: {} as never, tag, startOffset, confidence: "high", text };
}

describe("slugifyText", () => {
  it("derives readable slugs from heading text, stripping emoji", () => {
    expect(slugifyText("Our Programs 🎨")).toBe("our_programs");
    expect(slugifyText("About Our School 🏫")).toBe("about_our_school");
    expect(slugifyText("A Day at Elementary 🕐")).toBe("a_day_at_elementary");
  });

  it("keeps contractions joined and decodes &amp;", () => {
    expect(slugifyText("What's Happening 🎭")).toBe("whats_happening");
    expect(slugifyText("Contact &amp; Enrollment 📝")).toBe("contact_and_enrollment");
  });

  it("caps at four words", () => {
    expect(slugifyText("Stay in the Loop right now! 📬")).toBe("stay_in_the_loop");
  });

  it("returns null when nothing usable remains (all emoji, or leading digits)", () => {
    expect(slugifyText("🎉🎊")).toBeNull();
    expect(slugifyText("8:00 AM – 3:00 PM")).toBeNull();
    expect(slugifyText("   ")).toBeNull();
  });

  it("only ever produces valid field names", () => {
    for (const s of ["Our Programs 🎨", "Contact &amp; Enrollment", "Über Café"]) {
      const slug = slugifyText(s);
      if (slug) expect(isValidField(slug)).toBe(true);
    }
  });
});

describe("assignFields with text-derived names", () => {
  it("names the seven section headings by content, not subhead_N", () => {
    const headings = [
      "What's Happening 🎭", "About Our School 🏫", "Our Programs 🎨",
      "A Day at Elementary 🕐", "What Parents Say 💬", "Stay in the Loop! 📬",
      "Frequently Asked Questions ❓",
    ].map((t, i) => textCandidate("h2", t, i));

    const names = [...assignFields(headings).values()];
    expect(names).toEqual([
      "whats_happening", "about_our_school", "our_programs",
      "a_day_at_elementary", "what_parents_say", "stay_in_the_loop",
      "frequently_asked_questions",
    ]);
  });

  it("falls back to role names when text isn't sluggable, and dedupes", () => {
    const cands = [
      textCandidate("p", "8:00 AM – 3:00 PM", 0), // leading digit → not sluggable → intro
      textCandidate("p", "★ ★ ★", 1), // all symbols → body
      textCandidate("p", "💬 💬", 2), // all emoji → body_2
    ];
    const names = [...assignFields(cands).values()];
    expect(names).toEqual(["intro", "body", "body_2"]);
  });

  it("is deterministic and unique even for identical text", () => {
    const cands = [textCandidate("h2", "News", 0), textCandidate("h2", "News", 1)];
    expect([...assignFields(cands).values()]).toEqual(["news", "news_2"]);
  });

  it("seeds from existing fields to avoid collisions on re-runs", () => {
    const cands = [textCandidate("h2", "Our Programs", 0)];
    expect([...assignFields(cands, ["our_programs"]).values()]).toEqual(["our_programs_2"]);
  });
});

describe("deriveScope (sanity)", () => {
  it("maps page paths and skips dynamic routes", () => {
    expect(deriveScope("src/pages/index.astro")).toEqual({ scope: { collection: "pages", id: "home" } });
    expect(deriveScope("src/pages/contact.astro")).toEqual({ scope: { collection: "pages", id: "contact" } });
    expect(deriveScope("src/components/Footer.astro")).toEqual({ scope: { collection: "components", id: "footer" } });
    expect(deriveScope("src/pages/blog/[slug].astro")).toEqual({ skip: "dynamic-route" });
  });
});
