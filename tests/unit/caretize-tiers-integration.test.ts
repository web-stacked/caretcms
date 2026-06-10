/**
 * Integration: all editable() tiers + the data-caret tag pass on ONE file,
 * driven through the same detectors the CLI uses, then verified end-to-end by
 * prepareFileFull. This is the "works across any scenario" guard.
 */
import { describe, expect, it } from "vitest";
import { parseAstro } from "../../packages/caretize/src/parse";
import { planFile } from "../../packages/caretize/src/plan";
import { detectWrapTargetsSafe } from "../../packages/caretize/src/wrap";
import { detectImportWrapTargetsSafe } from "../../packages/caretize/src/import-wrap";
import { detectPropHoistTargets } from "../../packages/caretize/src/prop-hoist";
import { prepareFileFull } from "../../packages/caretize/src/run";
import type { FileReader } from "../../packages/caretize/src/props";

// A child that renders `title` through a SUB-COMPONENT's slot (not a prop).
// The text reaches a slot position, so it's a safe text sink even though it
// passes through <Heading> — caretize should still hoist it.
const HERO = `---
import Heading from "./Heading.astro";
const { title } = Astro.props;
---
<Heading level="h1">{title}</Heading>
`;

const reader: FileReader = (rel) => (rel.includes("Hero") ? HERO : null);

const PAGE = `---
import Hero from "../components/Hero.astro";
import faqs from "../data/faqs.json";
const stats = [{ label: "Patients", value: "500" }];
---
<Hero title="WELCOME" />
<h2>Why us</h2>
<ul>{stats.map((s) => <li>{s.label}: {s.value}</li>)}</ul>
<dl>{faqs.map((f) => <dt>{f.q}</dt>)}</dl>
`;
const REL = "src/pages/landing.astro";

describe("all tiers on one file", () => {
  it("hoists a prop rendered through a sub-component slot (Tier-4 + slot passthrough)", async () => {
    const targets = await detectPropHoistTargets(PAGE, REL, reader);
    expect(targets).toHaveLength(1);
    expect(targets[0].props.map((p) => p.propName)).toEqual(["title"]);
  });

  it("applies data-caret + Tier-1 + Tier-3 + Tier-4 together and re-parses", async () => {
    const ast = await parseAstro(PAGE);

    const plan = await planFile(PAGE, REL, { minConfidence: "high" }, ast);
    const tags = plan.tags.map((t) => ({ startOffset: t.startOffset, attribute: t.attribute }));

    const loops = await detectWrapTargetsSafe(PAGE, REL, ast);
    const imports = await detectImportWrapTargetsSafe(PAGE, REL, ast);
    const hoists = await detectPropHoistTargets(PAGE, REL, reader, ast);

    const prepared = await prepareFileFull(REL, PAGE, tags, [...loops, ...imports], hoists);

    expect(prepared.ok).toBe(true);
    // data-caret tag on the static <h2>
    expect(prepared.output).toContain(`<h2 data-caret="pages::landing::why_us">`);
    // Tier-1: inline const array wrapped
    expect(prepared.output).toContain(`const stats = await editable("pages::landing::stats", [`);
    // Tier-3: json import rebound through editable()
    expect(prepared.output).toContain(`import faqsRaw from "../data/faqs.json"`);
    expect(prepared.output).toContain(`const faqs = await editable("pages::landing::faqs", faqsRaw);`);
    // Tier-4: component prop hoisted + attr rewritten
    expect(prepared.output).toContain(`const heroTitle = await editable("pages::landing::title", "WELCOME");`);
    expect(prepared.output).toContain(`<Hero title={heroTitle} />`);
    // Consumers untouched
    expect(prepared.output).toContain(`{stats.map((s) => <li>{s.label}: {s.value}</li>)}`);
    expect(prepared.output).toContain(`{faqs.map((f) => <dt>{f.q}</dt>)}`);

    // And the whole thing is still valid Astro.
    await expect(parseAstro(prepared.output)).resolves.toBeTruthy();
  });
});
