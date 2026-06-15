# mail-index — Development Scope (v0.x → v1.0) — ✅ v1.0 SHIPPED 2026-06-16

All four milestones built, committed to main, verified (build + lint clean, full
node:test suite green), and dogfooded live against real Gmail. The MCP server
boots over stdio and serves the full 18-tool surface. M0 (UNS-1207), M1
(UNS-1215), M2 (UNS-1220), M3 (UNS-1224) and all sub-issues closed.



Derived from [PLAN.md](PLAN.md). Status: filed in Linear (team UNS,
2026-06-10): **M0 = UNS-1207** (subs 1208–1214), **M1 = UNS-1215** (subs
1216–1219), **M2 = UNS-1220** (subs 1221–1223), **M3 = UNS-1224** (subs
1225–1231).

Baseline: 493-line single-file prototype (`~/bin/mail-index`, CJS) that already
proves two-phase sync, classification, FTS5 search, show/open/status — but
shells out to `/usr/bin/sqlite3` (violates D2), hardcodes the operator's three
accounts (violates the 2a/2b boundary), and has no tests, no graph, no interest
engine, no curation, no MCP.

---

## Milestone 0 — Tracer bullet (vertical slice) ✅ SHIPPED 2026-06-15

Goal: `npx mail-index sync --account X && mail-index search "foo"` works
end-to-end in the new layered TS codebase, for one account, with tests.
Everything else stacks on this.

**Done.** Commits `1ce2473..ff0b5e2` on main; 120 tests pass, build + lint
clean; cold-review verdict *solid*. Verified live against real Gmail (synced 5
personal messages, FTS search + `status --json` confirmed). New ADR-0006
(self-contained FTS5). Carry-over for M1: `openDb` should detect a pre-existing
**unversioned** DB (old prototype at the shared path) and emit a clear error
instead of the raw `table messages already exists` (the prototype DB is now at
`mail.sqlite.prototype-bak`).

| # | Work item | Notes / acceptance |
|---|---|---|
| 0.1 | **Repo scaffold** | TS, `package.json` (two bins declared, MCP bin stubbed), tsconfig, node:test or vitest, lint/format, CI (lint+test), `.gitignore` already present. Node 24 engines field. |
| 0.2 | **Index layer** (`src/index/`) | Schema from PLAN §6 on `node:sqlite`; migrations (versioned, forward-only); FTS5 external-content table; repo module with typed upserts. Decision needed: migrate the prototype DB or document re-sync. |
| 0.3 | **`MailSource` interface** (`src/source/`) | `listIds(scope) / getMetadata(ids) / getFull(id)` + auth/identity probe. Contract test harness with recorded fixtures (PLAN §19). |
| 0.4 | **`GwsAdapter`** (`src/source/adapters/gws/`) | Wraps gws CLI. Account label → adapter config comes from an operator config file (e.g. `~/.config/mail-index/config.json`) — *nothing hardcoded*. Handles the `metadataHeaders` pitfall (PLAN §8 note). |
| 0.5 | **Classification** (`src/ingest/classify.ts`) | category / is_list / direction, pure functions, unit tests. Port from prototype. |
| 0.6 | **Sync phase 1** (`src/ingest/sync.ts`) | Metadata sync, incremental + idempotent, `sync_runs` audit rows, snapshot unread/starred/important. |
| 0.7 | **CLI skeleton** (`src/cli/`) | `init`, `sync`, `search`, `status`. Arg parsing, account resolution, output formatting. |

## Milestone 1 — Enrichment + remaining CLI (completes v0.x)

| # | Work item | Notes |
|---|---|---|
| 1.1 | **Enrich phase 2** | `--rule direct` heuristic, `--sender`, `--match`, `--limit`; HTML→text extraction (unit-tested); never downgrade `full`→`meta`; FTS re-index. |
| 1.2 | **Lazy enrichment** | `show <ref>` auto-enrich; `search --enrich`. |
| 1.3 | **`open` + multi-account sweep** | `open <ref>` provider URL; `sync --all-accounts` driven by per-account policy presets in operator config. |
| 1.4 | **Integration test** | sync→enrich→search over synthetic fixture mailbox; assert counts + FTS hits. |

## Milestone 2 — Intelligence (v1.0 core)

| # | Work item | Notes |
|---|---|---|
| 2.1 | **Sent-mail indexing** (D11) | Metadata-only; unlocks replied/initiated signals; `direction` + `threads.user_participated`. |
| 2.2 | **Interest engine** (`src/interest/`) | Weighted score (PLAN §10), recompute each sync, `contact_stats_snapshot` append from day one (D12). Scoring math unit-tested. |
| 2.3 | **Graph engine** (`src/graph/`) | Graphology; co-recipiency edges on `is_list=0` threads (D9); centrality + Louvain; persist back to `contacts`; `graph build` command, auto-run after full sync only (D10). |

## Milestone 3 — Curation + MCP (v1.0 thesis)

| # | Work item | Notes |
|---|---|---|
| 3.1 | **Curation core** (`src/curation/`) | `interest_profile` persistence; propose() shortlist generator; set() applying contact/domain curation + keywords. |
| 3.2 | **Profile-driven enrichment** | `enrich --profile`: important→always, muted→never, keyword FTS matches→yes. |
| 3.3 | **CLI curate wizard** | Minimal interactive fallback (D14). |
| 3.4 | **MCP server** (`src/mcp/`) | stdio, `@modelcontextprotocol/sdk`; PLAN §12 tool surface; golden-response tests against seeded fixture DB. Decide `request_enrich` semantics (queue vs reject) — leaning: enqueue a request row the CLI services, never block. **Design tests:** (a) *recall, not lookup* — every tool must work from a vague starting point (fuzzy ranked FTS, entity entry points by contact/domain, near-misses return ranked neighbors, never a bare empty set), not just an exact key; this is the differentiator vs query-based Gmail MCPs. (b) *token-budget-conscious by default* — compact result shapes, snippet-first, explicit opt-in for full bodies, sensible default limits. |
| 3.5 | **Write-back loops** (ADR-0003/0004) | `save_summary` (message + thread), summary columns + FTS, demotion eligibility, `compact` command with grace window (sync auto-invokes); `domains_to_categorize` / `save_domain_category` + `domains.category`. |
| 3.6 | **Freshness + background sync** (ADR-0005) | `index_as_of` on every response; stale time-sensitive tools return immediately + spawn detached incremental sync; `sync_started`/`eta_seconds` feedback contract; WAL mode; sync lock + debounce. `status --json` + INSTALL cron/launchd snippet. |
| 3.7 | **Docs** | INSTALL.md (placeholders), MCP.md (tool reference), ADAPTERS.md (contract + how to write one). README refresh. |

## Explicitly out of scope (deferred per PLAN §18)

Topics/embeddings, person-unification, trend queries (v1.1) · DirectGmailAdapter,
single-binary, IMAP, daemon, MCP elicitation (v1.x) · Rust (v2).

---

## Decisions (resolved 2026-06-10)

1. **Operator account config: JSON file** —
   `~/.config/mail-index/config.json` → `{ accounts: { "<label>": { adapter: "gws", configDir: "...", syncPolicy: {...} } } }`.
   Scaffolded by `init`; never committed; the tool ships only the schema +
   placeholder example.
2. **Prototype DB: fresh re-sync.** No migration code; metadata sync is
   minutes. Keep the prototype DB on disk until the new tool reaches parity.
3. **CLI parsing: `node:util` parseArgs** — zero deps, hand-rolled subcommand
   routing, per the no-friction spirit of D2.
4. **Linear issues: not yet.** Iterate SCOPE.md first; file issues in a later
   session (M0-only filing preferred at that point).

## Still open (decide at the affected milestone)

- **`request_enrich` execution model** (blocks 3.4) — PLAN §20 leans CLI-first.
- PLAN §20 carry-overs: name, license confirm (MIT), public-at-v1.0.

## Suggested sequencing

M0 items are mostly serial (0.1 → 0.2/0.3 parallel → 0.4 → 0.5/0.6 → 0.7).
M1 serial after M0. M2 items 2.1→2.2 serial, 2.3 parallel to 2.2. M3 after M2
(curation consumes scores). Docs (3.5) parallel to everything in M3.
