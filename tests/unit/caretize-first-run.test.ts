/**
 * First-run trial fixes: what caretize leaves alone (script-driven text,
 * buttons, the home link), how it names hoisted props and images, how it
 * treats identifier fields of wrapped data, and the counts and notes it
 * prints along the way.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAstro, walkTags } from "../../packages/caretize/src/parse";
import { detect, scriptSelectorHooks, type DetectOptions } from "../../packages/caretize/src/detect";
import { planFile, type FilePlan } from "../../packages/caretize/src/plan";
import { classifyConstUsage, identifierUses } from "../../packages/caretize/src/usage";
import { detectWrapTargetsSafe, literalFields, type WrapTarget } from "../../packages/caretize/src/wrap";
import { detectPropHoistTargets, hoistField } from "../../packages/caretize/src/prop-hoist";
import { applyKeyRegistry } from "../../packages/caretize/src/keys";
import { escalationCounts, extraOffers } from "../../packages/caretize/src/escalation";
import { formatHints, formatPlan, sharedScopeNote } from "../../packages/caretize/src/output";
import { dirtyTreeWarning, gitDirtyPaths } from "../../packages/caretize/src/preflight";
import type { FileReader } from "../../packages/caretize/src/props";

async function detectSource(source: string, options?: DetectOptions) {
  return detect(await parseAstro(source), walkTags, options);
}

const COUNTER = `---
interface Props { target: number; label: string }
const { target, label } = Astro.props;
---
<div class="counter">
  <span class="counter-value" data-target={target}>0</span>
  <span class="counter-label">{label}</span>
</div>
<script>
  for (const el of document.querySelectorAll<HTMLElement>('.counter-value')) {
    el.textContent = '1';
  }
</script>
`;

describe("script-driven text is not content", () => {
  it("skips an element the component's <script> selects by class", async () => {
    const r = await detectSource(COUNTER, { rich: true, richClass: true });
    expect(r.candidates.some((c) => c.text === "0")).toBe(false);
    expect(r.skipped.some((s) => s.tag === "span" && s.reason === "script-hook")).toBe(true);
  });

  it("skips elements found by id, getElementsByClassName and closest(), with their contents", async () => {
    const r = await detectSource(`<p id="clock">00:00</p><p class="status big">Idle</p>
<div class="card"><h3>Title <em>x</em></h3></div><p class="other">Keep me</p>
<script>
  document.getElementById("clock").textContent = "now";
  document.getElementsByClassName('status')[0].textContent = "busy";
  btn.closest(".card").remove();
</script>`);
    const texts = r.candidates.map((c) => c.text);
    expect(texts).toEqual(["Keep me"]);
    expect(r.skipped.filter((s) => s.reason === "script-hook").map((s) => s.tag)).toEqual(["p", "p", "div", "h3", "em"]);
  });

  it("reads only the subject of each selector", () => {
    const hooks = scriptSelectorHooks(`
      root.querySelector('.list > li.item:not(.skip)');
      document.querySelectorAll(".a .b, #c[data-x='y']");
      el.querySelector(\`.tpl\`);
    `);
    expect([...hooks.classes].sort()).toEqual(["b", "item", "tpl"]);
    expect([...hooks.ids]).toEqual(["c"]);
  });

  it("still tags an element whose class no script uses", async () => {
    const r = await detectSource(`<p class="lede">Hello there</p><script>document.querySelector('.nav')</script>`);
    expect(r.candidates.map((c) => c.text)).toEqual(["Hello there"]);
  });
});

describe("interface chrome is not content", () => {
  it("skips a <button> and the text inside it", async () => {
    const r = await detectSource(`<button class="chat"><span>Questions? Chat with us</span></button>`, { rich: true });
    expect(r.candidates).toHaveLength(0);
    expect(r.skipped.map((s) => s.reason)).toEqual(["ui-control", "ui-control"]);
  });

  it("skips the home link / logo, but keeps ordinary content links", async () => {
    const src = `<header><a href="/" class="logo">Acme <span>&</span> Co</a></header>
<ul><li><a href="/about">About us</a></li></ul>`;
    const plan = await planFile(src, "src/layouts/Base.astro", { minConfidence: "low", rich: true });
    expect(plan.tags.map((t) => t.candidate.text)).toEqual(["About us"]);
    expect(plan.skipped.filter((s) => s.reason === "home-link").map((s) => s.tag)).toEqual(["a", "span"]);
  });
});

describe("lower-confidence count matches whichever tiers are chosen", () => {
  const PAGE = `<p>We are a <strong>family-run bakery</strong>. Read <a href="/about">our story</a>.</p>
<p class="note">Items marked <span class="vegan">V</span> are vegan.</p>
<ul><li>Fresh daily</li></ul>`;

  it("inline children of a block left for a rich tier are never separate spots", async () => {
    const off = await planFile(PAGE, "src/pages/index.astro", { minConfidence: "high" });
    const richOn = await planFile(PAGE, "src/pages/index.astro", { minConfidence: "high", rich: true });
    const counts = escalationCounts([off], new Map());
    expect(counts.lowconf).toBe(1); // the <li>, not strong/a/span
    expect(richOn.belowConfidence).toBe(counts.lowconf);
    expect(counts.rich).toBe(1);
    expect(counts["rich-class"]).toBe(1);
  });

  it("offers every non-empty tier: the ones outside [Y] are asked separately", () => {
    expect(extraOffers({ collections: 0, routes: 0, rich: 3, "rich-class": 1, lowconf: 2 })).toEqual(["rich-class", "lowconf"]);
    // When nothing recommended is on offer, [Y] already applies everything.
    expect(extraOffers({ rich: 0, "rich-class": 1, lowconf: 2 })).toEqual([]);
  });
});

describe("identifier fields of wrapped data", () => {
  const MENU = (field: string) => `---
import { getCollection } from 'astro:content';
const items = await getCollection('menu');
const sections = [
  { ${field}: 'bread', label: 'Bread' },
  { ${field}: 'cake', label: 'Cakes' },
] as const;
---
{sections.map((s) => {
  const list = items.filter((i) => i.data.category === s.${field});
  return <section><h2>{s.label}</h2>{list.map((i) => <p>{i.data.name}</p>)}</section>;
})}
`;

  it("wraps an array whose compared field core leaves unmarked (key)", async () => {
    const targets = await detectWrapTargetsSafe(MENU("key"), "src/pages/menu.astro");
    expect(targets.map((t) => t.varName)).toEqual(["sections"]);
    expect(literalFields(MENU("key"), "sections")).toEqual({ text: ["label"], ids: ["key"] });
  });

  it("does not wrap an array whose compared field core would mark (value)", async () => {
    expect(await detectWrapTargetsSafe(MENU("value"), "src/pages/menu.astro")).toEqual([]);
    const verdict = classifyConstUsage(await parseAstro(MENU("value")), "sections");
    expect(verdict.reason).toMatch(/field "value" of "sections" is compared/);
  });

  it("follows destructured params and lookups", async () => {
    const ast = await parseAstro(`---
const tabs = [{ id: 'a', name: 'A' }];
const byName = {};
---
{tabs.map(({ id, name: title }) => <p>{byName[title]}{id === current && <b>on</b>}</p>)}`);
    expect(identifierUses(ast, "tabs").sort()).toEqual(["id", "name"]);
  });

  it("does not hoist a prop the child compares", async () => {
    const reader: FileReader = () => `---
const { tone } = Astro.props;
---
<p>{tone}</p>{tone === 'warm' && <span>hot</span>}`;
    const page = `---
import Badge from '../components/Badge.astro';
---
<Badge tone="warm" />`;
    expect(await detectPropHoistTargets(page, "src/pages/index.astro", reader)).toEqual([]);
  });

  it("names editable and kept-as-is fields in the plan", () => {
    const plan = { relPath: "src/pages/menu.astro", tags: [], skipped: [], flags: [] } as unknown as FilePlan;
    const w = { varName: "sections", key: "pages::menu::sections", origin: "loop", fields: { text: ["label"], ids: ["key"] } } as WrapTarget;
    expect(formatPlan([plan], new Map([[plan.relPath, [w]]]), new Map())).toContain(
      `wrap const sections  (editable: label · kept as-is: key)`,
    );
  });
});

describe("hoisted prop naming", () => {
  const CHILD = `---
const { quote, name } = Astro.props;
---
<blockquote>{quote}</blockquote><p>{name}</p>`;
  const PAGE = `---
import Testimonial from '../components/Testimonial.astro';
---
<h2>What people say</h2>
<Testimonial quote="Best bread" name="Priya" />
<Testimonial quote="Great buns" name="Dan" />`;

  it("uses the component and which use of it", async () => {
    const targets = await detectPropHoistTargets(PAGE, "src/pages/index.astro", () => CHILD);
    expect(targets.flatMap((t) => t.props.map((p) => [p.key, p.constName]))).toEqual([
      ["pages::home::testimonial_quote", "testimonialQuote"],
      ["pages::home::testimonial_name", "testimonialName"],
      ["pages::home::testimonial_2_quote", "testimonial2Quote"],
      ["pages::home::testimonial_2_name", "testimonial2Name"],
    ]);
  });

  it("builds valid field names from any component name", () => {
    expect(hoistField("PageHero", 1, "title")).toBe("page_hero_title");
    expect(hoistField("UI.Card", 3, "ctaText")).toBe("ui_card_3_cta_text");
    expect(hoistField("_", 1, "label")).toBe("label");
  });

  it("never reuses a key an earlier run already wrote", async () => {
    const prior = PAGE.replace(
      "---\n<h2>",
      `const x = await editable("pages::home::testimonial_quote", "Old");\n---\n<h2>`,
    );
    const targets = await detectPropHoistTargets(prior, "src/pages/index.astro", () => CHILD);
    applyKeyRegistry(prior, { collection: "pages", id: "home" }, [], [], targets);
    expect(targets[0].props[0].key).toBe("pages::home::testimonial_quote_2");
  });
});

describe("image naming", () => {
  it("names an image after the heading it sits under", async () => {
    const plan = await planFile(`<h1>Our story</h1><img src="/a.svg" alt="" />`, "src/pages/about.astro");
    expect(plan.tags.map((t) => t.field)).toEqual(["our_story", "our_story_image"]);
  });
});

describe("shared component values", () => {
  it("says a component's or layout's tags are one value for every use", async () => {
    const comp = await planFile(`<p>Fresh bread daily, from our oven to you.</p>`, "src/components/Promo.astro");
    expect(sharedScopeNote(comp)).toBe("(shared: one value for every <Promo> on the site)");
    expect(formatPlan([comp], new Map(), new Map())).toContain("(shared: one value for every <Promo> on the site)");
    expect(formatHints([comp])).toMatch(/one value for every use/);
    const page = await planFile(`<p>Hello there friends.</p>`, "src/pages/index.astro");
    expect(sharedScopeNote(page)).toBeNull();
    expect(formatHints([page])).not.toMatch(/one value for every use/);
  });
});

describe("uncommitted-changes warning", () => {
  it("warns only about files this run edits", () => {
    expect(dirtyTreeWarning(["package.json", "astro.config.mjs"], ["src/pages/index.astro"])).toBeNull();
    expect(dirtyTreeWarning(null, ["src/pages/index.astro"])).toBeNull();
    expect(dirtyTreeWarning(["src/pages/index.astro"], ["src/pages/index.astro"])).toMatch(
      /^src\/pages\/index\.astro has uncommitted changes/,
    );
    expect(dirtyTreeWarning(["a.astro", "b.astro"], ["a.astro", "b.astro"])).toMatch(/^a\.astro and 1 more file\(s\) have/);
  });

  it("lists dirty paths relative to the project inside a larger repo", () => {
    const repo = mkdtempSync(join(tmpdir(), "caretize-dirty-"));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
      git("init", "-q");
      mkdirSync(join(repo, "site/src/pages"), { recursive: true });
      writeFileSync(join(repo, "site/src/pages/index.astro"), "<h1>Hi</h1>\n");
      writeFileSync(join(repo, "other.txt"), "x\n");
      git("add", "-A");
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
      expect(gitDirtyPaths(join(repo, "site"))).toEqual([]);
      writeFileSync(join(repo, "site/src/pages/index.astro"), "<h1>Changed</h1>\n");
      writeFileSync(join(repo, "site/new.astro"), "<p>new</p>\n");
      writeFileSync(join(repo, "other.txt"), "y\n");
      expect(gitDirtyPaths(join(repo, "site"))?.sort()).toEqual(["new.astro", "src/pages/index.astro"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
