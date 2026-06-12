import { describe, expect, it } from "vitest";
import {
  detectImportWrapCandidates,
  detectImportWrapTargetsSafe,
  detectNamedImportWrapCandidates,
  detectNamedImportWrapTargetsSafe,
  wrapImport,
  wrapNamedImport,
} from "../../packages/caretize/src/import-wrap";
import {
  importBindingNames,
  namedImportBindingNames,
} from "../../packages/caretize/src/frontmatter";
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

// ─── W1: named-import binding ───────────────────────────────────────────────

describe("namedImportBindingNames", () => {
  it("captures a single named binding with kind", () => {
    const map = namedImportBindingNames(`import { services } from "../data/site.ts";`);
    expect(map.get("services")).toEqual({ specifier: "../data/site.ts", importKind: "module" });
  });

  it("captures multiple bindings from one statement", () => {
    const map = namedImportBindingNames(`import { services, team } from "../data/site.ts";`);
    expect([...map.keys()].sort()).toEqual(["services", "team"]);
  });

  it("SKIPS a pre-aliased binding (renaming it would emit invalid JS)", () => {
    const map = namedImportBindingNames(`import { data as items } from "./items.ts";`);
    expect([...map.keys()]).toEqual([]);
  });

  it("keeps the plain bindings but skips the aliased one in a mixed list", () => {
    const map = namedImportBindingNames(`import { a, b as c, d } from "./x.ts";`);
    expect([...map.keys()].sort()).toEqual(["a", "d"]);
  });

  it("ignores an inline `type` specifier but keeps value bindings", () => {
    const map = namedImportBindingNames(`import { type Item, items } from "./items.ts";`);
    expect([...map.keys()]).toEqual(["items"]);
  });

  it("captures the named half of a mixed default+named import", () => {
    const map = namedImportBindingNames(`import def, { services } from "./site.ts";`);
    expect([...map.keys()]).toEqual(["services"]);
  });

  it("ignores `import type {…}`, namespace, and extensionless/bare specifiers", () => {
    const fm = `
import type { Foo } from "./foo.ts";
import { Bar } from "some-package";
import { Layout } from "../layouts/Layout.astro";
`;
    expect([...namedImportBindingNames(fm).keys()]).toEqual([]);
  });

  it("is independent from importBindingNames (default vs named)", () => {
    const fm = `
import faqs from "./data/faqs.json";
import { services } from "./data/site.ts";
`;
    expect([...importBindingNames(fm).keys()]).toEqual(["faqs"]);
    expect([...namedImportBindingNames(fm).keys()]).toEqual(["services"]);
  });
});

describe("detectNamedImportWrapCandidates", () => {
  it("detects a named import that is .map()'d in the template", () => {
    const src = `---
import { services } from "../data/site.ts";
---
{services.map((s) => <h3>{s.title}</h3>)}
`;
    expect(detectNamedImportWrapCandidates(src, "src/pages/index.astro")).toEqual([
      {
        varName: "services",
        key: "pages::home::services",
        specifier: "../data/site.ts",
        importKind: "module",
      },
    ]);
  });

  it("wraps only the binding actually iterated, not its statement-mates", () => {
    const src = `---
import { services, team } from "../data/site.ts";
---
{services.map((s) => <h3>{s.title}</h3>)}
`;
    const got = detectNamedImportWrapCandidates(src, "src/pages/index.astro");
    expect(got.map((c) => c.varName)).toEqual(["services"]);
  });

  it("excludes a non-relative/extensionless specifier", () => {
    const src = `---
import { services } from "some-package";
---
{services.map((s) => <h3>{s.title}</h3>)}
`;
    expect(detectNamedImportWrapCandidates(src, "src/pages/index.astro")).toEqual([]);
  });
});

describe("detectNamedImportWrapTargetsSafe", () => {
  it("keeps a named import whose fields render only as text, tagged origin named-import", async () => {
    const src = `---
import { services } from "../data/site.ts";
---
{services.map((s) => <h3>{s.title}</h3>)}
`;
    expect(await detectNamedImportWrapTargetsSafe(src, "src/pages/index.astro")).toEqual([
      { varName: "services", key: "pages::home::services", origin: "named-import" },
    ]);
  });

  it("DROPS a named import whose field lands in a native-element attribute", async () => {
    const src = `---
import { links } from "../data/links.ts";
---
<nav>{links.map((l) => <a href={l.href}>{l.label}</a>)}</nav>
`;
    expect(await detectNamedImportWrapTargetsSafe(src, "src/pages/index.astro")).toEqual([]);
  });

  it("detects default and named imports side by side", async () => {
    const src = `---
import faqs from "./data/faqs.json";
import { services } from "./data/site.ts";
---
<dl>{faqs.map((f) => <dt>{f.q}</dt>)}</dl>
{services.map((s) => <h3>{s.title}</h3>)}
`;
    const def = await detectImportWrapTargetsSafe(src, "src/pages/index.astro");
    const named = await detectNamedImportWrapTargetsSafe(src, "src/pages/index.astro");
    expect(def).toEqual([{ varName: "faqs", key: "pages::home::faqs", origin: "import" }]);
    expect(named).toEqual([
      { varName: "services", key: "pages::home::services", origin: "named-import" },
    ]);
  });
});

describe("wrapNamedImport", () => {
  it("renames inside the destructure and rebinds via pure insertion", () => {
    const src = `---
import { services } from "../data/site.ts";
---
{services.map((s) => <h3>{s.title}</h3>)}
`;
    const r = wrapNamedImport(src, "services", "pages::home::services");
    expect(r.ok).toBe(true);
    expect(r.output).toContain(`import { services as servicesRaw } from "../data/site.ts";`);
    expect(r.output).toContain(
      `const services = await editable("pages::home::services", servicesRaw);`,
    );
    expect(r.output).toContain(`import { editable } from '@caretcms/core';`);
    // Consumer untouched.
    expect(r.output).toContain(`{services.map((s) => <h3>{s.title}</h3>)}`);
  });

  it("handles multiple bindings on one statement applied sequentially", () => {
    const src = `---
import { services, team } from "../data/site.ts";
---
{services.map((s) => <h3>{s.title}</h3>)}
{team.map((t) => <p>{t.name}</p>)}
`;
    const first = wrapNamedImport(src, "services", "pages::home::services");
    expect(first.ok).toBe(true);
    const second = wrapNamedImport(first.output, "team", "pages::home::team");
    expect(second.ok).toBe(true);
    // Both renamed, neither corrupted.
    expect(second.output).toContain(
      `import { services as servicesRaw, team as teamRaw } from "../data/site.ts";`,
    );
    expect(second.output).toContain(
      `const services = await editable("pages::home::services", servicesRaw);`,
    );
    expect(second.output).toContain(
      `const team = await editable("pages::home::team", teamRaw);`,
    );
  });

  it("is idempotent on a second run", () => {
    const src = `---
import { services } from "../data/site.ts";
---
{services.map((s) => <h3>{s.title}</h3>)}
`;
    const once = wrapNamedImport(src, "services", "pages::home::services").output;
    const twice = wrapNamedImport(once, "services", "pages::home::services");
    expect(twice.alreadyWrapped).toBe(true);
    expect(twice.output).toBe(once);
    expect(detectNamedImportWrapCandidates(once, "src/pages/index.astro")).toEqual([]);
  });

  it("end-to-end: detect → prepareWrapFile yields verified, pure-insertion output", async () => {
    const src = `---
import { services } from "../data/site.ts";
---
{services.map((s) => <h3>{s.title}</h3>)}
`;
    const targets = await detectNamedImportWrapTargetsSafe(src, "src/pages/index.astro");
    const prepared = await prepareWrapFile("src/pages/index.astro", src, targets);
    expect(prepared.ok).toBe(true);
    expect(prepared.tagCount).toBe(1);
    expect(prepared.output).toContain(
      `import { services as servicesRaw } from "../data/site.ts";`,
    );
    expect(prepared.output).toContain(
      `const services = await editable("pages::home::services", servicesRaw);`,
    );
  });

  it("end-to-end: two bindings from one statement both wrap and verify", async () => {
    const src = `---
import { services, team } from "../data/site.ts";
---
{services.map((s) => <h3>{s.title}</h3>)}
{team.map((t) => <p>{t.name}</p>)}
`;
    const targets = await detectNamedImportWrapTargetsSafe(src, "src/pages/index.astro");
    expect(targets.map((t) => t.varName).sort()).toEqual(["services", "team"]);
    const prepared = await prepareWrapFile("src/pages/index.astro", src, targets);
    expect(prepared.ok).toBe(true);
    expect(prepared.tagCount).toBe(2);
    expect(prepared.output).toContain(
      `import { services as servicesRaw, team as teamRaw } from "../data/site.ts";`,
    );
  });
});
