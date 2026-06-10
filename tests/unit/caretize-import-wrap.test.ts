import { describe, expect, it } from "vitest";
import {
  detectImportWrapCandidates,
  detectImportWrapTargetsSafe,
  wrapImport,
} from "../../packages/caretize/src/import-wrap";
import { importBindingNames } from "../../packages/caretize/src/frontmatter";
import { prepareWrapFile } from "../../packages/caretize/src/run";

describe("importBindingNames", () => {
  it("captures default JSON and module imports, classifying kind", () => {
    const fm = `
import faqs from "./data/faqs.json";
import items from "../lib/items.ts";
`;
    const map = importBindingNames(fm);
    expect(map.get("faqs")).toEqual({ specifier: "./data/faqs.json", importKind: "json" });
    expect(map.get("items")).toEqual({ specifier: "../lib/items.ts", importKind: "module" });
  });

  it("ignores named, namespace, type, and bare/extensionless imports", () => {
    const fm = `
import { editable } from "@caretcms/core";
import * as utils from "./utils.js";
import type Thing from "./thing.json";
import Layout from "../layouts/Layout.astro";
import React from "react";
`;
    const map = importBindingNames(fm);
    // `* as` and named are excluded; `import type` excluded; `.astro` is a
    // component (handled elsewhere); bare package excluded.
    expect([...map.keys()]).toEqual([]);
  });
});

describe("detectImportWrapCandidates", () => {
  it("detects a default JSON import that is .map()'d in the template", () => {
    const src = `---
import faqs from "./data/faqs.json";
---
<dl>{faqs.map((f) => <dt>{f.question}</dt>)}</dl>
`;
    expect(detectImportWrapCandidates(src, "src/pages/index.astro")).toEqual([
      {
        varName: "faqs",
        key: "pages::home::faqs",
        specifier: "./data/faqs.json",
        importKind: "json",
      },
    ]);
  });

  it("ignores a JSON import that is never iterated", () => {
    const src = `---
import faqs from "./data/faqs.json";
---
<p>No loop here</p>
`;
    expect(detectImportWrapCandidates(src, "src/pages/index.astro")).toEqual([]);
  });

  it("skips dynamic routes", () => {
    const src = `---
import faqs from "./data/faqs.json";
---
{faqs.map((f) => <li>{f.q}</li>)}
`;
    expect(detectImportWrapCandidates(src, "src/pages/blog/[slug].astro")).toEqual([]);
  });
});

describe("detectImportWrapTargetsSafe", () => {
  it("keeps an import whose fields render only as text", async () => {
    const src = `---
import faqs from "./data/faqs.json";
---
<dl>{faqs.map((f) => <dt>{f.question}</dt>)}</dl>
`;
    expect(await detectImportWrapTargetsSafe(src, "src/pages/index.astro")).toEqual([
      { varName: "faqs", key: "pages::home::faqs", origin: "import" },
    ]);
  });

  it("DROPS an import whose field lands in a native-element attribute", async () => {
    const src = `---
import links from "./data/links.json";
---
<nav>{links.map((l) => <a href={l.href}>{l.label}</a>)}</nav>
`;
    expect(await detectImportWrapTargetsSafe(src, "src/pages/index.astro")).toEqual([]);
  });
});

describe("wrapImport", () => {
  it("rebinds the import to editable() via pure insertion", () => {
    const src = `---
import faqs from "./data/faqs.json";
---
<dl>{faqs.map((f) => <dt>{f.question}</dt>)}</dl>
`;
    const r = wrapImport(src, "faqs", "pages::home::faqs");
    expect(r.ok).toBe(true);
    expect(r.output).toContain(`import faqsRaw from "./data/faqs.json";`);
    expect(r.output).toContain(
      `const faqs = await editable("pages::home::faqs", faqsRaw);`,
    );
    expect(r.output).toContain(`import { editable } from '@caretcms/core';`);
    // Consumer untouched.
    expect(r.output).toContain(`{faqs.map((f) => <dt>{f.question}</dt>)}`);
  });

  it("is idempotent on a second run", () => {
    const src = `---
import faqs from "./data/faqs.json";
---
<dl>{faqs.map((f) => <dt>{f.question}</dt>)}</dl>
`;
    const once = wrapImport(src, "faqs", "pages::home::faqs").output;
    const twice = wrapImport(once, "faqs", "pages::home::faqs");
    expect(twice.alreadyWrapped).toBe(true);
    expect(twice.output).toBe(once);
    // And re-detection finds nothing.
    expect(detectImportWrapCandidates(once, "src/pages/index.astro")).toEqual([]);
  });

  it("end-to-end: detect → prepareWrapFile yields verified, pure-insertion output", async () => {
    const src = `---
import faqs from "./data/faqs.json";
---
<dl>{faqs.map((f) => <dt>{f.question}</dt>)}</dl>
`;
    const targets = await detectImportWrapTargetsSafe(src, "src/pages/index.astro");
    const prepared = await prepareWrapFile("src/pages/index.astro", src, targets);
    expect(prepared.ok).toBe(true);
    expect(prepared.tagCount).toBe(1);
    expect(prepared.output).toContain(
      `const faqs = await editable("pages::home::faqs", faqsRaw);`,
    );
  });
});
