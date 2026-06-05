import { describe, expect, it } from "vitest";
import { detectWrapTargets } from "../../packages/caretize/src/wrap";
import { prepareWrapFile } from "../../packages/caretize/src/run";

describe("detectWrapTargets", () => {
  it("detects a literal const that is .map()'d in the template", () => {
    const src = `---
const services = ['Marketing', 'Apps'];
---
<ul>{services.map((s) => <li>{s}</li>)}</ul>
`;
    expect(detectWrapTargets(src, "src/pages/index.astro")).toEqual([
      { varName: "services", key: "pages::home::services" },
    ]);
  });

  it("ignores a literal const that is never iterated", () => {
    const src = `---
const services = ['a'];
const unused = ['b'];
---
<ul>{services.map((s) => <li>{s}</li>)}</ul>
`;
    expect(detectWrapTargets(src, "src/pages/index.astro").map((t) => t.varName)).toEqual([
      "services",
    ]);
  });

  it("does NOT wrap non-literal sources (getCollection/await), even when mapped", () => {
    const src = `---
const projects = await getCollection('work');
---
<ul>{projects.map((p) => <li>{p.id}</li>)}</ul>
`;
    expect(detectWrapTargets(src, "src/pages/index.astro")).toEqual([]);
  });

  it("skips dynamic routes (no stable content identity)", () => {
    const src = `---
const items = ['a'];
---
{items.map((i) => <li>{i}</li>)}
`;
    expect(detectWrapTargets(src, "src/pages/blog/[slug].astro")).toEqual([]);
  });

  it("end-to-end: detect → prepareWrapFile yields verified wrapped output", async () => {
    const src = `---
import Card from '~/components/Card.astro';

const features = [
  { title: 'Fast', desc: 'x' },
  { title: 'SEO', desc: 'y' },
];
---
<div>{features.map((f) => <Card title={f.title} />)}</div>
`;
    const targets = detectWrapTargets(src, "src/pages/index.astro");
    expect(targets).toEqual([{ varName: "features", key: "pages::home::features" }]);

    const prepared = await prepareWrapFile("src/pages/index.astro", src, targets);
    expect(prepared.ok).toBe(true);
    expect(prepared.tagCount).toBe(1);
    expect(prepared.output).toContain(
      'const features = await editable("pages::home::features", [',
    );
  });
});
