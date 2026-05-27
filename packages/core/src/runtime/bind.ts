/**
 * Explicit inline binding per ADR-004.
 *
 * Usage in .astro:
 *   const e = bindEntry({ collection: 'pages', id: 'home' })
 *   <h1 {...e('hero.title')}>{hero.title}</h1>
 */
export function bindEntry(entry: { collection: string; id: string }) {
  return (field: string, options?: { rich?: boolean }) => {
    const attrs: Record<string, string> = {
      "data-caret": `${entry.collection}::${entry.id}::${field}`,
    };
    if (options?.rich) {
      attrs["data-caret-rich"] = "";
    }
    return attrs;
  };
}
