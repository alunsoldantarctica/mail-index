# The index is local-only, for privacy

The index — message metadata, bodies, summaries, the interest profile, all of
it — lives in a single SQLite file on the user's machine and never leaves it.
No cloud storage, no sync service, no hosted option, no telemetry, no account.
The tool's only network traffic is read-only fetches from the mail provider's
API. This is deliberately chosen over the convenience of a hosted/synced index
(multi-device access, server-side processing): a mailbox is among the most
sensitive datasets a person has, and the product's trust posture is "your mail
intelligence never leaves your machine." Consequences: multi-device users run
one index per machine (or move the file themselves); any LLM processing of
indexed content happens through the user's own agent, under the user's own
agent configuration — the tool itself never calls an LLM or any third-party
service. Treat `~/.local/share/mail-index/` as sensitive; at-rest encryption is
documented opt-in (OS-level FileVault/LUKS or SQLCipher), not a bundled dep.
