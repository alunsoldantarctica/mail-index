# Threat model

mail-index indexes a mailbox into a local database and exposes it to an AI agent
over a local MCP server. It touches sensitive data (your email), so this document
states plainly what it protects, what it does **not**, where the trust boundaries
are, and how you can verify the claims yourself ([SECURITY.md](../.github/SECURITY.md#verify-our-claims-yourself)).

## Assets

- **The index** (`${XDG_DATA_HOME:-~/.local/share}/mail-index/mail.sqlite`) —
  message metadata, distilled bodies, and summaries. Plaintext SQLite.
- **The curated profile** — who/what you marked important (in the same DB).
- **Provider credentials** — OAuth tokens. **mail-index never holds these.**
  They live in the adapter's own store (for gws, its per-account config dir).

## Trust boundaries & data flow

```
  Gmail API                ┌───────────────── your machine ─────────────────┐
 (googleapis.com)          │                                                 │
      ▲                    │   ingest ─► SQLite index ─► engines (graph,     │
      │  read-only         │     ▲        (local file)     interest, search) │
      │  list / get        │     │                              │            │
 ┌────┴─────┐  spawn       │ ┌───┴─────────┐              ┌─────┴──────┐     │
 │ gws CLI  │◄─────────────┼─┤  adapter    │              │ CLI / MCP  │◄────┼─ your agent
 │(adapter) │              │ │ (1 file)    │              │  server    │     │   (your LLM)
 └──────────┘              │ └─────────────┘              └────────────┘     │
   the ONLY                │   no network                   no network       │
   network egress          └─────────────────────────────────────────────────┘
```

**The egress boundary is one process spawn.** The mail-index *core* (`src/`)
makes no network calls of any kind. The only way the core reaches the network is
by spawning the provider adapter CLI (the gws adapter, `src/source/adapters/gws/runner.ts`).
This is enforced as a build-breaking test ([`test/egress-guard.test.ts`](../test/egress-guard.test.ts)):
CI fails if any network primitive (`fetch`, `node:http/https/net`, a network
library, a telemetry SDK) appears anywhere in `src/`, or if a process is spawned
outside the audited seams (the adapter, and the MCP server's detached re-exec
of mail-index's own `sync` CLI per [ADR-0005](adr/0005-stale-reads-trigger-background-sync.md)).
This guard governs *network egress and spawn seams* — not read-vs-mutate. The
opt-in archive/label writes ([ADR-0007](adr/0007-opt-in-mailbox-writes.md)) flow
through the *same* adapter spawn seam, so they pass the guard unchanged; whether
a write can happen at all is enforced one layer up, at the OAuth scope (a default
`gmail.readonly` grant cannot mutate).

**One auditable self-update seam, quarantined outside the core.** The launch
shim (`bin/`) performs an optional, throttled (once / 24h), opt-out self-update
check: it asks the npm registry whether a newer `mail-index` is published and, if
so, updates the install for the *next* launch (it never touches the running
process, so the core never gains network access at runtime). This is the only
other network seam, and it is deliberately kept out of `src/` so the core stays
provably egress-free. The egress guard scans `bin/` too and pins network access
to exactly one file (`bin/selfupdate.mjs`) and spawning to the updater plus the
launcher that fires it. Disable entirely with `MAIL_INDEX_NO_AUTOUPDATE=1`.

## What mail-index protects

- **No exfiltration by the tool.** It has no network egress of its own and no
  telemetry/analytics — verifiable by the egress guard and a 4-package, pure-JS
  dependency tree.
- **No mailbox mutation by default — and never send/delete.** A standard install
  is read-only at the token level (`gmail.readonly`): the adapter calls only
  `messages.list` / `messages.get`, and the mutation seam is unreachable.
  Archive + label edits are an explicit OPT-IN gated on a separate, least-
  privilege `gmail.modify` re-auth (`mail-index setup --enable-writes`), exposed
  as two clearly-marked tools (`archive_message` / `modify_labels`). Even opted
  in, the tool can only archive/relabel — it requests no `gmail.send` and no
  delete scope ([ADR-0007](adr/0007-opt-in-mailbox-writes.md), [ADR-0001](adr/0001-inline-enrichment-is-o1-only.md)).
- **No credential handling.** Tokens are the adapter's concern, never stored by
  mail-index or written to the index DB.
- **Local-only data.** The index never leaves the machine; no cloud, account, or
  sync ([ADR-0002](adr/0002-local-index-only-for-privacy.md)).

## What it does NOT protect against (non-goals)

- **A compromised machine or OS.** The index is plaintext SQLite; anyone with read
  access to your data dir can read indexed mail. Use full-disk encryption
  (FileVault/LUKS) or an encrypted volume; SQLCipher is an opt-in you layer on.
- **A malicious or careless agent you connect.** mail-index returns mail content
  to *your* agent; it cannot police what that agent (or the other tools you give
  it) does with the content. Connect it alongside tools you trust.
- **Prompt injection of your agent.** Email is attacker-controlled input. A
  crafted message could try to manipulate the LLM reading it. mail-index's stance:
  it returns email strictly as **data**, has **no** write/exfiltration tools, and
  builds every command-handback from **fixed code templates — never from message
  content** — so injected text cannot make mail-index act or forge a command. The
  residual risk lives in your agent and its *other* tools; treat all returned mail
  as untrusted content.
- **Supply-chain compromise of Node or dependencies.** Mitigated, not eliminated:
  minimal deps, committed lockfile, `--ignore-scripts` installs (no postinstall),
  CI dependency audit + secret scan, and SHA-pinned GitHub Actions.

## Permissions / least privilege

mail-index only ever reads. Grant the adapter a **read-only** provider scope
(for Gmail, `https://www.googleapis.com/auth/gmail.readonly`) — the tool never
calls a mutating endpoint, so a read-only token is sufficient and is what we
recommend.

## Integrity & releases

The npm package is published with **provenance** (a signed attestation linking
the artifact to this repo + the building workflow), from a SHA-pinned GitHub
Actions release. See [PUBLISHING.md](PUBLISHING.md). Verify with
`npm audit signatures` after install.

## Reporting

Security issues: see [SECURITY.md](../.github/SECURITY.md) — please report privately
rather than opening a public issue.
