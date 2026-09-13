# Multiline Markdown frontmatter

Caret's Markdown adapter reads literal (`|`) and folded (`>`) strings in mapping
fields and sequence items. It supports strip (`-`), clip (default), and keep (`+`)
chomping, plus indentation indicators from 1 to 9 in either header order
(for example `|2-` and `|-2`). Indentation and line-break rules follow
[YAML block scalar semantics](https://yaml.org/spec/1.2.2/#81-block-scalar-styles).

```yaml
caption: |-
  First line
  Second line
summary: >
  These lines form
  one paragraph.
```

Studio uses a textarea for multiline strings even when a schema does not specify
`format: 'textarea'`. This includes short values with trailing newlines.

Saving an entry preserves unchanged top-level field blocks, including their
block style, comments, quotes, and whitespace. Unchanged Markdown/MDX body bytes
and existing fences remain intact. The same rewriting path is used by draft
publication, including combined prose and frontmatter publication.

Changed top-level fields are serialized canonically. Multiline strings become
quoted strings containing escaped newlines; their decoded values retain the
line breaks, indentation, and trailing newlines. Changing a nested field may
reformat that entire top-level object, including its comments. This is not a
full YAML syntax-preserving editor.

The codec remains a dependency-free YAML subset. Anchors, aliases, tags,
standalone block headers on a separate line from their mapping key or sequence
marker, and other unsupported syntax still produce explicit read errors.
Malformed block headers and invalid indentation are rejected before a save can
overwrite the source. Broader YAML compatibility remains separate work.
