# How mail-index differs from a stock Gmail MCP — and why it's lighter

Most "Gmail for agents" MCPs are a thin wrapper over the Gmail REST API:
`search_emails` (Gmail query syntax), `read_email` (`messages.get`), plus
send/label/delete. They are **lookup tools**: the agent must already know the
exact query, every answer is a network round-trip, and the model pays for raw
message envelopes streamed into its context.

mail-index is a **recall tool** over a local index built for the way people
actually ask. That difference shows up as fewer tokens on both axes an MCP
server taxes: the fixed tool-schema cost paid every turn, and the per-question
result cost.

## The structural difference

| | Stock Gmail-API MCP | mail-index |
|---|---|---|
| Backing store | none — live API per call | local SQLite + FTS5 index |
| Find a message | exact Gmail query; `list` returns **ids only** | fuzzy ranked FTS; one call returns snippet rows |
| Vague question ("that rooftop thing") | 0 results or many query guesses | ranks the likely message first |
| Read a message | `messages.get?format=full` → full MIME (headers[], base64 parts) | distilled plain text / summary, snippet-first |
| Entity entry points | none (query only) | `find_person`, `list_contacts`, graph, **correspondents first** |
| Network per question | one+ round-trips, every time | none for recall; one bounded fetch only to read a still-unindexed body |
| "What did I miss" | not a primitive | `catch_up` / `digest_sources` composites |

## The token cost (measured against a real mailbox)

Reproduce with [`bench/`](../bench/README.md): `node bench/run.mjs`.

**Read one message** — the cleanest, most one-sided comparison:

| | Tokens to put one message in context |
|---|--:|
| Gmail `messages.get?format=full` (raw payload) | ~5,600 |
| Gmail `format=metadata` (headers only, still raw) | ~2,200 |
| mail-index `get_message` (distilled, snippet-first) | ~170 |

→ roughly **30× lighter** to read a message, because a raw Gmail payload is
base64 bodies, MIME parts, and a full header array — almost none of which the
model needs.

**Find something** — the round-trip tax:

| | Tokens to see 5 candidate results |
|---|--:|
| Gmail `messages.list` (ids only) → `get` each to read snippets | ~10,000+ |
| mail-index `search` (one ranked, snippet-first call) | ~550 |

→ Gmail's `list` returns no snippets, so the agent must fetch each candidate just
to *see what it is*. mail-index returns ranked snippets in a single call.

**Fixed schema tax** (injected every turn): mail-index's 18 tools cost ~1,900
tokens of schema — comparable to a full Gmail MCP's send/label/delete surface,
but every one of mail-index's tools serves *recall*, not mailbox mutation.

## Why it's also faster (wall-clock, not just tokens)

- **No network on the hot path.** Recall hits a local SQLite index; a stock Gmail
  MCP makes a REST round-trip for every `search` and every `read`.
- **One call, not a dance.** Answering "what did the recruiter say?" is one
  `search` (or `find_person` → `get_message`), versus list → get → get … until
  the model spots the right message.
- **Bounded reads.** The only time mail-index touches the provider is a single
  `get_message` body fetch for a message that isn't enriched yet (ADR-0001);
  everything bulk is handed back as a CLI command, never blocking the agent.

The point isn't that the Gmail API is bad — it's that an *agent* shouldn't pay
context and latency to re-discover, re-fetch, and re-parse a mailbox on every
question. That's what an index is for.
