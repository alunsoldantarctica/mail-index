# All LLM intelligence comes from the user's own LLM; the tool ships none

Anything requiring language understanding — summarization, digest composition,
curation conversation, topic naming — is performed by the **user's own agent**
(whatever LLM they already run: Claude, Codex, anything MCP-capable) and flows
back into the index through write-back tools like `save_summary`. The tool
itself bundles no models, calls no inference APIs, and embeds no ML runtime.
Deterministic code handles what determinism can (classification from
labels/headers, HTML distillation, engagement scoring); the user's LLM —
reached via MCP — handles the rest. **Local models are not ruled out for
future iterations** (e.g. embeddings for topics, on-device summarization); for
now, no bundled inference. Chosen over bundling local models today: it keeps
the tool dependency-light (D2), keeps every token of mail content under the
user's existing agent configuration and trust boundary (ADR-0002), and means
intelligence quality rides the user's model choice instead of a frozen bundled
one. Consequence: nothing "smart" happens unattended inside the tool — a sync
without an agent produces metadata, scores, and heuristics, never prose.
