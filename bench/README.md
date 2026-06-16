# Benchmark — mail-index vs a stock Gmail-API MCP

A reproducible, side-by-side **token** benchmark. It measures the two taxes any
MCP server imposes on an agent's context window:

1. **Fixed schema tax** — every server injects all its tool definitions
   (names + descriptions + input JSON schemas) into the context on *every turn*,
   before any work happens. Counted from each server's `tools/list`.
2. **Per-task result tax** — the tokens each tool *returns* to answer a real
   question. This is where mail-index's ranked, snippet-first, distilled results
   diverge from the Gmail API's raw payloads (header arrays + base64 MIME parts).

## Why this is a fair fight (not a strawman)

- The Gmail side uses **real Gmail API payloads** fetched via the `gws` CLI — the
  exact JSON a stock Gmail MCP (`messages.list` + `messages.get`) hands the model.
- We model the Gmail "find → read" path **generously to Gmail**: `messages.list`
  returns ids only (no snippet — that's the real API), so to *identify* the answer
  the agent must `messages.get` candidates. We charge only the **top-3 at
  `format=metadata`** per recall + **one `format=full`** per read. Real agents
  guess the query several times and fetch more, so the true gap is larger.
- mail-index is charged for its real MCP calls: one `search` (ranked snippets),
  plus one `get_message` for a read.
- Token counting uses the **Anthropic `count_tokens` API** when
  `ANTHROPIC_API_KEY` is set (Claude-exact); otherwise a `chars/4` approximation.
  The headline is the **ratio**, which is stable across tokenizers.

## Run it

```sh
pnpm run build                      # ensure dist/ is current
node bench/run.mjs                  # defaults: --account personal
node bench/run.mjs --account unsold-group
# exact Claude token counts:
ANTHROPIC_API_KEY=sk-... node bench/run.mjs
# point at a LIVE Gmail MCP's tools/list for an exact schema-tax line:
node bench/run.mjs --gmail-tools /path/to/that-servers-tools.json
```

Output:
- **stdout** — aggregate, shareable summary (schema tax + per-task totals + ratio).
- **`bench/results.local.md`** — the full per-task table. Gitignored
  (`*.local.md`) because token counts are derived from your real mailbox.

## Files

- `run.mjs` — the harness (mail-index MCP over stdio vs Gmail API via `gws`).
- `gmail-mcp-tools.json` — a representative stock Gmail MCP tool surface, used
  only for the fixed schema-tax line. Swap in a live server's `tools/list` via
  `--gmail-tools` for an exact figure. Not affiliated with any project.

## Interpreting the result

mail-index wins on both axes, for one structural reason: **it answers from a
local index built for recall, so a question costs one compact, ranked call** —
where the Gmail API forces a round-trip dance (list → get → get …) that ships raw
message envelopes into the context just to *find* what you meant. See
[../docs/COMPARISON.md](../docs/COMPARISON.md).
