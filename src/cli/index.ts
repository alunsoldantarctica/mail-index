#!/usr/bin/env node
/**
 * mail-index CLI entry point (SCOPE 0.7, PLAN §13).
 *
 * Hand-rolled subcommand routing over `node:util` parseArgs (zero deps, per the
 * D2 no-friction spirit). The top-level dispatch peels the subcommand off argv,
 * then each command parses its own flags. Commands that touch the index open the
 * DB lazily (so `init`/`--help` never require an existing index) and always
 * close it.
 *
 * Output contract: human-readable text on stdout; errors on stderr with a
 * non-zero exit. The `--json` paths (status) emit machine-readable JSON for the
 * tray/scheduler ladder + ADR-0005.
 */

import { parseArgs } from 'node:util';

import { ConfigError, loadConfig } from '../config/index.js';
import { IndexError, openDb } from '../index/db.js';
import { Repo } from '../index/repo.js';
import { SyncError } from '../ingest/sync.js';

import { formatInit, runInit } from './init.js';
import { formatSyncResult, runSyncAll, runSyncOne, type SyncFlags } from './sync.js';
import { formatResults, runSearchEnriching, type SearchFlags } from './search.js';
import { formatShow, parseRef, runShow, RefError } from './show.js';
import { formatOpen, runOpen } from './open.js';
import { buildStatus, formatStatus, formatStatusJson } from './status.js';

const USAGE = `mail-index — a local, agent-queryable mail intelligence layer

Usage:
  mail-index <command> [options]

Commands:
  init                          Scaffold the operator config + data dir
  sync    --account <label>     Sync message metadata for an account
  search  <terms>               Recall over the index (ranked, snippet-first)
  show    <account:message-id>  Print a message's full record (auto-enriches a meta row)
  open    <account:message-id>  Print the provider web URL for a message (no fetch)
  status                        Show per-account index freshness + counts

Run 'mail-index <command> --help' for command-specific options.
`;

const SYNC_USAGE = `mail-index sync — phase-1 metadata sweep for an account

Usage:
  mail-index sync --account <label> [--since <30d|1mo>] [--all] [--query <q>] [--limit N]
  mail-index sync --all-accounts

Options:
  --account <label>   Account label from the operator config (required unless --all-accounts)
  --since <token>     Lower bound on message age (e.g. 30d, 1mo); overrides the account policy
  --all               Whole mailbox — ignore --since / --limit and the account's policy bounds
  --query <q>         Provider-native search filter (e.g. from:bloomberg.com)
  --limit N           Cap the number of ids the sweep enumerates
  --all-accounts      Sync every configured account using its own policy presets
`;

const SEARCH_USAGE = `mail-index search — ranked recall over the index

Usage:
  mail-index search <terms...> [--account <label>] [--limit N] [--enrich]

Options:
  --account <label>   Restrict the search to one account
  --limit N           Maximum hits to return (default 20)
  --enrich            Enrich the returned hits' bodies, then re-rank (CLI-only; see ADR-0001)
`;

const SHOW_USAGE = `mail-index show — print a message's full record

Usage:
  mail-index show <account:message-id>

A still-meta message is auto-enriched first (one provider fetch → distil →
upsert), then its distilled body is printed (the O(1) inline pattern, ADR-0001).
`;

const OPEN_USAGE = `mail-index open — print a message's provider web URL

Usage:
  mail-index open <account:message-id>

Resolves the ref to its provider deep link (Gmail #all view for gws) and prints
the URL. Does not fetch the message or touch the provider — it only needs the
account's adapter and the message id, so it works even before the message is
indexed.
`;

const STATUS_USAGE = `mail-index status — per-account index freshness + counts

Usage:
  mail-index status [--json]

Options:
  --json   Emit a machine-readable JSON report (for tray/scheduler use)
`;

/** Parse a `--limit`-style integer flag, throwing a CLI error on bad input. */
function parseLimit(raw: string | undefined, flag: string): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new CliError(`${flag} must be a non-negative integer, got "${raw}"`);
  }
  return n;
}

/** A user-facing CLI error: message goes to stderr, exit code 2. */
class CliError extends Error {
  override name = 'CliError';
}

function cmdInit(): number {
  const result = runInit();
  process.stdout.write(formatInit(result));
  return 0;
}

async function cmdSync(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      since: { type: 'string' },
      all: { type: 'boolean' },
      query: { type: 'string' },
      limit: { type: 'string' },
      'all-accounts': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(SYNC_USAGE);
    return 0;
  }

  const flags: SyncFlags = {
    since: values.since,
    all: values.all,
    query: values.query,
    limit: parseLimit(values.limit, '--limit'),
  };

  const config = loadConfig();
  const db = openDb();
  try {
    const repo = new Repo(db);

    if (values['all-accounts']) {
      if (Object.keys(config.accounts).length === 0) {
        throw new CliError('no accounts configured — run mail-index init and edit the config');
      }
      const outcomes = await runSyncAll(config, flags, repo);
      let failures = 0;
      for (const outcome of outcomes) {
        if (outcome.result) {
          process.stdout.write(formatSyncResult(outcome.result) + '\n');
        } else {
          failures += 1;
          process.stderr.write(`${outcome.account}: sync failed — ${outcome.error}\n`);
        }
      }
      return failures > 0 ? 1 : 0;
    }

    if (!values.account) {
      throw new CliError('sync requires --account <label> (or --all-accounts)');
    }
    const result = await runSyncOne(config, values.account, flags, repo);
    process.stdout.write(formatSyncResult(result) + '\n');
    return 0;
  } finally {
    db.close();
  }
}

async function cmdSearch(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      limit: { type: 'string' },
      enrich: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(SEARCH_USAGE);
    return 0;
  }

  if (positionals.length === 0) {
    throw new CliError('search requires one or more terms');
  }

  const flags: SearchFlags = {
    account: values.account,
    limit: parseLimit(values.limit, '--limit'),
    enrich: values.enrich,
  };

  // `--enrich` reaches the provider, so it needs the operator config (account →
  // adapter). A plain search never opens the config — pass an empty one, which
  // runSearchEnriching ignores when `enrich` is unset (it returns plain hits).
  const config = values.enrich ? loadConfig() : { accounts: {} };
  const db = openDb();
  try {
    const repo = new Repo(db);
    const rows = await runSearchEnriching(config, repo, positionals, flags);
    process.stdout.write(formatResults(rows, positionals));
    return 0;
  } finally {
    db.close();
  }
}

async function cmdShow(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(SHOW_USAGE);
    return 0;
  }

  if (positionals.length === 0) {
    throw new CliError('show requires a <account:message-id> reference');
  }
  if (positionals.length > 1) {
    throw new CliError('show takes a single <account:message-id> reference');
  }

  const ref = parseRef(positionals[0]!);
  const config = loadConfig();
  const db = openDb();
  try {
    const repo = new Repo(db);
    const result = await runShow(config, repo, ref);
    process.stdout.write(formatShow(result));
    return 0;
  } finally {
    db.close();
  }
}

function cmdOpen(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(OPEN_USAGE);
    return 0;
  }

  if (positionals.length === 0) {
    throw new CliError('open requires a <account:message-id> reference');
  }
  if (positionals.length > 1) {
    throw new CliError('open takes a single <account:message-id> reference');
  }

  const ref = parseRef(positionals[0]!);
  const config = loadConfig();
  const db = openDb();
  try {
    const repo = new Repo(db);
    const result = runOpen(config, repo, ref);
    process.stdout.write(formatOpen(result));
    return 0;
  } finally {
    db.close();
  }
}

function cmdStatus(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(STATUS_USAGE);
    return 0;
  }

  const db = openDb();
  try {
    const repo = new Repo(db);
    const report = buildStatus(repo);
    process.stdout.write(values.json ? formatStatusJson(report) : formatStatus(report));
    return 0;
  } finally {
    db.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command == null || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (command) {
    case 'init':
      return cmdInit();
    case 'sync':
      return cmdSync(rest);
    case 'search':
      return cmdSearch(rest);
    case 'show':
      return cmdShow(rest);
    case 'open':
      return cmdOpen(rest);
    case 'status':
      return cmdStatus(rest);
    default:
      process.stderr.write(`unknown command "${command}"\n\n`);
      process.stderr.write(USAGE);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (
      err instanceof ConfigError ||
      err instanceof IndexError ||
      err instanceof SyncError ||
      err instanceof CliError ||
      err instanceof RefError
    ) {
      process.stderr.write(`error: ${err.message}\n`);
    } else if (err instanceof Error) {
      process.stderr.write(`error: ${err.message}\n`);
    } else {
      process.stderr.write(`error: ${String(err)}\n`);
    }
    process.exit(2);
  });
