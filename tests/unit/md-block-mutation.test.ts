import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeMutation } from "../../packages/core/src/runtime/mutations/engine";
import { MarkdownAdapter } from "../../packages/core/src/runtime/storage/markdown-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { canonicalBody } from "../../packages/core/src/markdown/canonical-body";
import { fnv1a32, BODY_OVERLAY_KEY } from "../../packages/core/src/markdown/contracts";

const FILE = `---
title: Hello
---

# Heading

First paragraph with some text.

> quoted line
`;

let root: string;
let base: MarkdownAdapter;
let draft: SessionOverlayAdapter;

/** Build a valid src hint for the block whose canonical slice equals `text`. */
async function srcFor(text: string): Promise<string> {
  const file = await readFile(join(root, "content/blog/hello.md"), "utf8");
  const { body } = canonicalBody(file);
  const start = body.indexOf(text);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = start + text.length;
  return `${start}:${end}:${fnv1a32(body.slice(start, end))}`;
}

function mdBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "md_block",
    collection: "blog",
    id: "hello",
    blockPath: "1",
    html: "Edited <strong>paragraph</strong>.",
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "caret-mdblock-"));
  await mkdir(join(root, "content/blog"), { recursive: true });
  await writeFile(join(root, "content/blog/hello.md"), FILE);
  base = new MarkdownAdapter({
    contentRoot: join(root, "content"),
    metaRoot: join(root, ".caretcms"),
    draftsRoot: join(root, ".caret/drafts"),
  });
  draft = new SessionOverlayAdapter(base, await base.makeEditorOverlay("editor-1"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("md_block mutation — happy path", () => {
  it("stores a server-derived markdown draft under __body", async () => {
    const src = await srcFor("First paragraph with some text.");
    const result = await executeMutation(draft, mdBlock({ src }));
    expect(result.ok).toBe(true);

    const entry = await draft.getEntry("blog", "hello");
    const body = entry!.data[BODY_OVERLAY_KEY] as Record<
      string,
      { md: string; html: string; src: { hash: string } }
    >;
    expect(body["1"].md).toBe("Edited **paragraph**.");
    expect(body["1"].html).toBe("Edited <strong>paragraph</strong>.");
    // Draft data still carries the base frontmatter (publish writes data whole).
    expect(entry!.data.title).toBe("Hello");
    // The source .md file is untouched at draft time.
    expect(await readFile(join(root, "content/blog/hello.md"), "utf8")).toBe(FILE);
  });

  it("derives heading context from the source, ignoring client claims", async () => {
    const src = await srcFor("# Heading");
    const result = await executeMutation(
      draft,
      mdBlock({ blockPath: "0", src, html: "New <em>title</em>" }),
    );
    expect(result.ok).toBe(true);
    const entry = await draft.getEntry("blog", "hello");
    const body = entry!.data[BODY_OVERLAY_KEY] as Record<string, { md: string }>;
    expect(body["0"].md).toBe("# New *title*");
  });

  it("nested (blockquote) block: hard break is refused via derived context", async () => {
    const src = await srcFor("quoted line");
    const result = await executeMutation(
      draft,
      mdBlock({ blockPath: "2.0", src, html: "a<br>b" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("second edit to another block accumulates in the same map", async () => {
    await executeMutation(
      draft,
      mdBlock({ src: await srcFor("First paragraph with some text.") }),
    );
    const r2 = await executeMutation(
      draft,
      mdBlock({
        blockPath: "0",
        src: await srcFor("# Heading"),
        html: "Retitled",
        expectedRevision: 1,
      }),
    );
    expect(r2.ok).toBe(true);
    const entry = await draft.getEntry("blog", "hello");
    const body = entry!.data[BODY_OVERLAY_KEY] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["0", "1"]);
  });
});

describe("md_block mutation — guards", () => {
  it("409 when the source file changed since stamping (stale hash)", async () => {
    const src = await srcFor("First paragraph with some text.");
    await writeFile(
      join(root, "content/blog/hello.md"),
      FILE.replace("First paragraph", "Externally edited paragraph"),
    );
    const result = await executeMutation(draft, mdBlock({ src }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.body.currentRevision).toBeTypeOf("number");
    }
  });

  it("409 on revision race: second writer with a stale expectedRevision", async () => {
    const src = await srcFor("First paragraph with some text.");
    const first = await executeMutation(draft, mdBlock({ src, expectedRevision: 0 }));
    expect(first.ok).toBe(true);
    const second = await executeMutation(
      draft,
      mdBlock({ src, html: "Other edit", expectedRevision: 0 }),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(409);
      expect(second.body.currentRevision).toBe(1);
    }
  });

  it("script markup cannot reach the stored draft", async () => {
    const src = await srcFor("First paragraph with some text.");
    const script = await executeMutation(
      draft,
      mdBlock({ src, html: '<script src="https://evil.com/x.js">alert(1)</script>ok' }),
    );
    // The sanitizer strips the tags (inner TEXT survives, same as the existing
    // data-caret-rich path); the derived markdown escapes everything, so no
    // element or attribute can reach the source file on publish.
    expect(script.ok).toBe(true);
    const entry = await draft.getEntry("blog", "hello");
    const body = entry!.data[BODY_OVERLAY_KEY] as Record<string, { md: string; html: string }>;
    expect(body["1"].html).not.toContain("<script");
    expect(body["1"].html).not.toContain("evil.com");
    expect(body["1"].md).not.toContain("<");
    expect(body["1"].md).not.toContain("evil.com");
  });

  it("400 on structurally malformed HTML (unbalanced allowlisted tags)", async () => {
    const src = await srcFor("First paragraph with some text.");
    const result = await executeMutation(
      draft,
      mdBlock({ src, html: "<strong>unclosed" }),
    );
    // If the sanitizer normalizes it, serialization succeeds; if anything
    // unbalanced survives to the strict parser, it must 400 — never store
    // half-parsed structure. Accept either, but never a 5xx or corrupt store.
    if (!result.ok) {
      expect(result.status).toBe(400);
    } else {
      const entry = await draft.getEntry("blog", "hello");
      const body = entry!.data[BODY_OVERLAY_KEY] as Record<string, { md: string }>;
      expect(body["1"].md).toBe("**unclosed**");
    }
  });

  it("rejects malformed payloads (grammar, size cap)", async () => {
    const src = await srcFor("First paragraph with some text.");
    const cases: Array<Record<string, unknown>> = [
      mdBlock({ blockPath: "__proto__", src }),
      mdBlock({ blockPath: "1.", src }),
      mdBlock({ src: "9:1:deadbeef" }),
      mdBlock({ src: "not-a-hint" }),
      mdBlock({ src, html: "x".repeat(64 * 1024 + 1) }),
      mdBlock({ src, html: 42 }),
    ];
    for (const input of cases) {
      const result = await executeMutation(draft, input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(400);
    }
  });

  it("400 when the adapter has no body source (non-markdown storage)", async () => {
    const { InMemoryAdapter } = await import(
      "../../packages/core/src/runtime/storage/in-memory-adapter"
    );
    const mem = new InMemoryAdapter();
    const result = await executeMutation(
      mem,
      mdBlock({ src: "0:5:00000000" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("put_entry (Studio form save) preserves drafted body blocks", async () => {
    // The Studio form fetches via /entries (which strips __body) and saves the
    // whole entry back — that round-trip must not destroy inline body drafts.
    const src = await srcFor("First paragraph with some text.");
    await executeMutation(draft, mdBlock({ src }));
    const put = await executeMutation(draft, {
      type: "put_entry",
      collection: "blog",
      id: "hello",
      data: { title: "Edited in Studio" }, // no __body — as the form sends it
    });
    expect(put.ok).toBe(true);
    const entry = await draft.getEntry("blog", "hello");
    expect(entry!.data.title).toBe("Edited in Studio");
    const body = entry!.data[BODY_OVERLAY_KEY] as Record<string, { md: string }>;
    expect(body["1"].md).toBe("Edited **paragraph**.");
  });

  it("md_block on a draft-deleted entry does not resurrect the tombstone", async () => {
    await draft.deleteEntry("blog", "hello"); // tombstone into the overlay
    const src = await srcFor("First paragraph with some text.");
    const result = await executeMutation(draft, mdBlock({ src }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
    // Still deleted from the draft's point of view.
    expect(await draft.getEntry("blog", "hello")).toBeNull();
  });

  it("save_field and put_entry cannot write the reserved __body key", async () => {
    const save = await executeMutation(draft, {
      type: "save_field",
      collection: "blog",
      id: "hello",
      field: `${BODY_OVERLAY_KEY}.1.md`,
      value: "# injected",
    });
    expect(save.ok).toBe(false);

    const put = await executeMutation(draft, {
      type: "put_entry",
      collection: "blog",
      id: "hello",
      data: { title: "x", [BODY_OVERLAY_KEY]: { "1": { md: "# injected" } } },
    });
    expect(put.ok).toBe(false);
  });
});

describe('paragraph group mutations', () => {
  it('stores one splice for a split and prevents stale single-block overwrites', async () => {
    const src = await srcFor('First paragraph with some text.');
    const result = await executeMutation(draft, mdBlock({ src, sources: [{ blockPath: '1', src, html: 'First paragraph with some text.' }], paragraphs: ['First half.', 'Second <strong>half</strong>.'] }));
    expect(result.ok).toBe(true);
    const entry = await draft.getEntry('blog', 'hello');
    expect(entry!.data.__body).toMatchObject({ '1': { md: 'First half.\n\nSecond **half**.', paragraphs: ['First half.', 'Second <strong>half</strong>.'] } });
    expect((await executeMutation(draft, mdBlock({ src }))).ok).toBe(false);
    expect(await readFile(join(root, 'content/blog/hello.md'), 'utf8')).toBe(FILE);
  });

  it('preserves inline code and emphasis through group sanitization', async () => {
    const src = await srcFor('First paragraph with some text.');
    const result = await executeMutation(draft, mdBlock({ src, sources: [{ blockPath: '1', src, html: '' }], paragraphs: ['Use <code onclick="bad()">Café 🧪</code> and <strong>bold</strong>.'] }));
    expect(result.ok).toBe(true);
    expect((await draft.getEntry('blog', 'hello'))!.data.__body).toMatchObject({ '1': {
      md: 'Use `Café 🧪` and **bold**.', paragraphs: ['Use <code>Café 🧪</code> and <strong>bold</strong>.'],
    } });
  });

  it('validates all paragraph sources before writing, including adjacency and payload limits', async () => {
    const src = await srcFor('First paragraph with some text.');
    for (const overrides of [
      { sources: [] },
      { sources: [{ blockPath: '1.0', src, html: '' }] },
      { paragraphs: [42] },
      { paragraphs: ['a'.repeat(65537)] },
      { sources: [{ blockPath: '1', src: src.slice(0, -8) + '00000000', html: '' }] },
    ]) {
      const result = await executeMutation(draft, mdBlock({ src, sources: [{ blockPath: '1', src, html: '' }], paragraphs: ['New'], ...overrides }));
      expect(result.ok).toBe(false);
    }
    expect(await draft.getOwnEntry('blog', 'hello')).toBeNull();
  });

  it('replaces member drafts atomically and rejects a stale editor of a consumed paragraph', async () => {
    const path = join(root, 'content/blog/hello.md');
    await writeFile(path, FILE.replace('\n\n> quoted line', '\n\nSecond paragraph.\n\n> quoted line'));
    const src = await srcFor('First paragraph with some text.');
    const second = await srcFor('Second paragraph.');
    expect((await executeMutation(draft, mdBlock({ src: second, blockPath: '2', html: 'Old draft' }))).ok).toBe(true);
    expect((await executeMutation(draft, mdBlock({ src, sources: [{ blockPath: '1', src, html: '' }, { blockPath: '2', src: second, html: '' }], paragraphs: ['Merged.'] }))).ok).toBe(true);
    expect(Object.keys((await draft.getEntry('blog', 'hello'))!.data.__body as object)).toEqual(['1']);
    const stale = await executeMutation(draft, mdBlock({ src: second, blockPath: '2' }));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.status).toBe(409);
  });
});
