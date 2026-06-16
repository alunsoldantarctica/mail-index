# mail-index

A **local, agent-queryable mail intelligence layer**. It indexes a mailbox
progressively (cheap metadata for everything, full bodies only where they earn
their place), builds a graph of who and what you correspond with, infers
interest from engagement signals, lets you curate who/what matters, and exposes
it all to AI agents (Claude, Codex, any MCP client) through a **local MCP
server**.

Local-first — the index never leaves your machine. Read-only — it never sends or
mutates your mail.

> **Status: v1.0.** Progressive sync, the correspondence graph, the interest
> engine, curation, the full 18-tool MCP surface, and the write-back loops are
> shipped. The full architecture and build plan live in
> **[docs/PLAN.md](docs/PLAN.md)**; start with **[docs/INSTALL.md](docs/INSTALL.md)**.

---

## The tool vs. your setup

This distinction shapes the whole project:

- **This repo is the *tool*** — generic, reusable, and contains **none** of any
  user's data. All examples use placeholders (`you@example.com`, `acct-a`).
- **Your *instance*** — the accounts you connect, your OAuth app, your curated
  interest profile, your agent instructions — is **private configuration you
  keep in your own dotfiles and data directory.** It is never committed here.

If a thing only makes sense for one person, it's configuration, not the tool.
See [docs/PLAN.md §2](docs/PLAN.md).

---

## How it works

1. **Progressive sync** — metadata for the whole mailbox in minutes; bodies
   fetched selectively.
2. **Graph** — contacts, domains, threads; centrality + communities over your
   *human* (non-bulk) mail.
3. **Interest** — an engagement score per contact from read/reply/star/importance
   signals. A *seed for your curation*, not an autonomous decision.
4. **Curate** — you (via your agent, or a CLI wizard) confirm who/what matters;
   that profile drives which bodies get fetched.
5. **Query** — your agent searches, traverses the graph, and reads the messages
   that matter, all locally via MCP.

## Why not just a Gmail MCP?

Stock Gmail-API MCPs are query-based lookup tools: exact queries, a network
round-trip per call, and raw message payloads streamed into context. mail-index
answers *vague* questions from a local recall index — measurably lighter on
tokens (~30× less to read a message; one ranked call instead of a list→get→get
dance). See **[docs/COMPARISON.md](docs/COMPARISON.md)** and reproduce the
numbers with **[bench/](bench/README.md)** (`node bench/run.mjs`).

## Stack

TypeScript · `node:sqlite` (no native deps) · SQLite FTS5 · Graphology ·
`@modelcontextprotocol/sdk`. Node 24+. Pluggable `MailSource` adapters; v1 ships
the Gmail adapter (via the `gws` CLI).

## CLI

Two bins ship: `mail-index` (CLI) and `mail-index-mcp` (the stdio MCP server).

```
mail-index init                          Scaffold the operator config + data dir
mail-index sync    --account <a> [--since 30d|1mo] [--all] [--query <q>] [--limit N]
mail-index sync    --all-accounts        Sync every account by its policy presets
mail-index enrich  --account <a> [--profile | --rule direct|all] [--sender <s>] [--match <fts>] [--limit N]
mail-index graph   build [--account <a> | --all-accounts]
mail-index curate  [--account <a>]       Interactive curation wizard (no-agent fallback)
mail-index compact [--account <a>] [--now]   Demote summarized bulk bodies (ADR-0003)
mail-index search  <terms> [--account <a>] [--limit N] [--enrich]
mail-index show    <account:message-id>  Print a message (auto-enriches a meta row)
mail-index open    <account:message-id>  Print the provider web URL (no fetch)
mail-index status  [--json]              Per-account freshness + counts
```

## Documentation

- **[docs/INSTALL.md](docs/INSTALL.md)** — generic onboarding (install,
  authenticate a MailSource, init, sync, curate, enrich, add the MCP server,
  scheduled-sync snippet).
- **[docs/MCP.md](docs/MCP.md)** — the 18-tool MCP reference for agent
  integrators: args, compact result shapes, the `index_as_of` freshness +
  command-handback contracts.
- **[docs/ADAPTERS.md](docs/ADAPTERS.md)** — the `MailSource` contract and how to
  write + contract-test a new adapter.
- **[docs/PLAN.md](docs/PLAN.md)** — the full spec, data model, decisions (ADR
  digest), and roadmap.

## License

MIT
