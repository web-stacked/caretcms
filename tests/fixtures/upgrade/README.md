# Frozen pre-hardening storage

`pre-hardening-store` is a hand-frozen disk snapshot using the JSON entry,
Markdown source, sidecar, and version-1 recovery formats at review baseline
`3616421` (package version 0.5.0). It also includes older drafts without baseline
state. Tests copy these files into a temporary directory; they must not recreate
them with current adapter or recovery helpers.

The named entries represent an interrupted publish before writing, after data,
after revision, and after history. Recovery records deliberately have no new
`journalSources` field. Markdown records retain exact original/prepared source.
Other entries exercise legacy structured/deletion/body drafts, a current
baseline draft, an intervening external edit, and an invalid recovery record.
Historical creation plans intentionally lack prepared source; deletion plans
retain their original source and history while completing cleanup.
The original revision is 7; a completed transition is 8. Overlay revisions are
3. A rebuild receipt and orphan editor collection metadata must survive.

When changing formats, retain this snapshot and add a new versioned fixture.
Do not rewrite historical expectations to make a format change pass.
