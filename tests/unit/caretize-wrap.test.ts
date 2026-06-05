import { describe, expect, it } from "vitest";
import { wrapConst } from "../../packages/caretize/src/wrap";

const KEY = "pages::home::services";

describe("caretize wrapConst (Tier-1, pure insertion)", () => {
  it("wraps a single-line array initializer and adds the import", () => {
    const src = `---
import Features from '~/components/Features.astro';

const services = ['Marketing', 'Apps', 'SEO'];
---

<Features items={services} />
`;
    const { output, ok } = wrapConst(src, "services", KEY);
    expect(ok).toBe(true);
    expect(output).toBe(`---
import { editable } from '@caretcms/core';
import Features from '~/components/Features.astro';

const services = await editable("pages::home::services", ['Marketing', 'Apps', 'SEO']);
---

<Features items={services} />
`);
  });

  it("is a PURE INSERTION — original characters are all preserved in order", () => {
    const src = `---
const services = ['a', 'b'];
---
<x />
`;
    const { output } = wrapConst(src, "services", KEY);
    // Removing exactly what we inserted restores the original, byte-for-byte.
    const restored = output
      .replace("import { editable } from '@caretcms/core';\n", "")
      .replace('await editable("pages::home::services", ', "")
      .replace("['a', 'b'])", "['a', 'b']");
    expect(restored).toBe(src);
  });

  it("handles a multi-line array (brackets balanced across newlines)", () => {
    const src = `---
const items = [
  { title: 'Fast', desc: 'x' },
  { title: 'SEO', desc: 'y' },
];
---
`;
    const { output, ok } = wrapConst(src, "items", "pages::home::items");
    expect(ok).toBe(true);
    expect(output).toContain('const items = await editable("pages::home::items", [');
    expect(output).toContain("]);"); // closing paren before the original semicolon
  });

  it("wraps a scalar value too", () => {
    const src = `---
const title = "Welcome";
---
`;
    const { output } = wrapConst(src, "title", "pages::home::title");
    expect(output).toContain('const title = await editable("pages::home::title", "Welcome");');
  });

  it("is idempotent — running twice does not double-wrap", () => {
    const src = `---
const services = ['a'];
---
`;
    const once = wrapConst(src, "services", KEY).output;
    const twice = wrapConst(once, "services", KEY);
    expect(twice.alreadyWrapped).toBe(true);
    expect(twice.output).toBe(once);
  });

  it("does not duplicate an existing import", () => {
    const src = `---
import { editable } from '@caretcms/core';
const services = ['a'];
---
`;
    const { output } = wrapConst(src, "services", KEY);
    const importCount = output.split("@caretcms/core").length - 1;
    expect(importCount).toBe(1);
  });

  it("ignores brackets inside strings", () => {
    const src = `---
const label = "a [bracketed] value";
---
`;
    const { output, ok } = wrapConst(src, "label", "pages::home::label");
    expect(ok).toBe(true);
    expect(output).toContain('await editable("pages::home::label", "a [bracketed] value");');
  });

  it("fails cleanly when the const is not in the frontmatter", () => {
    const src = `---
const other = 1;
---
`;
    const { ok, reason } = wrapConst(src, "services", KEY);
    expect(ok).toBe(false);
    expect(reason).toMatch(/not found/);
  });
});
