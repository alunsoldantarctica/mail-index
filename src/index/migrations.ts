/**
 * Versioned, forward-only migrations (SCOPE 0.2, PLAN §6).
 *
 * Each migration has a monotonically increasing `version` and an `up(db)` that
 * runs its DDL. `runMigrations` applies every migration whose version exceeds
 * the database's current `user_version` pragma, in order, inside a single
 * transaction, then bumps `user_version`. Migrations are append-only: never
 * edit or reorder an existing one — add a new one.
 *
 * The FTS5 table is external-content over `messages` (PLAN §6): it stores no
 * copy of the columns itself; instead the repo layer keeps it in sync via
 * explicit INSERT/DELETE against the contentless index (we deliberately do NOT
 * use FTS5 content-sync triggers, so the repo controls exactly what the FTS
 * `body` column holds across the meta → full → summary-only ladder).
 */

import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

/** Migration 1 — full PLAN §6 data model. */
const m001_initial: Migration = {
  version: 1,
  name: 'initial schema',
  up: (db) => {
    db.exec(`
      CREATE TABLE messages (
        account             TEXT    NOT NULL,
        gmail_message_id    TEXT    NOT NULL,
        thread_id           TEXT,
        internal_date       INTEGER,
        date_header         TEXT,
        from_addr           TEXT,
        to_addr             TEXT,
        cc_addr             TEXT,
        subject             TEXT,
        labels_json         TEXT,
        category            TEXT,
        is_list             INTEGER NOT NULL DEFAULT 0,
        direction           TEXT    NOT NULL DEFAULT 'received',
        unread              INTEGER NOT NULL DEFAULT 0,
        starred             INTEGER NOT NULL DEFAULT 0,
        important           INTEGER NOT NULL DEFAULT 0,
        size_estimate       INTEGER,
        snippet             TEXT,
        body_state          TEXT    NOT NULL DEFAULT 'meta',
        body_text           TEXT,
        summary_text        TEXT,
        summary_is_model    INTEGER NOT NULL DEFAULT 0,
        summarized_at       TEXT,
        gmail_url           TEXT,
        indexed_at          TEXT,
        body_fetched_at     TEXT,
        PRIMARY KEY (account, gmail_message_id)
      );

      CREATE INDEX idx_messages_thread   ON messages (account, thread_id);
      CREATE INDEX idx_messages_internal ON messages (account, internal_date);
      CREATE INDEX idx_messages_from     ON messages (account, from_addr);
      CREATE INDEX idx_messages_state    ON messages (account, body_state);

      -- FTS5 search index over messages, keyed by messages.rowid. The repo
      -- writes the searchable text explicitly (DELETE+INSERT by rowid) so it
      -- controls exactly what the \`body\` column holds across the
      -- meta → full → summary-only ladder (PLAN §6) — which is why this is a
      -- self-contained FTS5 table rather than a contentless/external-content
      -- one (contentless FTS5 cannot delete a row by rowid alone, and \`body\`
      -- is a computed column that has no single source column to mirror).
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        subject,
        sender,
        recipients,
        body
      );

      CREATE TABLE contacts (
        account           TEXT    NOT NULL,
        address           TEXT    NOT NULL,
        display_name      TEXT,
        domain            TEXT,
        person_id         INTEGER,
        msgs_received     INTEGER NOT NULL DEFAULT 0,
        msgs_sent         INTEGER NOT NULL DEFAULT 0,
        read_count        INTEGER NOT NULL DEFAULT 0,
        replied_count     INTEGER NOT NULL DEFAULT 0,
        initiated_count   INTEGER NOT NULL DEFAULT 0,
        starred_count     INTEGER NOT NULL DEFAULT 0,
        important_count   INTEGER NOT NULL DEFAULT 0,
        first_seen        TEXT,
        last_seen         TEXT,
        engagement_score  REAL,
        centrality        REAL,
        community_id      INTEGER,
        curation          TEXT,
        PRIMARY KEY (account, address)
      );

      CREATE INDEX idx_contacts_domain ON contacts (account, domain);
      CREATE INDEX idx_contacts_score  ON contacts (account, engagement_score);

      CREATE TABLE domains (
        account           TEXT    NOT NULL,
        domain            TEXT    NOT NULL,
        msgs              INTEGER NOT NULL DEFAULT 0,
        distinct_contacts INTEGER NOT NULL DEFAULT 0,
        engagement_score  REAL,
        curation          TEXT,
        category          TEXT,
        category_note     TEXT,
        categorized_at    TEXT,
        PRIMARY KEY (account, domain)
      );

      CREATE TABLE threads (
        account           TEXT    NOT NULL,
        thread_id         TEXT    NOT NULL,
        subject           TEXT,
        participants_json TEXT,
        msg_count         INTEGER NOT NULL DEFAULT 0,
        unread_count      INTEGER NOT NULL DEFAULT 0,
        user_participated INTEGER NOT NULL DEFAULT 0,
        first_at          TEXT,
        last_at           TEXT,
        PRIMARY KEY (account, thread_id)
      );

      CREATE TABLE interest_profile (
        account       TEXT NOT NULL,
        keywords_json TEXT,
        updated_at    TEXT,
        PRIMARY KEY (account)
      );

      CREATE TABLE contact_stats_snapshot (
        account          TEXT    NOT NULL,
        address          TEXT    NOT NULL,
        taken_at         TEXT    NOT NULL,
        msgs_received    INTEGER NOT NULL DEFAULT 0,
        read_count       INTEGER NOT NULL DEFAULT 0,
        replied_count    INTEGER NOT NULL DEFAULT 0,
        engagement_score REAL,
        PRIMARY KEY (account, address, taken_at)
      );

      CREATE TABLE sync_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        account     TEXT NOT NULL,
        phase       TEXT NOT NULL,
        selector    TEXT,
        started_at  TEXT,
        finished_at TEXT,
        fetched     INTEGER NOT NULL DEFAULT 0,
        indexed     INTEGER NOT NULL DEFAULT 0,
        error       TEXT
      );

      CREATE INDEX idx_sync_runs_account ON sync_runs (account, phase, started_at);
    `);
  },
};

/**
 * Migration 2 — thread-level summary columns (M3.5, ADR-0003).
 *
 * `messages` already carries the summary ladder (`summary_text` /
 * `summary_is_model` / `summarized_at`, migration 1); threads did not. A
 * thread summary is the agent's paraphrase of a whole conversation (ADR-0003:
 * "thread preferred when a conversation is the meaningful unit"). It attaches
 * to the thread row, is provenance-marked, and never overwrites the thread's
 * source fields. Threads carry no FTS row of their own (the per-message FTS
 * index already covers conversation text), so this is a pure column add.
 */
const m002_thread_summary: Migration = {
  version: 2,
  name: 'thread summary columns',
  up: (db) => {
    db.exec(`
      ALTER TABLE threads ADD COLUMN summary_text     TEXT;
      ALTER TABLE threads ADD COLUMN summary_is_model INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE threads ADD COLUMN summarized_at    TEXT;
    `);
  },
};

/** All migrations, in ascending version order. Append-only. */
export const MIGRATIONS: readonly Migration[] = [m001_initial, m002_thread_summary];

/** Read the database's applied schema version (SQLite `user_version`). */
export function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as
    | { user_version: number }
    | undefined;
  return row?.user_version ?? 0;
}

/**
 * Apply all pending migrations in a single transaction. Forward-only: throws
 * if the database version is newer than the code knows about (a downgrade).
 */
export function runMigrations(db: DatabaseSync): void {
  const current = getUserVersion(db);
  const latest = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

  if (current > latest) {
    throw new Error(
      `database schema version ${current} is newer than this build supports (${latest}); upgrade mail-index`,
    );
  }
  if (current === latest) return;

  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version,
  );

  db.exec('BEGIN');
  try {
    for (const migration of pending) {
      migration.up(db);
    }
    // user_version does not accept a bound parameter; the value is an integer
    // from our own constant list, so direct interpolation is safe.
    db.exec(`PRAGMA user_version = ${latest}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
