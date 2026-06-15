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
