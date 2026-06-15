# messages_fts is a self-contained FTS5 table, not external-content

PLAN §6 / SCOPE 0.2 described `messages_fts` as an "external-content" FTS5
table mirroring `messages`. The M0 index layer instead made it **self-contained**
(FTS5 stores its own copy of the indexed columns). Reason: the FTS `body`
column is a *computed* value that changes as a message moves along the
body_state ladder (snippet when `meta`; snippet + distilled body when `full`;
summary text after demotion to `summary-only`, ADR-0003) — there is no single
source column to mirror, so `content=`/`content_rowid=` external-content does
not fit. A contentless FTS5 table also cannot delete a row by rowid alone (it
raises "database disk image is malformed"), and in-place updates across the
ladder require exactly that DELETE+INSERT-by-rowid. The repo keeps the
self-contained table in lockstep with `messages` (stable rowid, delete+insert
on body-state change). Trade-off accepted: a modest extra copy of indexed text
on disk, in exchange for correct, simple updates across the body ladder. The
no-downgrade invariant (BODY_STATE_RANK) and FTS lockstep are enforced in
`repo.ts` and covered by tests.
