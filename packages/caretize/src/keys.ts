/**
 * Cross-tier storage-key registry.
 *
 * Every tier derives `collection::id::field` keys independently — the tag pass
 * from element content, wraps/hoists from variable/prop names — and each one
 * only dedupes against itself plus the file's existing `data-caret` attributes.
 * Without a shared registry one run can mint the SAME key twice with two
 * different value shapes (a tag's string vs a wrap's array), and `editable()`
 * keys from a prior run are invisible to the tag pass entirely.
 *
 * The CLI threads one registry per file: existing keys are pre-claimed, tags
 * claim first (their names are content-derived and surfaced in the review),
 * then wraps, then hoists. A later claim that collides takes a `_2`/`_3` field
 * suffix — still within the runtime's field grammar. Bind-tier keys are
 * per-row template literals into a *collection's* entries (a different
 * namespace from the page scope), so they stay outside the registry.
 */

/** `editable("collection::id::field", …)` calls in the frontmatter. */
const EDITABLE_KEY_RE = /\beditable\(\s*["'`]([^"'`]+)["'`]/g;

/** Static `data-caret="…"` attribute values anywhere in the source. */
const DATA_CARET_ATTR_RE = /\bdata-caret\s*=\s*"([^"]+)"/g;

/**
 * Keys already present in a file's source: every static `data-caret` value
 * (full triples as-is; scoped shorthands resolved when the file's scope is
 * known) plus every `editable()` key.
 */
export function collectExistingKeys(
  source: string,
  scope?: { collection: string; id: string },
): Set<string> {
  const keys = new Set<string>();
  for (const m of source.matchAll(DATA_CARET_ATTR_RE)) {
    const value = m[1];
    if (value.includes("::")) keys.add(value);
    else if (scope) keys.add(`${scope.collection}::${scope.id}::${value}`);
  }
  for (const m of source.matchAll(EDITABLE_KEY_RE)) keys.add(m[1]);
  return keys;
}

/** `key` if free, else the first `key_2`, `key_3`, … not in `used`. */
export function deconflictKey(key: string, used: ReadonlySet<string>): string {
  if (!used.has(key)) return key;
  for (let n = 2; ; n++) {
    const candidate = `${key}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Apply the registry to one file's planned changes, in claim order: existing
 * keys (pre-claimed from `source`), tags, wraps, hoist props. Mutates the
 * colliding entries in place — including the tag's attribute text and the
 * hoist prop's precomputed `constInsert`, which bake the key in.
 */
export function applyKeyRegistry(
  source: string,
  scope: { collection: string; id: string } | undefined,
  tags: Array<{
    field: string;
    binding: string;
    attribute: string;
    candidate: { rich?: boolean };
  }>,
  wraps: Array<{ key: string }>,
  hoists: Array<{
    props: Array<{ key: string; constName: string; literalValue: string; constInsert: string }>;
  }>,
): void {
  const used = collectExistingKeys(source, scope);
  for (const t of tags) {
    const free = deconflictKey(t.binding, used);
    if (free !== t.binding) {
      t.field = free.slice(free.lastIndexOf("::") + 2);
      t.binding = free;
      t.attribute = t.candidate.rich
        ? `data-caret="${free}" data-caret-rich`
        : `data-caret="${free}"`;
    }
    used.add(t.binding);
  }
  for (const w of wraps) {
    w.key = deconflictKey(w.key, used);
    used.add(w.key);
  }
  for (const h of hoists) {
    for (const p of h.props) {
      const free = deconflictKey(p.key, used);
      if (free !== p.key) {
        p.key = free;
        p.constInsert = `\nconst ${p.constName} = await editable(${JSON.stringify(free)}, ${JSON.stringify(p.literalValue)});`;
      }
      used.add(p.key);
    }
  }
}
