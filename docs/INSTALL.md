# Installing mail-index

Generic onboarding for **anyone**. This document contains **no real account
data** — every example uses placeholders (`you@example.com`, `acct-a`,
`acct-b`). The accounts, OAuth app, and curated profile you stand up *on top of*
the tool are your private instance (the 2b side of the boundary in
[PLAN.md §2](PLAN.md)); they live in your own dotfiles and data directory, never
in this repo.

> **Prototype-DB note.** If you ran the old single-file prototype, it created an
> **unversioned** SQLite DB at the shared data path. `mail-index` refuses to open
> it (it would collide with the new schema) and prints a clear error. Move it
> aside (`mv ~/.local/share/mail-index/mail.sqlite ~/.local/share/mail-index/mail.sqlite.prototype-bak`)
> or point the tool at a different data dir via `XDG_DATA_HOME`, then re-sync —
> metadata sync is fast, so a fresh sync is the supported migration path.

---

## 0. Requirements

- **Node.js 24+** (the index uses the built-in `node:sqlite` — no native build
  step, no `better-sqlite3`).
- A **MailSource adapter** for your provider. v1 ships the **gws adapter**
  (Gmail via the [`gws`](https://github.com/) Google Workspace CLI). Other
  adapters (DirectGmail, IMAP) are v1.x.

---

## 1. Install the tool

```sh
# Global install
npm i -g mail-index          # or: pnpm add -g mail-index

# …or run without installing
npx mail-index <command>
```

This installs two bins:

| Bin | Purpose |
|-----|---------|
| `mail-index` | the CLI (ops + the fallback curation wizard) |
| `mail-index-mcp` | the stdio MCP server (the agent surface) |

---

## 2. Install + authenticate a MailSource (the gws adapter)

The gws adapter shells out to the `gws` CLI, one isolated config directory per
mailbox. This is the setup friction later adapters remove — it is not
permanent.

1. **Install `gws`** and put it on your `PATH` (the adapter resolves the `gws`
   binary via `PATH`).
2. **Create a provider OAuth app** (a Google Cloud project + OAuth consent
   screen + a desktop OAuth client). Read-only Gmail scope is sufficient —
   mail-index never mutates the mailbox.
3. **Authenticate each mailbox** into its own config directory. Use a distinct
   directory per account so credentials never cross:

   ```sh
   # one config dir per mailbox
   GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws-acct-a gws auth login
   GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws-acct-a gws auth status   # verify

   GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws-acct-b gws auth login
   ```

OAuth tokens and credentials are the adapter's concern — they live in the gws
config dir, **never** in this repo or the index DB.

---

## 3. Scaffold your operator config (`init`)

```sh
mail-index init
```

`init` is idempotent and non-destructive. It:

- creates the index data directory
  (`${XDG_DATA_HOME:-~/.local/share}/mail-index/`), and
- copies the shipped `config.example.json` placeholder to your private config at
  `${XDG_CONFIG_HOME:-~/.config}/mail-index/config.json` **only if one does not
  already exist** (your real accounts are never overwritten).

Then edit that config to map your account **labels** to gws config dirs:

```jsonc
{
  "accounts": {
    "acct-a": {
      "adapter": "gws",
      "configDir": "~/.config/gws-acct-a",
      "syncPolicy": { "since": "1mo", "includeSent": true }
    },
    "acct-b": {
      "adapter": "gws",
      "configDir": "~/.config/gws-acct-b",
      "syncPolicy": { "query": "from:you@example.com", "limit": 5000, "includeSent": false }
    }
  }
}
```

| Field | Meaning |
|-------|---------|
| `adapter` | which MailSource backs the account (`gws` in v1) |
| `configDir` | the per-account `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` (`~` is expanded) |
| `syncPolicy.since` | default lower bound on message age (`30d`, `1mo`, ISO-8601) |
| `syncPolicy.query` | default provider-native filter (e.g. `from:you@example.com`) |
| `syncPolicy.limit` | default cap on enumerated ids |
| `syncPolicy.includeSent` | index Sent metadata too (unlocks replied/initiated signals) |

The config file holds your private accounts — keep it out of version control.

---

## 4. Sync the metadata, then build the graph

Phase-1 sync fetches **only metadata** (headers + snippet + labels) for every
message in scope — roughly 2 KB/message, so a full mailbox finishes in minutes.

```sh
# whole mailbox for one account
mail-index sync --account acct-a --all

# …or every configured account using each account's own policy presets
mail-index sync --all-accounts
```

After a **full/initial** sync, build the derived contact graph (centrality +
Louvain communities over your non-bulk threads):

```sh
mail-index graph build --account acct-a       # or: --all-accounts
```

The graph is a lazy, derived layer — skipping it leaves search and sync fully
functional.

---

## 5. Curate who/what matters

Curation produces the **interest profile** that drives which bodies get
enriched. The primary path is **agent-mediated** through the MCP server
(`interest_propose` → present → `interest_set`). For users without an agent, a
minimal CLI wizard is the fallback:

```sh
mail-index curate --account acct-a
```

It walks the ranked shortlist (top contacts + domains by engagement) and takes a
keep / mute / important / skip decision for each, then collects freeform
interest keywords.

---

## 6. Enrich the bodies that earn their place

Phase-2 enrichment promotes selected metadata-only messages to full distilled
bodies (HTML stripped; quotes, signatures, and tracking junk removed) and
re-indexes them for search:

```sh
# enrich exactly what your curated profile selects
mail-index enrich --account acct-a --profile

# …or the pre-curation heuristic: non-list, non-promo/social mail
mail-index enrich --account acct-a --rule direct
```

`--profile` is the curated policy: important contacts/domains → always, muted →
never, keyword matches → yes. Bodies are also fetched **lazily** on demand —
`mail-index show <ref>` auto-enriches a single message, and `search --enrich`
enriches the hits it returns.

---

## 7. Add the MCP server to your agent

The agent surface is the stdio server `mail-index-mcp`. Register it with your
MCP client. For a Claude Code / Claude Desktop style config:

```jsonc
{
  "mcpServers": {
    "mail-index": {
      "command": "mail-index-mcp"
    }
  }
}
```

**Desktop apps launch with a minimal environment** — two practical notes if the
server fails to start or `get_message` can't enrich:

- **Node:** if you use a version manager (fnm/nvm/asdf), `mail-index-mcp` may not
  be on the app's `PATH`. Point `command` at an absolute Node binary and the
  built entrypoint instead:
  ```jsonc
  {
    "mcpServers": {
      "mail-index": {
        "command": "/abs/path/to/node",
        "args": ["/abs/path/to/mail-index/dist/mcp/index.js"],
        "env": { "PATH": "/dir/with/your/adapter/bin:/usr/local/bin:/usr/bin:/bin" }
      }
    }
  }
  ```
- **Adapter binary:** `get_message`'s inline enrich shells out to the adapter CLI
  (e.g. `gws`). Add the directory holding that binary to the server's `env.PATH`
  (above) so the app can find it. Restart the desktop app after editing the config.

The server is **read-only on the mailbox**: the only provider contact it ever
makes is `get_message`'s single inline body fetch
([ADR-0001](adr/0001-inline-enrichment-is-o1-only.md)). Everything bulk (sync,
enrich, graph build, compact) is returned to the agent as a **command
handback** — the exact `mail-index` CLI command for the agent to run itself. See
[MCP.md](MCP.md) for the full tool reference.

---

## 8. Keep the index fresh — scheduled sync

The MCP server keeps time-sensitive reads honest on its own: a stale `catch_up`
or `digest_sources` returns current data immediately **and** spawns a detached
background sync ([ADR-0005](adr/0005-stale-reads-trigger-background-sync.md)).
That is the *fallback* path. The main path is a **scheduled incremental sync**
so the index is fresh before the agent ever asks.

`mail-index status --json` is the machine-readable freshness probe for a
scheduler.

### launchd (macOS)

Save as `~/Library/LaunchAgents/com.mail-index.sync.plist`, then
`launchctl load` it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.mail-index.sync</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/mail-index</string>
      <string>sync</string>
      <string>--all-accounts</string>
    </array>
    <key>StartInterval</key><integer>1800</integer> <!-- every 30 min -->
    <key>RunAtLoad</key><true/>
  </dict>
</plist>
```

### cron (Linux)

```cron
# every 30 minutes: incremental sync of every configured account
*/30 * * * * /usr/local/bin/mail-index sync --all-accounts >/dev/null 2>&1
```

(Optionally chain a `graph build --all-accounts` and an `enrich --profile` after
the sync on a slower cadence.)

---

## 9. Grow your index intelligently

The whole design is **metadata-wide, bodies-narrow**: index everything cheaply,
fetch full text only where it earns its place. That keeps the index tiny (~1.6 KB
per message — ~1.5% of your mailbox size, since it stores metadata + snippets,
not attachments) and lets you get value in minutes instead of waiting on a full
sync. A sensible growth path:

1. **Start recent and cheap.** A first metadata sync runs ~50 messages/min
   (one provider call each), so don't pull years up front:
   ```sh
   mail-index sync --account acct-a --since 1mo     # minutes; searchable immediately
   ```
2. **Build structure + curate.** Let the engines find who/what matters, then tell
   it what you care about:
   ```sh
   mail-index graph build --account acct-a          # contacts, centrality, communities
   mail-index curate --account acct-a               # mark important / muted + keywords
   ```
3. **Enrich only what matters.** Bodies are fetched selectively from your curated
   profile — the index stays small:
   ```sh
   mail-index enrich --profile --account acct-a
   ```
4. **Expand the window over time.** Re-sync with a larger lookback as a background
   job; sync is incremental and idempotent, so this only fetches what's new/older:
   ```sh
   mail-index sync --account acct-a --since 6mo     # then --since 1y, or --all
   ```
5. **Let summaries keep it lean.** When your agent summarizes bulk mail
   (`save_summary`), `mail-index compact` demotes those distilled bodies to
   summary-only after a grace window — read-once newsletters cost ~0.5 KB forever
   ([ADR-0003](adr/0003-agent-written-summaries-and-body-demotion.md)).
6. **Schedule freshness** (§8) so recent mail stays current without you thinking
   about it.

**Rule of thumb for sizing:** index size ≈ messages × ~1.6 KB (metadata), plus
~1–3 KB for each body you enrich. 10k messages ≈ ~16 MB; enriching 1k of them
≈ +~2 MB. It scales with message *count*, not mailbox bytes.

---

## 10. Privacy & data hygiene

- **Local-first.** The index, bodies, and profile never leave your machine. No
  telemetry, no account, no cloud
  ([ADR-0002](adr/0002-local-index-only-for-privacy.md)).
- **Read-only on the mailbox.** The tool never sends, deletes, labels, or
  archives. "Read-only" means *never mutates* — fetching message content is
  permitted.
- The index DB contains message text — treat
  `${XDG_DATA_HOME:-~/.local/share}/mail-index/` as sensitive. Optional at-rest
  encryption (OS-level FileVault / full-disk encryption) is recommended; the
  tool deliberately avoids a native crypto dependency.
- `.gitignore` excludes any `*.sqlite`, local config, and credentials.
