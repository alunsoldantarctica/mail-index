# Stale time-sensitive reads return immediately and trigger a background sync

When a time-sensitive MCP tool (`catch_up`, `digest_sources`) finds the index
past the staleness threshold (configurable per account, default ~12 h), it does
NOT block and does NOT merely hand back a command: it returns the current
(stale) data immediately — flagged with `index_as_of` and `sync_started: true`
— and spawns a **detached incremental `mail-index sync`** for the affected
account(s). The agent re-queries seconds later for fresh data.

Guardrails: the spawned process is the ordinary CLI (fire-and-forget, no
daemon — "the CLI is the execution engine" survives); at most one sync per
account at a time (in-progress `sync_runs` row acts as the lock); a debounce
window prevents re-trigger storms from agent loops; the sync is incremental
(`--since` last run), never a full sweep; SQLite runs in WAL mode so the single
background writer never blocks MCP reads. Timeless tools (`find_person`,
`graph_*`, archival `search`) never trigger syncs — they carry freshness
metadata quietly. Every tool response includes `index_as_of` regardless.

**Feedback contract** (how the LLM knows to check back): the stale response
carries `sync_started: true`, `eta_seconds` (estimated from recent `sync_runs`
durations), and instructional text telling the agent to poll `sync_status()`
or simply re-call the tool after the ETA. MCP progress notifications are not
used — they only live within a single request, and holding the call open is
exactly the blocking we forbid. True push lands in v1.x via an MCP resource
(`mailindex://sync/status`) with `resources/updated` subscription
notifications, once client support matures; the status shape is designed now
so subscriptions bolt on without contract changes.

## Amendment (2026-07-01): freshness block on every response; auto-refresh generalised to every account-scoped read

Two changes, driven by an agent burning several turns on a 6-day-stale index
that a plain `search` never refreshed:

1. **Freshness on every response, not just a bare `index_as_of`.** Every tool
   result now carries a `freshness` block — `{ index_as_of, age_seconds, stale,
   syncing, refresh_command }` — so the agent always knows how stale the data is
   and the exact command to refresh it, without computing age itself.

2. **Any stale account-scoped read auto-refreshes** — the trigger moved out of
   the `catch_up` / `digest_sources` composites and into `withMeta`, the single
   stamp every response passes through. The original "archival `search` never
   triggers a sync" rule is retired: the cost of a debounced, detached,
   incremental sync is negligible, and a silently-stale `search` is the exact
   failure this ADR exists to prevent. When the caller omits `account` on a
   single-mailbox install, freshness and the refresh are scoped to that sole
   mailbox; a genuine multi-account cross read still stamps the oldest timestamp
   and spawns nothing (no single account to pick).

The staleness threshold drops from ~12 h to **3 h** ("a few hours"). All other
guardrails stand unchanged: one sync per account (the `sync_runs` lock), the
debounce, incremental `--since`, WAL-mode single writer, and the `sync_started`
+ `eta_seconds` feedback contract.

**Dead-lock timeout.** The lock is an unfinished `sync_runs` row, so a sync that
crashes without closing its row would wedge the account forever — blocking both
manual syncs and this auto-refresh (observed in the wild: a row stuck for six
days). `Repo.activeSyncRun` now ignores rows whose `started_at` is older than
`STALE_LOCK_MS` (6 h — above the longest legitimate initial sweep), so a crashed
lock self-clears within a day while a live long sync is never reaped.
