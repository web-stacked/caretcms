import { describe, expect, it } from "vitest";
import {
  detectPropHoistTargets,
  hoistPropLiterals,
  verifyHoistResult,
} from "../../packages/caretize/src/prop-hoist";
import { prepareFileFull } from "../../packages/caretize/src/run";
import type { FileReader } from "../../packages/caretize/src/props";

// A child that renders `title` as text and `description` via set:html (rich).
const PAGEHERO = `---
const { title, description } = Astro.props;
---
<section>
  <h1>{title}</h1>
  <p set:html={description} />
</section>
`;

// A child that lands its prop in a native attribute → must NOT be hoisted.
const AVATAR = `---
const { src } = Astro.props;
---
<img src={src} alt="" />
`;

// A layout that renders `title` ONLY inside <head> → text-safe but the editor
// can never click it, so it must NOT be hoisted.
const LAYOUT = `---
const { title } = Astro.props;
---
<html><head><title>{title}</title></head><body><slot /></body></html>
`;

// Renders `title` in <head> AND in the body → the body sink makes it hoistable.
const HEADERED = `---
const { title } = Astro.props;
---
<html><head><title>{title}</title></head><body><h1>{title}</h1><slot /></body></html>
`;

const reader: FileReader = (rel) => {
  if (rel.includes("PageHero")) return PAGEHERO;
  if (rel.includes("Avatar")) return AVATAR;
  if (rel.includes("Layout")) return LAYOUT;
  if (rel.includes("Headered")) return HEADERED;
  return null;
};

const ABOUT = `---
import PageHero from "../components/PageHero.astro";
---
<PageHero title="ABOUT US" description="<p>Since 2010</p>" />
`;

describe("detectPropHoistTargets", () => {
  it("detects text + rich props on a component whose child renders them as text", async () => {
    const targets = await detectPropHoistTargets(ABOUT, "src/pages/about.astro", reader);
    expect(targets).toHaveLength(1);
    expect(targets[0].componentName).toBe("PageHero");
    const byName = Object.fromEntries(targets[0].props.map((p) => [p.propName, p]));
    expect(byName.title.key).toBe("pages::about::title");
    expect(byName.title.constName).toBe("pageHeroTitle");
    expect(byName.title.isRich).toBe(false);
    expect(byName.description.key).toBe("pages::about::description");
    expect(byName.description.isRich).toBe(true);
  });

  it("does NOT hoist a prop that lands in a native-element attribute", async () => {
    const src = `---
import Avatar from "../components/Avatar.astro";
---
<Avatar src="/me.png" />
`;
    expect(await detectPropHoistTargets(src, "src/pages/about.astro", reader)).toEqual([]);
  });

  it("skips components it cannot resolve", async () => {
    const src = `---
import Hero from "@ui/Hero.astro";
---
<Hero title="Hi" />
`;
    expect(await detectPropHoistTargets(src, "src/pages/about.astro", reader)).toEqual([]);
  });

  it("does NOT hoist a prop the child renders only inside <head>", async () => {
    const src = `---
import Layout from "../layouts/Layout.astro";
---
<Layout title="About — Site"><p>hi</p></Layout>
`;
    expect(await detectPropHoistTargets(src, "src/pages/about.astro", reader)).toEqual([]);
  });

  it("DOES hoist a prop the child renders in <head> AND the body", async () => {
    const src = `---
import Headered from "../layouts/Headered.astro";
---
<Headered title="About — Site"><p>hi</p></Headered>
`;
    const targets = await detectPropHoistTargets(src, "src/pages/about.astro", reader);
    expect(targets).toHaveLength(1);
    expect(targets[0].props.map((p) => p.propName)).toEqual(["title"]);
  });
});

describe("hoistPropLiterals + verifyHoistResult", () => {
  it("rewrites attrs to refs and hoists editable() consts, reversibly", async () => {
    const targets = await detectPropHoistTargets(ABOUT, "src/pages/about.astro", reader);
    const r = hoistPropLiterals(ABOUT, targets);
    expect(r.ok).toBe(true);
    expect(r.propsRewritten).toBe(2);
    expect(r.output).toContain(`import { editable } from '@caretcms/core';`);
    expect(r.output).toContain(`const pageHeroTitle = await editable("pages::about::title", "ABOUT US");`);
    expect(r.output).toContain(
      `const pageHeroDescription = await editable("pages::about::description", "<p>Since 2010</p>");`,
    );
    expect(r.output).toContain(`<PageHero title={pageHeroTitle} description={pageHeroDescription} />`);
    // Inverse gate holds.
    expect(verifyHoistResult(ABOUT, r.output, targets, r.addedImport)).toBe(true);
  });

  it("inverse gate REJECTS a tampered output", async () => {
    const targets = await detectPropHoistTargets(ABOUT, "src/pages/about.astro", reader);
    const r = hoistPropLiterals(ABOUT, targets);
    const tampered = r.output.replace("ABOUT US", "TAMPERED");
    expect(verifyHoistResult(ABOUT, tampered, targets, r.addedImport)).toBe(false);
  });

  it("round-trips a prop value containing $ replacement-pattern chars", async () => {
    // `$&`, `$$`, `$5` are special in String.replace's replacement arg — a naive
    // restore would mangle them and the inverse gate would falsely reject.
    const src = `---
import PageHero from "../components/PageHero.astro";
---
<PageHero title="50% off — $5 & $$ and $& deals" description="<p>x</p>" />
`;
    const targets = await detectPropHoistTargets(src, "src/pages/about.astro", reader);
    const r = hoistPropLiterals(src, targets);
    expect(r.ok).toBe(true);
    expect(r.output).toContain(`"50% off — $5 & $$ and $& deals"`);
    expect(verifyHoistResult(src, r.output, targets, r.addedImport)).toBe(true);
  });
});

describe("prepareFileFull with hoists", () => {
  it("end-to-end: verified, re-parseable output", async () => {
    const targets = await detectPropHoistTargets(ABOUT, "src/pages/about.astro", reader);
    const prepared = await prepareFileFull("src/pages/about.astro", ABOUT, [], [], targets);
    expect(prepared.ok).toBe(true);
    expect(prepared.tagCount).toBe(2);
    expect(prepared.output).toContain(`title={pageHeroTitle}`);
  });

  it("co-occurs with a data-caret tag pass in the same file", async () => {
    const src = `---
import PageHero from "../components/PageHero.astro";
---
<PageHero title="ABOUT US" description="<p>Since 2010</p>" />
<h2>Our Team</h2>
`;
    const targets = await detectPropHoistTargets(src, "src/pages/about.astro", reader);
    const h2 = src.indexOf("<h2");
    const prepared = await prepareFileFull(
      "src/pages/about.astro",
      src,
      [{ startOffset: h2, attribute: `data-caret="pages::about::our_team"` }],
      [],
      targets,
    );
    expect(prepared.ok).toBe(true);
    expect(prepared.output).toContain(`<h2 data-caret="pages::about::our_team">`);
    expect(prepared.output).toContain(`title={pageHeroTitle}`);
  });

  it("is idempotent — re-detection on hoisted output finds nothing", async () => {
    const targets = await detectPropHoistTargets(ABOUT, "src/pages/about.astro", reader);
    const out = hoistPropLiterals(ABOUT, targets).output;
    expect(await detectPropHoistTargets(out, "src/pages/about.astro", reader)).toEqual([]);
  });
});
