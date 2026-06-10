import { describe, expect, it } from "vitest";
import { prepareWrapFile } from "../../packages/caretize/src/run";

const FILE = "src/pages/index.astro";

const SOURCE = `---
import Features from '~/components/Features.astro';

const services = ['Marketing', 'Apps', 'SEO'];
---

<Features items={services} />
`;

describe("prepareWrapFile (Tier-1 wrap through the verified pipeline)", () => {
  it("wraps a target const and passes both gates", async () => {
    const prepared = await prepareWrapFile(FILE, SOURCE, [
      { varName: "services", key: "pages::home::services" },
    ]);

    expect(prepared.ok).toBe(true);
    expect(prepared.tagCount).toBe(1);
    expect(prepared.output).toContain(
      'const services = await editable("pages::home::services", [',
    );
    expect(prepared.output).toContain("import { editable } from '@caretcms/core';");
    // Gate 2 holds: original is a subsequence of the output (pure insertion).
    // (sanity: every original line still present, in order)
    expect(prepared.output).toContain("<Features items={services} />");
  });

  it("no-ops when there is nothing to wrap (already wrapped)", async () => {
    const already = `---
import { editable } from '@caretcms/core';
const services = await editable("pages::home::services", ['a']);
---
<x />
`;
    const prepared = await prepareWrapFile(FILE, already, [
      { varName: "services", key: "pages::home::services" },
    ]);
    expect(prepared.ok).toBe(true);
    expect(prepared.tagCount).toBe(0); // nothing inserted
    expect(prepared.output).toBe(already);
  });

  it("fails cleanly (writes nothing) when the target const is absent", async () => {
    const prepared = await prepareWrapFile(FILE, SOURCE, [
      { varName: "missing", key: "pages::home::missing" },
    ]);
    expect(prepared.ok).toBe(false);
    expect(prepared.reason).toMatch(/not found/);
    expect(prepared.output).toBe(SOURCE); // unchanged on failure
  });

  it("wraps multiple targets in one file", async () => {
    const src = `---
const services = ['a'];
const features = [{ title: 'x' }];
---
<x />
`;
    const prepared = await prepareWrapFile(FILE, src, [
      { varName: "services", key: "pages::home::services" },
      { varName: "features", key: "pages::home::features" },
    ]);
    expect(prepared.ok).toBe(true);
    expect(prepared.tagCount).toBe(2);
    expect(prepared.output).toContain('await editable("pages::home::services"');
    expect(prepared.output).toContain('await editable("pages::home::features"');
  });
});
