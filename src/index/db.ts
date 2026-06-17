/**
 * Database open + lifecycle (SCOPE 0.2, ADR-0005).
 *
 * Opens the single SQLite file at
 * `${XDG_DATA_HOME:-~/.local/share}/mail-index/mail.sqlite`, enables WAL mode
 * (ADR-0005: a single background writer never blocks MCP reads), and runs all
 * pending migrations on open. Tests pass an explicit path (`:memory:` or a
 * tmp file) to avoid touching the operator's real index.
 *
 * Uses the built-in `node:sqlite` (`DatabaseSync`) — no native deps (D2).
 */

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getUserVersion, runMigrations } from './migrations.js';

/** Error thrown for index-layer failures (open, migrate, repo invariants). */
export class IndexError extends Error {
  override name = 'IndexError';
}

export interface OpenOptions {
  /**
   * Explicit database path. `:memory:` for an ephemeral in-memory DB (tests).
   * When omitted, the default XDG path is used.
   */
  path?: string;
  /** Skip running migrations on open (rarely needed; tests of migrations). */
  skipMigrations?: boolean;
}

/**
 * Resolve the default index path. Precedence:
 *
 *  1. `MAIL_INDEX_DB` — an explicit DB file path. This is the seam for ISOLATING
 *     a dev/worktree index from the production one: every worktree + the
 *     installed CLI/MCP otherwise share the single default DB, so a forward
 *     migration run from any worktree bumps `user_version` past what the
 *     installed (older) build supports and breaks it. Point each worktree at its
 *     own file (e.g. `<worktree>/.mail-index-dev.sqlite`) and only the install
 *     touches the real index.
 *  2. `${XDG_DATA_HOME:-~/.local/share}/mail-index/mail.sqlite` — the default.
 */
export function defaultDbPath(): string {
  const explicit = process.env['MAIL_INDEX_DB'];
  if (explicit && explicit.trim() !== '') return explicit;
  const xdg = process.env['XDG_DATA_HOME'];
  const base = xdg && xdg.trim() !== '' ? xdg : join(homedir(), '.local', 'share');
  return join(base, 'mail-index', 'mail.sqlite');
}

/**
 * Open (creating if needed) the index database. Enables WAL + foreign keys,
 * runs migrations, and returns the live connection. The caller owns closing it.
 */
export function openDb(options: OpenOptions = {}): DatabaseSync {
  const path = options.path ?? defaultDbPath();
  const inMemory = path === ':memory:';

  if (!inMemory) {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (err) {
      throw new IndexError(
        `failed to create index directory for ${path}: ${(err as Error).message}`,
      );
    }
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (err) {
    throw new IndexError(`failed to open index at ${path}: ${(err as Error).message}`);
  }

  // WAL is meaningless for :memory: and SQLite silently keeps it in `memory`
  // journal mode there, so only request it for file-backed databases.
  if (!inMemory) {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  // Guard against opening the old single-file prototype DB (M1 carry-over). The
  // prototype created a `messages` table without ever setting `user_version`, so
  // a fresh-looking version-0 database that *already* contains app tables is not
  // an empty DB the migrations can build into — running migration 1 would fail
  // deep inside SQLite with a bare "table messages already exists". Detect that
  // shape up front and emit an actionable IndexError instead.
  if (!options.skipMigrations) {
    if (getUserVersion(db) === 0 && hasAppTables(db)) {
      throw new IndexError(
        `found a pre-existing un-versioned database at ${path} — looks like the old ` +
          `prototype; move it aside (e.g. rename to ${path}.prototype-bak) or set a ` +
          `different data dir (XDG_DATA_HOME) before running mail-index`,
      );
    }
    runMigrations(db);
  }

  return db;
}

/**
 * Whether the database already carries this app's tables — used only to detect
 * the un-versioned prototype DB (see {@link openDb}). Checks for the `messages`
 * table, which both the prototype and the current schema create.
 */
function hasAppTables(db: DatabaseSync): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'`)
    .get() as { name: string } | undefined;
  return row != null;
}
