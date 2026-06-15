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
import { runMigrations } from './migrations.js';

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
 * Resolve the default index path:
 * `${XDG_DATA_HOME:-~/.local/share}/mail-index/mail.sqlite`.
 */
export function defaultDbPath(): string {
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

  if (!options.skipMigrations) {
    runMigrations(db);
  }

  return db;
}
