# MCP tools enrich inline only for O(1); O(N) returns a command handback

The MCP server is "read-only on the mailbox" — meaning it never *mutates* mail,
not that it never *fetches*. A tool call may perform a bounded, single-message
provider fetch inline (`get_message` on a `meta` row does one `format=full`
fetch, ~1–3 s) because answering "what did that email say?" mid-conversation is
the product promise. Anything O(N) — bulk body fetches, policy sweeps — never
runs inline. Instead the tool returns a **command handback**: the exact
`mail-index enrich …` invocation that fetches precisely the needed content,
which the agent runs itself via its shell (agents with MCP access overwhelmingly
also have shell access). This kills the need for a daemon or an in-server job
queue in v1: the CLI is the execution engine, the MCP is the brain that knows
which command to run. The line is: **O(1) network calls inline, O(N) handed
back as a command.** Consequence: `request_enrich` is dropped in favor of
handbacks; `search`'s per-hit `enrich` option is dropped (agents enrich a
specific hit via `get_message`).
