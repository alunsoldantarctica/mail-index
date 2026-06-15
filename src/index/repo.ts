/**
 * Typed repository over the index (SCOPE 0.2). Every persistence path goes
 * through here so the critical invariants live in one place (CONTEXT.md):
 *
 *  1. Upsert by (account, gmail_message_id) is idempotent — re-running a sync
 *     over the same Message produces the same row, no duplicates.
 *  2. Never downgrade body_state: a re-sync delivering `meta` must not clobber
 *     an existing `full` / `summary-only` row's body or state. The body ladder
 *     only moves up (BODY_STATE_RANK).
 *  3. The FTS row is kept in lockstep with the Message: subject/sender/
 *     recipients always indexed; `body` reflects snippet (meta) → snippet +
 *     body_text (full) → snippet + summary (summary-only).
 *
 * Convention for later stages: the repo is a thin class wrapping a live
 * `DatabaseSync`. Public methods are verbs (`upsertMessage`, `recordSyncRun`).
 * Inputs are plain typed records; the repo fills `indexed_at`/timestamps.
 * Failures that violate an invariant or a closed enum throw `IndexError`
 * (re-exported from `db.ts`); SQLite errors propagate as-is. Booleans cross the
 * boundary as JS `boolean` and are stored as 0/1 internally.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { IndexError } from './db.js';
import {
  BODY_STATES,
  BODY_STATE_RANK,
  CATEGORIES,
  CURATIONS,
  DIRECTIONS,
  SYNC_PHASES,
  type BodyState,
  type Category,
  type Curation,
  type Direction,
  type SyncPhase,
} from './schema.js';

const bool = (v: boolean | undefined): number => (v ? 1 : 0);

/** Input for {@link Repo.upsertMessage}. Mirrors PLAN §6 `messages`. */
export interface MessageInput {
  account: string;
  gmailMessageId: string;
  threadId?: string | null;
  internalDate?: number | null;
  dateHeader?: string | null;
  fromAddr?: string | null;
  toAddr?: string | null;
  ccAddr?: string | null;
  subject?: string | null;
  labels?: string[] | null;
  category?: Category | null;
  isList?: boolean;
  direction?: Direction;
  unread?: boolean;
  starred?: boolean;
  important?: boolean;
  sizeEstimate?: number | null;
  snippet?: string | null;
  /** Body ladder state. Defaults to 'meta'. Never downgraded on re-sync. */
  bodyState?: BodyState;
  /** Distilled body text; only meaningful for 'full'. */
  bodyText?: string | null;
  gmailUrl?: string | null;
}

/** A persisted message row (subset used by callers/tests). */
export interface MessageRow {
  account: string;
  gmail_message_id: string;
  thread_id: string | null;
  subject: string | null;
  from_addr: string | null;
  to_addr: string | null;
  cc_addr: string | null;
  snippet: string | null;
  body_state: BodyState;
  body_text: string | null;
  is_list: number;
  direction: Direction;
  unread: number;
  starred: number;
  important: number;
  category: Category | null;
  internal_date: number | null;
  indexed_at: string | null;
  body_fetched_at: string | null;
}

export interface SyncRunStart {
  account: string;
  phase: SyncPhase;
  selector?: string | null;
}

export interface SyncRunFinish {
  fetched?: number;
  indexed?: number;
  error?: string | null;
}

/**
 * A selector for {@link Repo.selectMetaMessages} — which `meta` rows an enrich
 * run should promote (PLAN §7 phase 2). Fields combine with AND.
 */
export interface MetaSelector {
  /** `'direct'` applies the pre-curation heuristic; `'all'` matches every meta row. */
  rule?: 'direct' | 'all';
  /** Restrict to a single sender (bare address or exact `from_addr`). */
  sender?: string;
  /** Restrict to meta rows matching this FTS5 query. */
  match?: string;
  /** Cap the number of ids returned (newest-first). */
  limit?: number;
}

export interface ContactInput {
  account: string;
  address: string;
  displayName?: string | null;
  domain?: string | null;
  curation?: Curation | null;
}

export interface DomainCategoryInput {
  account: string;
  domain: string;
  category: string;
  note?: string | null;
}

export class Repo {
  readonly db: DatabaseSync;

  // Prepared statements are cached lazily; node:sqlite caches the parse, and
  // reusing them keeps the hot sync loop tight.
  #stmt = new Map<string, StatementSync>();

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  #prepare(sql: string): StatementSync {
    let s = this.#stmt.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.#stmt.set(sql, s);
    }
    return s;
  }

  /** Run `fn` inside an IMMEDIATE transaction; rolls back on throw. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Idempotent upsert of a Message by (account, gmail_message_id), keeping the
   * FTS row in sync and honouring the no-downgrade rule. Returns the resulting
   * body_state actually stored (which may differ from the input when an
   * incoming `meta` is held back from clobbering an existing higher state).
   */
  upsertMessage(input: MessageInput): BodyState {
    const incomingState: BodyState = input.bodyState ?? 'meta';
    if (!BODY_STATES.includes(incomingState)) {
      throw new IndexError(`invalid body_state: ${String(incomingState)}`);
    }
    if (input.direction && !DIRECTIONS.includes(input.direction)) {
      throw new IndexError(`invalid direction: ${String(input.direction)}`);
    }
    if (
      input.category != null &&
      !CATEGORIES.includes(input.category)
    ) {
      throw new IndexError(`invalid category: ${String(input.category)}`);
    }

    return this.transaction(() => {
      const existing = this.#prepare(
        `SELECT rowid, body_state, body_text, body_fetched_at
           FROM messages WHERE account = ? AND gmail_message_id = ?`,
      ).get(input.account, input.gmailMessageId) as
        | {
            rowid: number;
            body_state: BodyState;
            body_text: string | null;
            body_fetched_at: string | null;
          }
        | undefined;

      const now = new Date().toISOString();

      // Resolve the effective body state/text honouring no-downgrade.
      let effectiveState = incomingState;
      let effectiveBody = input.bodyText ?? null;
      let bodyFetchedAt = existing?.body_fetched_at ?? null;

      if (existing) {
        const existingRank = BODY_STATE_RANK[existing.body_state];
        const incomingRank = BODY_STATE_RANK[incomingState];
        if (incomingRank < existingRank) {
          // Downgrade attempt (e.g. a plain metadata re-sync over a `full`
          // row): keep the higher existing state and its body untouched.
          effectiveState = existing.body_state;
          effectiveBody = existing.body_text;
        } else if (incomingState === 'full') {
          // Promotion (or refresh) to full: record the fetch time and take the
          // new body text.
          bodyFetchedAt = now;
        }
      } else if (incomingState === 'full') {
        bodyFetchedAt = now;
      }

      const labelsJson = input.labels ? JSON.stringify(input.labels) : null;

      const rowid = this.#writeMessageRow(input, {
        effectiveState,
        effectiveBody,
        labelsJson,
        bodyFetchedAt,
        now,
        existingRowid: existing?.rowid,
      });

      this.#syncFts(rowid, {
        subject: input.subject ?? null,
        sender: input.fromAddr ?? null,
        recipients: [input.toAddr, input.ccAddr].filter(Boolean).join(' ') || null,
        snippet: input.snippet ?? null,
        bodyText: effectiveState === 'full' ? effectiveBody : null,
      });

      return effectiveState;
    });
  }

  #writeMessageRow(
    input: MessageInput,
    resolved: {
      effectiveState: BodyState;
      effectiveBody: string | null;
      labelsJson: string | null;
      bodyFetchedAt: string | null;
      now: string;
      existingRowid: number | undefined;
    },
  ): number {
    // ON CONFLICT keeps the row's rowid stable (so the FTS rowid never drifts)
    // and recomputes only the metadata columns; body_state/body_text are set
    // from the already-resolved (no-downgrade) values.
    this.#prepare(
      `INSERT INTO messages (
         account, gmail_message_id, thread_id, internal_date, date_header,
         from_addr, to_addr, cc_addr, subject, labels_json, category,
         is_list, direction, unread, starred, important, size_estimate,
         snippet, body_state, body_text, gmail_url, indexed_at, body_fetched_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )
       ON CONFLICT(account, gmail_message_id) DO UPDATE SET
         thread_id       = excluded.thread_id,
         internal_date   = excluded.internal_date,
         date_header     = excluded.date_header,
         from_addr       = excluded.from_addr,
         to_addr         = excluded.to_addr,
         cc_addr         = excluded.cc_addr,
         subject         = excluded.subject,
         labels_json     = excluded.labels_json,
         category        = excluded.category,
         is_list         = excluded.is_list,
         direction       = excluded.direction,
         unread          = excluded.unread,
         starred         = excluded.starred,
         important       = excluded.important,
         size_estimate   = excluded.size_estimate,
         snippet         = excluded.snippet,
         body_state      = excluded.body_state,
         body_text       = excluded.body_text,
         gmail_url       = excluded.gmail_url,
         indexed_at      = excluded.indexed_at,
         body_fetched_at = excluded.body_fetched_at`,
    ).run(
      input.account,
      input.gmailMessageId,
      input.threadId ?? null,
      input.internalDate ?? null,
      input.dateHeader ?? null,
      input.fromAddr ?? null,
      input.toAddr ?? null,
      input.ccAddr ?? null,
      input.subject ?? null,
      resolved.labelsJson,
      input.category ?? null,
      bool(input.isList),
      input.direction ?? 'received',
      bool(input.unread),
      bool(input.starred),
      bool(input.important),
      input.sizeEstimate ?? null,
      input.snippet ?? null,
      resolved.effectiveState,
      resolved.effectiveBody,
      input.gmailUrl ?? null,
      resolved.now,
      resolved.bodyFetchedAt,
    );

    if (resolved.existingRowid != null) return resolved.existingRowid;
    const row = this.#prepare(
      `SELECT rowid FROM messages WHERE account = ? AND gmail_message_id = ?`,
    ).get(input.account, input.gmailMessageId) as { rowid: number };
    return row.rowid;
  }

  /**
   * Replace the FTS row for a message rowid: delete-then-insert at the same
   * rowid so the index stays aligned with the message across the body ladder.
   */
  #syncFts(
    rowid: number,
    fields: {
      subject: string | null;
      sender: string | null;
      recipients: string | null;
      snippet: string | null;
      bodyText: string | null;
    },
  ): void {
    // FTS body column = snippet plus the distilled body when present.
    const body = [fields.snippet, fields.bodyText].filter(Boolean).join('\n') || null;
    this.#prepare(`DELETE FROM messages_fts WHERE rowid = ?`).run(rowid);
    this.#prepare(
      `INSERT INTO messages_fts(rowid, subject, sender, recipients, body)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(rowid, fields.subject, fields.sender, fields.recipients, body);
  }

  /** Fetch one message row by id (or undefined). */
  getMessage(account: string, gmailMessageId: string): MessageRow | undefined {
    return this.#prepare(
      `SELECT account, gmail_message_id, thread_id, subject, from_addr, to_addr,
              cc_addr, snippet, body_state, body_text, is_list, direction,
              unread, starred, important, category, internal_date, indexed_at,
              body_fetched_at
         FROM messages WHERE account = ? AND gmail_message_id = ?`,
    ).get(account, gmailMessageId) as MessageRow | undefined;
  }

  /**
   * FTS search returning matching message rows ranked by bm25. `query` is raw
   * FTS5 syntax. Optionally scoped to one account.
   */
  searchMessages(query: string, opts: { account?: string; limit?: number } = {}): MessageRow[] {
    const limit = opts.limit ?? 20;
    const accountClause = opts.account ? 'AND m.account = ?' : '';
    const stmt = this.#prepare(
      `SELECT m.account, m.gmail_message_id, m.thread_id, m.subject, m.from_addr,
              m.to_addr, m.cc_addr, m.snippet, m.body_state, m.body_text,
              m.is_list, m.direction, m.unread, m.starred, m.important,
              m.category, m.internal_date, m.indexed_at, m.body_fetched_at
         FROM messages_fts f
         JOIN messages m ON m.rowid = f.rowid
        WHERE messages_fts MATCH ? ${accountClause}
        ORDER BY bm25(messages_fts)
        LIMIT ?`,
    );
    const rows = opts.account
      ? stmt.all(query, opts.account, limit)
      : stmt.all(query, limit);
    return rows as unknown as MessageRow[];
  }

  /**
   * Select `meta`-state message ids for an account that an enrich run should
   * promote (SCOPE 1.1, PLAN §7 phase 2). Only `body_state='meta'` rows are
   * returned — already-enriched (`full`) and demoted (`summary-only`) rows are
   * skipped, which is what makes enrich incremental + idempotent. The `selector`
   * narrows the set:
   *
   *  - `rule: 'direct'` — the pre-curation default: `is_list = 0 AND category
   *    NOT IN ('promotions','social')` (PLAN §7).
   *  - `rule: 'all'` — every meta row (no extra predicate).
   *  - `sender` — exact `from_addr` match, OR (when it looks like a bare
   *    address) a match on the address embedded in a `Name <addr>` from header.
   *  - `match` — an FTS5 query; restrict to meta rows whose FTS row matches.
   *
   * Results are ordered newest-first by `internal_date` so a `limit` keeps the
   * most recent mail. Selector fields combine with AND.
   */
  selectMetaMessages(account: string, selector: MetaSelector = {}): string[] {
    const where: string[] = [`m.account = ?`, `m.body_state = 'meta'`];
    const params: unknown[] = [account];

    if (selector.rule === 'direct') {
      where.push(`m.is_list = 0 AND (m.category IS NULL OR m.category NOT IN ('promotions','social'))`);
    }

    if (selector.sender) {
      // Match the stored from_addr exactly OR by embedded bare address, so
      // `--sender jordan@partner.example.com` matches `Jordan <jordan@...>`.
      where.push(`(m.from_addr = ? OR lower(m.from_addr) LIKE ?)`);
      params.push(selector.sender, `%<${selector.sender.toLowerCase()}>%`);
    }

    let fromClause = `messages m`;
    if (selector.match) {
      // Constrain to meta rows whose FTS row matches the query. Join the FTS
      // table; FTS MATCH applies as a predicate.
      fromClause = `messages_fts f JOIN messages m ON m.rowid = f.rowid`;
      where.push(`messages_fts MATCH ?`);
      params.push(selector.match);
    }

    let sql = `SELECT m.gmail_message_id AS id FROM ${fromClause} WHERE ${where.join(' AND ')} ORDER BY m.internal_date DESC`;
    if (selector.limit != null) {
      sql += ` LIMIT ?`;
      params.push(selector.limit);
    }

    const rows = this.#prepare(sql).all(...(params as never[])) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** Count messages, optionally scoped to one account. */
  countMessages(account?: string): number {
    const row = account
      ? (this.#prepare(`SELECT count(*) c FROM messages WHERE account = ?`).get(
          account,
        ) as { c: number })
      : (this.#prepare(`SELECT count(*) c FROM messages`).get() as { c: number });
    return row.c;
  }

  // ---- sync_runs audit (PLAN §6) ----------------------------------------

  /** Open a sync_runs row; returns its id for the matching finish call. */
  startSyncRun(input: SyncRunStart): number {
    if (!SYNC_PHASES.includes(input.phase)) {
      throw new IndexError(`invalid sync phase: ${String(input.phase)}`);
    }
    const res = this.#prepare(
      `INSERT INTO sync_runs (account, phase, selector, started_at)
       VALUES (?, ?, ?, ?)`,
    ).run(input.account, input.phase, input.selector ?? null, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  /**
   * The id of an in-progress sync_runs row for `account` (started but not yet
   * finished), or undefined when none. An in-progress row is the per-account
   * sync LOCK (ADR-0005): the sync layer refuses a second concurrent run while
   * one exists. When `exceptId` is given it is ignored — so a freshly opened run
   * can ask "is anyone else running?" without seeing itself.
   */
  activeSyncRun(account: string, exceptId?: number): number | undefined {
    const row = this.#prepare(
      `SELECT id FROM sync_runs
        WHERE account = ? AND finished_at IS NULL AND id != ?
        ORDER BY id LIMIT 1`,
    ).get(account, exceptId ?? -1) as { id: number } | undefined;
    return row?.id;
  }

  /** Close a sync_runs row with counts and optional error. */
  finishSyncRun(id: number, result: SyncRunFinish = {}): void {
    this.#prepare(
      `UPDATE sync_runs
          SET finished_at = ?, fetched = ?, indexed = ?, error = ?
        WHERE id = ?`,
    ).run(
      new Date().toISOString(),
      result.fetched ?? 0,
      result.indexed ?? 0,
      result.error ?? null,
      id,
    );
  }

  // ---- contacts / domains (curation surfaces; full population is M2) ------

  /** Upsert a contact's identity/curation fields (idempotent). */
  upsertContact(input: ContactInput): void {
    if (input.curation != null && !CURATIONS.includes(input.curation)) {
      throw new IndexError(`invalid curation: ${String(input.curation)}`);
    }
    this.#prepare(
      `INSERT INTO contacts (account, address, display_name, domain, curation)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account, address) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, contacts.display_name),
         domain       = COALESCE(excluded.domain, contacts.domain),
         curation     = excluded.curation`,
    ).run(
      input.account,
      input.address,
      input.displayName ?? null,
      input.domain ?? null,
      input.curation ?? null,
    );
  }

  /** Write back an agent-assigned domain category (PLAN §6, write-back loop). */
  setDomainCategory(input: DomainCategoryInput): void {
    this.#prepare(
      `INSERT INTO domains (account, domain, category, category_note, categorized_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account, domain) DO UPDATE SET
         category       = excluded.category,
         category_note  = excluded.category_note,
         categorized_at = excluded.categorized_at`,
    ).run(
      input.account,
      input.domain,
      input.category,
      input.note ?? null,
      new Date().toISOString(),
    );
  }
}
