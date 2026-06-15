# Agents write summaries into the index; summaries replace bodies for bulk mail

The tool never calls an LLM (ADR-0002), but the agent reading the mail already
is one — so the index accepts **agent-written summaries** via a `save_summary`
MCP tool, at both message and thread level (thread preferred when a
conversation is the meaningful unit). Summaries are provenance-marked as
model-generated, FTS-indexed (improving recall), and never overwrite source
fields.

Retention is then policy-gated by importance: for `is_list=1` / non-curated
mail (newsletters, notifications), once summarized the distilled body is
**demoted** — summary-only (~0.5 KB) is the end state. For curated-important
contacts and threads the user participated in, summaries are *additive* and the
distilled body stays. This trades lossiness on bulk mail (search ranks on a
paraphrase; ground truth needs a re-fetch) for a permanently small index —
acceptable because Gmail remains the archive and the index is a **working
set**: demotion is never data loss, anything can be re-enriched by id.

Execution: `save_summary` only marks a body *eligible*; demotion runs in
`mail-index compact`, which sync auto-invokes for eligible bodies older than a
grace window (default 7 days, configurable) — so a bad summary has a week of
retry-against-source before the local body goes. `compact --now` exists for
deliberate immediate shrinking.
