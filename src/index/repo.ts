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

/**
 * The message projection {@link Repo.messagesForAggregation} streams to the
 * aggregation pass. Snake_case rows straight from SQLite (repo convention).
 */
export interface AggregationMessageRow {
  account: string;
  gmail_message_id: string;
  thread_id: string | null;
  internal_date: number | null;
  date_header: string | null;
  from_addr: string | null;
  to_addr: string | null;
  cc_addr: string | null;
  subject: string | null;
  category: Category | null;
  is_list: number;
  direction: Direction;
  unread: number;
  starred: number;
  important: number;
}

/** A computed contact rollup the aggregation pass hands to the repo (camelCase). */
export interface ContactAggregate {
  address: string;
  displayName?: string | null;
  domain?: string | null;
  msgsReceived: number;
  msgsSent: number;
  readCount: number;
  repliedCount: number;
  initiatedCount: number;
  starredCount: number;
  importantCount: number;
  firstSeen?: string | null;
  lastSeen?: string | null;
}

/** A computed domain rollup (camelCase). */
export interface DomainAggregate {
  domain: string;
  msgs: number;
  distinctContacts: number;
}

/** A computed thread rollup (camelCase). */
export interface ThreadAggregate {
  threadId: string;
  subject?: string | null;
  participants: string[];
  msgCount: number;
  unreadCount: number;
  userParticipated: boolean;
  firstAt?: string | null;
  lastAt?: string | null;
}

/**
 * The per-contact scoring features the interest engine (M2.2, PLAN §10) reads.
 * The aggregate read columns come straight off the derived `contacts` row;
 * `bulk_count` is the count of *received* messages from this contact classified
 * as bulk (`is_list = 1 OR category IN ('promotions','social')`), computed by
 * joining the raw messages — the only signal the §10 weight table needs that
 * the contact rollup does not already carry. Snake_case rows (repo convention).
 */
export interface ContactScoringRow {
  address: string;
  msgs_received: number;
  msgs_sent: number;
  read_count: number;
  replied_count: number;
  initiated_count: number;
  starred_count: number;
  important_count: number;
  last_seen: string | null;
  bulk_count: number;
}

/** A scored contact the interest engine hands back for persistence (camelCase). */
export interface ScoredContactInput {
  address: string;
  engagementScore: number;
}

/**
 * A non-list thread's participant set, the unit of co-recipiency the graph
 * engine turns into edges (M2.3, D9, PLAN §9). One row per thread that is NOT a
 * bulk-mail thread; `participants` is the deduped set of contact addresses on
 * the thread (already JSON-decoded from `threads.participants_json`). Snake_case
 * is intentionally avoided here because the value is a decoded array, not a raw
 * SQLite scalar.
 */
export interface GraphThread {
  threadId: string;
  participants: string[];
}

/** A computed graph metric the graph engine hands back for persistence (camelCase). */
export interface GraphMetricInput {
  address: string;
  /** PageRank centrality in (0, 1]; how central the contact is to the correspondence. */
  centrality: number;
  /** Louvain community id (a social circle), or null when the contact is isolated. */
  communityId: number | null;
}

/** A persisted contact row (snake_case rows from SQLite). */
export interface ContactRow {
  account: string;
  address: string;
  display_name: string | null;
  domain: string | null;
  msgs_received: number;
  msgs_sent: number;
  read_count: number;
  replied_count: number;
  initiated_count: number;
  starred_count: number;
  important_count: number;
  first_seen: string | null;
  last_seen: string | null;
  curation: Curation | null;
}

/** A persisted domain row. */
export interface DomainRow {
  account: string;
  domain: string;
  msgs: number;
  distinct_contacts: number;
  curation: Curation | null;
  category: string | null;
}

/** A persisted thread row. */
export interface ThreadRow {
  account: string;
  thread_id: string;
  subject: string | null;
  participants_json: string | null;
  msg_count: number;
  unread_count: number;
  user_participated: number;
  first_at: string | null;
  last_at: string | null;
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
   * Fetch a message's stored provider URL (`gmail_url`), or null when the row is
   * absent or carries no stored URL. Used by `open` to prefer a recorded
   * provider permalink over a constructed deep link. Kept separate from
   * {@link getMessage} so `open` stays a single, cheap column read.
   */
  getMessageUrl(account: string, gmailMessageId: string): string | null {
    const row = this.#prepare(
      `SELECT gmail_url FROM messages WHERE account = ? AND gmail_message_id = ?`,
    ).get(account, gmailMessageId) as { gmail_url: string | null } | undefined;
    return row?.gmail_url ?? null;
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

  /**
   * Count completed (`finished_at` set, no `error`) phase-1 `sync` runs for an
   * account. Used by the CLI to decide whether a sweep is the account's INITIAL
   * sync (count 0 before this run) — one of the two triggers for the auto graph
   * build (D10); the other is an explicit whole-mailbox `--all` sweep.
   */
  completedSyncCount(account: string): number {
    const row = this.#prepare(
      `SELECT count(*) c FROM sync_runs
        WHERE account = ? AND phase = 'sync' AND finished_at IS NOT NULL AND error IS NULL`,
    ).get(account) as { c: number };
    return row.c;
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

  // ---- aggregation read surface (M2.1, PLAN §6) ---------------------------
  //
  // The intelligence layer reads the INDEX ONLY (PLAN §4) — never the provider.
  // These methods expose the message rows the aggregation pass rolls up, plus
  // typed accessors for the derived contact/domain/thread tables it writes.

  /**
   * Stream the message fields the aggregation pass (`intelligence/aggregate.ts`)
   * needs to roll messages up into contacts/domains/threads. Scoped to one
   * account; ordered oldest-first by `internal_date` so first/last-seen and the
   * thread "who started it" (initiated) signal fall out of a single forward
   * pass. NULL `internal_date` rows sort first (oldest) deterministically.
   */
  messagesForAggregation(account: string): AggregationMessageRow[] {
    return this.#prepare(
      `SELECT account, gmail_message_id, thread_id, internal_date, date_header,
              from_addr, to_addr, cc_addr, subject, category, is_list, direction,
              unread, starred, important
         FROM messages
        WHERE account = ?
        ORDER BY internal_date IS NULL DESC, internal_date ASC, gmail_message_id ASC`,
    ).all(account) as unknown as AggregationMessageRow[];
  }

  /**
   * Replace the derived contact/domain/thread rows for `account` in one
   * transaction, so aggregation is idempotent and re-runnable: a re-run produces
   * the same tables with no stale rows and no duplicates. Identity/curation
   * columns the aggregation does not own — `person_id`, `curation`,
   * `centrality`, `community_id` (contacts); `curation`, `category`,
   * `category_note`, `categorized_at` (domains) — are preserved across the
   * rebuild by carrying the existing values forward (an UPSERT, not a wipe), so
   * a user's curation survives every aggregation.
   */
  replaceAggregates(
    account: string,
    aggregates: {
      contacts: readonly ContactAggregate[];
      domains: readonly DomainAggregate[];
      threads: readonly ThreadAggregate[];
    },
  ): void {
    this.transaction(() => {
      this.#replaceContacts(account, aggregates.contacts);
      this.#replaceDomains(account, aggregates.domains);
      this.#replaceThreads(account, aggregates.threads);
    });
  }

  #replaceContacts(account: string, contacts: readonly ContactAggregate[]): void {
    // Drop contacts that no longer aggregate (none of their mail remains), but
    // keep curation/identity for any that persist via the UPSERT below.
    const keep = new Set(contacts.map((c) => c.address));
    const existing = this.#prepare(
      `SELECT address FROM contacts WHERE account = ?`,
    ).all(account) as { address: string }[];
    const del = this.#prepare(`DELETE FROM contacts WHERE account = ? AND address = ?`);
    for (const row of existing) {
      if (!keep.has(row.address)) del.run(account, row.address);
    }

    const up = this.#prepare(
      `INSERT INTO contacts (
         account, address, display_name, domain,
         msgs_received, msgs_sent, read_count, replied_count, initiated_count,
         starred_count, important_count, first_seen, last_seen
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account, address) DO UPDATE SET
         display_name    = COALESCE(excluded.display_name, contacts.display_name),
         domain          = COALESCE(excluded.domain, contacts.domain),
         msgs_received   = excluded.msgs_received,
         msgs_sent       = excluded.msgs_sent,
         read_count      = excluded.read_count,
         replied_count   = excluded.replied_count,
         initiated_count = excluded.initiated_count,
         starred_count   = excluded.starred_count,
         important_count = excluded.important_count,
         first_seen      = excluded.first_seen,
         last_seen       = excluded.last_seen`,
    );
    for (const c of contacts) {
      up.run(
        account,
        c.address,
        c.displayName ?? null,
        c.domain ?? null,
        c.msgsReceived,
        c.msgsSent,
        c.readCount,
        c.repliedCount,
        c.initiatedCount,
        c.starredCount,
        c.importantCount,
        c.firstSeen ?? null,
        c.lastSeen ?? null,
      );
    }
  }

  #replaceDomains(account: string, domains: readonly DomainAggregate[]): void {
    const keep = new Set(domains.map((d) => d.domain));
    const existing = this.#prepare(
      `SELECT domain FROM domains WHERE account = ?`,
    ).all(account) as { domain: string }[];
    const del = this.#prepare(`DELETE FROM domains WHERE account = ? AND domain = ?`);
    for (const row of existing) {
      if (!keep.has(row.domain)) del.run(account, row.domain);
    }

    const up = this.#prepare(
      `INSERT INTO domains (account, domain, msgs, distinct_contacts)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account, domain) DO UPDATE SET
         msgs              = excluded.msgs,
         distinct_contacts = excluded.distinct_contacts`,
    );
    for (const d of domains) {
      up.run(account, d.domain, d.msgs, d.distinctContacts);
    }
  }

  #replaceThreads(account: string, threads: readonly ThreadAggregate[]): void {
    // Threads carry no user-owned columns, so a clean replace is safe.
    this.#prepare(`DELETE FROM threads WHERE account = ?`).run(account);
    const ins = this.#prepare(
      `INSERT INTO threads (
         account, thread_id, subject, participants_json,
         msg_count, unread_count, user_participated, first_at, last_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const t of threads) {
      ins.run(
        account,
        t.threadId,
        t.subject ?? null,
        JSON.stringify(t.participants),
        t.msgCount,
        t.unreadCount,
        bool(t.userParticipated),
        t.firstAt ?? null,
        t.lastAt ?? null,
      );
    }
  }

  /** Fetch one aggregated contact row (or undefined). */
  getContact(account: string, address: string): ContactRow | undefined {
    return this.#prepare(
      `SELECT account, address, display_name, domain, msgs_received, msgs_sent,
              read_count, replied_count, initiated_count, starred_count,
              important_count, first_seen, last_seen, curation
         FROM contacts WHERE account = ? AND address = ?`,
    ).get(account, address) as ContactRow | undefined;
  }

  /**
   * List Correspondents — contacts the user has ever written to (`msgs_sent >
   * 0`, CONTEXT.md). The sharpest human-vs-noise separator: people remember by
   * who they talked to. Ordered by sent volume then received volume, newest
   * correspondence first on ties.
   */
  listCorrespondents(account: string, limit?: number): ContactRow[] {
    const sql =
      `SELECT account, address, display_name, domain, msgs_received, msgs_sent,
              read_count, replied_count, initiated_count, starred_count,
              important_count, first_seen, last_seen, curation
         FROM contacts
        WHERE account = ? AND msgs_sent > 0
        ORDER BY msgs_sent DESC, msgs_received DESC, last_seen DESC` +
      (limit != null ? ` LIMIT ?` : ``);
    const rows = limit != null
      ? this.#prepare(sql).all(account, limit)
      : this.#prepare(sql).all(account);
    return rows as unknown as ContactRow[];
  }

  /** Fetch one aggregated domain row (or undefined). */
  getDomain(account: string, domain: string): DomainRow | undefined {
    return this.#prepare(
      `SELECT account, domain, msgs, distinct_contacts, curation, category
         FROM domains WHERE account = ? AND domain = ?`,
    ).get(account, domain) as DomainRow | undefined;
  }

  /** Fetch one aggregated thread row (or undefined). */
  getThread(account: string, threadId: string): ThreadRow | undefined {
    return this.#prepare(
      `SELECT account, thread_id, subject, participants_json, msg_count,
              unread_count, user_participated, first_at, last_at
         FROM threads WHERE account = ? AND thread_id = ?`,
    ).get(account, threadId) as ThreadRow | undefined;
  }

  // ---- interest engine surface (M2.2, PLAN §10, D12) ----------------------
  //
  // INDEX-ONLY (PLAN §4): the interest engine reads these derived rows and
  // writes back `engagement_score` + a `contact_stats_snapshot`, never touching
  // a provider.

  /**
   * The per-contact scoring features the interest engine blends (PLAN §10). One
   * row per aggregated contact for `account`. The aggregate columns are read
   * straight off `contacts`; `bulk_count` is computed with a correlated
   * subquery counting this contact's *received* bulk mail (is_list OR
   * promotions/social) from the raw `messages`, matching either the exact
   * `from_addr` or the bare address embedded in a `Name <addr>` header — the one
   * §10 signal the contact rollup does not already carry.
   */
  contactScoringRows(account: string): ContactScoringRow[] {
    const rows = this.#prepare(
      `SELECT c.address, c.msgs_received, c.msgs_sent, c.read_count,
              c.replied_count, c.initiated_count, c.starred_count,
              c.important_count, c.last_seen,
              (
                SELECT count(*) FROM messages m
                 WHERE m.account = c.account
                   AND m.direction = 'received'
                   AND (m.is_list = 1 OR m.category IN ('promotions','social'))
                   AND (
                     m.from_addr = c.address
                     OR lower(m.from_addr) LIKE '%<' || lower(c.address) || '>%'
                   )
              ) AS bulk_count
         FROM contacts c
        WHERE c.account = ?`,
    ).all(account) as unknown as ContactScoringRow[];
    return rows;
  }

  /**
   * Persist the interest engine's output for `account` (D12): set each contact's
   * `engagement_score` and append one `contact_stats_snapshot` row per contact
   * stamped `taken_at`. Both in one transaction so a run is atomic. The snapshot
   * is append-only — re-running the pass adds a new generation (distinct
   * `taken_at`) rather than overwriting, which is what makes trend a v1.1 query
   * with no migration. Scores are written only for contacts that still exist
   * (the aggregation owns row lifecycle); a snapshot mirrors the score's source
   * aggregates (msgs_received / read_count / replied_count) so a snapshot is
   * self-describing without a join back to a mutable `contacts` row.
   */
  persistEngagementScores(
    account: string,
    scored: readonly ScoredContactInput[],
    takenAt: string,
  ): void {
    const setScore = this.#prepare(
      `UPDATE contacts SET engagement_score = ? WHERE account = ? AND address = ?`,
    );
    const snapshot = this.#prepare(
      `INSERT INTO contact_stats_snapshot (
         account, address, taken_at,
         msgs_received, read_count, replied_count, engagement_score
       )
       SELECT account, address, ?, msgs_received, read_count, replied_count, ?
         FROM contacts WHERE account = ? AND address = ?
       ON CONFLICT(account, address, taken_at) DO UPDATE SET
         msgs_received    = excluded.msgs_received,
         read_count       = excluded.read_count,
         replied_count    = excluded.replied_count,
         engagement_score = excluded.engagement_score`,
    );
    this.transaction(() => {
      for (const s of scored) {
        setScore.run(s.engagementScore, account, s.address);
        snapshot.run(takenAt, s.engagementScore, account, s.address);
      }
    });
  }

  /** Fetch a contact's current engagement_score (or null/undefined). */
  getEngagementScore(account: string, address: string): number | null | undefined {
    const row = this.#prepare(
      `SELECT engagement_score FROM contacts WHERE account = ? AND address = ?`,
    ).get(account, address) as { engagement_score: number | null } | undefined;
    return row ? row.engagement_score : undefined;
  }

  /** Count `contact_stats_snapshot` rows for a contact (snapshot generations). */
  countSnapshots(account: string, address: string): number {
    const row = this.#prepare(
      `SELECT count(*) c FROM contact_stats_snapshot WHERE account = ? AND address = ?`,
    ).get(account, address) as { c: number };
    return row.c;
  }

  // ---- graph engine surface (M2.3, PLAN §9, D8/D9) ------------------------
  //
  // INDEX-ONLY (PLAN §4): the graph engine reads non-list threads' participant
  // sets and writes back `centrality` + `community_id` onto contacts, never
  // touching a provider. Kept here (not in the graph module) so the graph layer
  // depends only on the repo, and the core index never imports graphology (D8).

  /**
   * The co-recipiency input for the graph engine (D9, PLAN §9): the participant
   * set of every **non-list** thread for `account`. A thread is treated as
   * bulk (and excluded) when ANY of its messages is classified `is_list = 1` —
   * mailing-list / announcement threads form dense cliques that would poison
   * community detection, so D9 drops them wholesale. Threads with fewer than two
   * participants carry no co-recipiency edge and are omitted. Participants come
   * straight off the already-aggregated `threads.participants_json` (the
   * aggregation pass, M2.1, owns building that set), so this is a pure derived
   * read — the graph engine never re-walks raw messages.
   *
   * Participants are intersected with the account's `contacts` set: the
   * aggregation records the user's own address among thread participants, but
   * the user is never a contact (they sit on every thread by definition, which
   * would otherwise make the user the universally-central node and merge every
   * social circle). Restricting nodes to actual contacts yields the graph of
   * "who is central to YOUR correspondence" (PLAN §9) rather than to you.
   */
  graphThreads(account: string): GraphThread[] {
    const contactRows = this.#prepare(
      `SELECT address FROM contacts WHERE account = ?`,
    ).all(account) as { address: string }[];
    const contactSet = new Set(contactRows.map((r) => r.address));

    // A thread is "list" if any of its messages is is_list; exclude those.
    const rows = this.#prepare(
      `SELECT t.thread_id AS thread_id, t.participants_json AS participants_json
         FROM threads t
        WHERE t.account = ?
          AND NOT EXISTS (
            SELECT 1 FROM messages m
             WHERE m.account = t.account
               AND m.thread_id = t.thread_id
               AND m.is_list = 1
          )`,
    ).all(account) as { thread_id: string; participants_json: string | null }[];

    const out: GraphThread[] = [];
    for (const row of rows) {
      if (!row.participants_json) continue;
      let participants: unknown;
      try {
        participants = JSON.parse(row.participants_json);
      } catch {
        continue;
      }
      if (!Array.isArray(participants)) continue;
      const addrs = [
        ...new Set(
          participants.filter(
            (p): p is string => typeof p === 'string' && contactSet.has(p),
          ),
        ),
      ];
      if (addrs.length < 2) continue;
      out.push({ threadId: row.thread_id, participants: addrs });
    }
    return out;
  }

  /**
   * Persist the graph engine's output for `account` (D8, PLAN §9): set each
   * contact's `centrality` and `community_id`. One transaction so a build is
   * atomic. Scores are written only for contacts that still exist (the
   * aggregation owns row lifecycle); contacts absent from `metrics` keep their
   * prior values, so a rebuild over a narrower graph never silently clears a
   * contact that simply had no non-list edges this run — callers that want a
   * clean slate pass every contact. `community_id` may be null for an isolated
   * contact.
   */
  persistGraphMetrics(account: string, metrics: readonly GraphMetricInput[]): void {
    const set = this.#prepare(
      `UPDATE contacts SET centrality = ?, community_id = ?
        WHERE account = ? AND address = ?`,
    );
    this.transaction(() => {
      for (const m of metrics) {
        set.run(m.centrality, m.communityId, account, m.address);
      }
    });
  }

  /** Fetch a contact's derived graph metrics (centrality + community_id). */
  getGraphMetrics(
    account: string,
    address: string,
  ): { centrality: number | null; community_id: number | null } | undefined {
    return this.#prepare(
      `SELECT centrality, community_id FROM contacts WHERE account = ? AND address = ?`,
    ).get(account, address) as
      | { centrality: number | null; community_id: number | null }
      | undefined;
  }
}
