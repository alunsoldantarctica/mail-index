# Security & Privacy

mail-index handles one of the most sensitive datasets a person has — their
mailbox. Its design reflects that.

## Privacy posture (by design)

- **Local-first.** The index, message bodies, summaries, and your curated profile
  live in a single SQLite file on your machine
  (`${XDG_DATA_HOME:-~/.local/share}/mail-index/mail.sqlite`) and never leave it.
  No cloud, no account, no telemetry, no hosted option ([ADR-0002](docs/adr/0002-local-index-only-for-privacy.md)).
- **Read-only on the mailbox.** The tool never sends, deletes, labels, or archives
  mail. Its only provider traffic is read fetches; the MCP server exposes no
  mutation tools ([PLAN §14](docs/PLAN.md)).
- **No third-party calls, no bundled LLM.** All language work (summaries,
  categorization) is done by *your* agent via MCP and written back; the tool
  itself calls no inference API ([ADR-0004](docs/adr/0004-all-intelligence-from-the-users-llm.md)).
- **The tool ships none of your data.** This repo is the generic tool; your
  accounts, OAuth app, and curated profile are private operator config kept in
  your own dotfiles ([PLAN §2](docs/PLAN.md)). `.gitignore` excludes
  `*.sqlite`, credentials, `*.env`, and `*.local.md`.

## Treat the index as sensitive

`mail.sqlite` contains real message text. Treat
`~/.local/share/mail-index/` as sensitive data:

- Rely on full-disk encryption (FileVault / LUKS), or place the data dir on an
  encrypted volume. At-rest DB encryption (e.g. SQLCipher) is an opt-in you can
  layer on; it is not bundled (it would add a native dependency).
- Never commit the DB, your operator `config.json`, or `*.local.md` files.

## Credentials

OAuth tokens and client secrets are the **adapter's** concern and live in the
provider tool's own store (for the gws adapter, its per-account config dir) —
never in this repo and never in the index DB. Never paste tokens into issues
or PRs.

## Reporting a vulnerability

Please report security issues privately to the maintainer via
**[unsold.group/al](https://unsold.group/al)** rather than opening a public
issue. You'll get an acknowledgement and a fix timeline. Thanks for disclosing
responsibly.
