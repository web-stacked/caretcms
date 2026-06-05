import { describe, expect, it } from "vitest";
import { resolveComponentImport } from "../../packages/caretize/src/resolve";
import {
  detectPropWrapTargets,
  propLocalName,
  type FileReader,
} from "../../packages/caretize/src/props";
import { prepareWrapFile } from "../../packages/caretize/src/run";

/** A FileReader backed by an in-memory path→source map. */
function reader(files: Record<string, string>): FileReader {
  return (rel) => (rel in files ? files[rel] : null);
}

describe("resolveComponentImport", () => {
  it("resolves a relative .astro import to a root-relative path", () => {
    const src = `import Features from '../components/Features.astro';`;
    expect(resolveComponentImport(src, "Features", "src/pages/index.astro")).toBe(
      "src/components/Features.astro",
    );
  });
  it("adds the .astro extension when omitted", () => {
    const src = `import Features from './Features';`;
    expect(resolveComponentImport(src, "Features", "src/pages/index.astro")).toBe(
      "src/pages/Features.astro",
    );
  });
  it("returns null for alias/bare specifiers", () => {
    const src = `import Features from '~/components/Features.astro';`;
    expect(resolveComponentImport(src, "Features", "src/pages/index.astro")).toBeNull();
  });
  it("returns null when the import is absent", () => {
    expect(resolveComponentImport("", "Features", "src/pages/index.astro")).toBeNull();
  });
  it("resolves a default import that also has a named group", () => {
    const src = `import Card, { Badge } from './Card.astro';`;
    expect(resolveComponentImport(src, "Card", "src/components/List.astro")).toBe(
      "src/components/Card.astro",
    );
  });
  it("does not match a substring component name (Card vs CardList)", () => {
    const src = `import CardList from './CardList.astro';`;
    expect(resolveComponentImport(src, "Card", "src/pages/index.astro")).toBeNull();
  });
});

describe("propLocalName", () => {
  it("finds a plain destructured prop", () => {
    expect(propLocalName(`const { items } = Astro.props;`, "items")).toBe("items");
  });
  it("follows a destructuring rename", () => {
    expect(propLocalName(`const { items: list } = Astro.props;`, "items")).toBe("list");
  });
  it("ignores a default value", () => {
    expect(propLocalName(`const { items = [] } = Astro.props;`, "items")).toBe("items");
  });
  it("returns null when props aren't simply destructured", () => {
    expect(propLocalName(`const props = Astro.props;`, "items")).toBeNull();
  });
});

describe("detectPropWrapTargets", () => {
  const parent = `---
import Features from '../components/Features.astro';
const features = [
  { title: 'Fast', desc: 'x' },
  { title: 'SEO', desc: 'y' },
];
---
<Features items={features} />
`;

  it("wraps a literal passed to a child that renders it as text", async () => {
    const child = `---
const { items } = Astro.props;
---
<ul>{items.map((i) => <li>{i.title}</li>)}</ul>
`;
    const targets = await detectPropWrapTargets(
      parent,
      "src/pages/index.astro",
      reader({ "src/components/Features.astro": child }),
    );
    expect(targets).toEqual([
      { varName: "features", key: "pages::home::features", origin: "prop" },
    ]);

    // The chosen target round-trips through the verified pure-insertion wrap.
    const prepared = await prepareWrapFile("src/pages/index.astro", parent, targets);
    expect(prepared.ok).toBe(true);
    expect(prepared.output).toContain(
      'const features = await editable("pages::home::features", [',
    );
  });

  it("SKIPS when the child renders a field as a native attribute", async () => {
    const child = `---
const { items } = Astro.props;
---
<ul>{items.map((i) => <a href={i.url}>{i.title}</a>)}</ul>
`;
    const targets = await detectPropWrapTargets(
      parent,
      "src/pages/index.astro",
      reader({ "src/components/Features.astro": child }),
    );
    expect(targets).toEqual([]);
  });

  it("SKIPS when the child import can't be resolved", async () => {
    const targets = await detectPropWrapTargets(
      parent,
      "src/pages/index.astro",
      reader({}), // child file missing
    );
    expect(targets).toEqual([]);
  });

  it("SKIPS when the child re-passes the prop to a grandchild component", async () => {
    const child = `---
import Card from './Card.astro';
const { items } = Astro.props;
---
<ul>{items.map((i) => <Card title={i.title} />)}</ul>
`;
    const targets = await detectPropWrapTargets(
      parent,
      "src/pages/index.astro",
      reader({ "src/components/Features.astro": child }),
    );
    expect(targets).toEqual([]);
  });

  it("does not treat a pure local-loop literal as a prop target", async () => {
    const localOnly = `---
const services = ['Marketing', 'Apps'];
---
<ul>{services.map((s) => <li>{s}</li>)}</ul>
`;
    const targets = await detectPropWrapTargets(
      localOnly,
      "src/pages/index.astro",
      reader({}),
    );
    expect(targets).toEqual([]);
  });
});
