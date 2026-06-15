/**
 * MCP tool engine (SCOPE 3.4, PLAN §12, ADR-0001/0004/0005, CONTEXT.md
 * "Recall" / "Command handback" / "Inline enrichment").
 *
 * The pure, transport-free half of the MCP server: every PLAN §12 tool is a
 * function over a {@link ToolContext} that returns a plain, JSON-serialisable
 * result object. `server.ts` wires these to the stdio `@modelcontextprotocol/sdk`
 * Server; the golden-response tests call them directly against a seeded fixture
 * DB. Splitting the logic out (mirroring the CLI's `run*` seam) keeps the tools
 * testable without a live transport and keeps the entry point thin.
 *
 * Binding constraints these tools honour:
 *
 *  - **READ-ONLY on the mailbox (D15).** Every tool reads the LOCAL index. The
 *    one permitted provider contact is `get_message`'s single O(1) inline enrich
 *    of a still-`meta` row (ADR-0001) — and even that is gated on a source being
 *    wired in.
 *  - **O(N) → COMMAND HANDBACK (ADR-0001).** Anything bulk (sync, bulk enrich,
 *    graph build, compact) is NEVER run inline; the tool returns the exact
 *    `mail-index` CLI command string the agent runs itself (CONTEXT.md "Command
 *    handback"). The CLI is the execution engine; the MCP is the brain.
 *  - **`index_as_of` on EVERY response (ADR-0005).** {@link withMeta} stamps the
 *    freshness of the relevant account(s) onto every result.
 *  - **Stale time-sensitive reads spawn a DETACHED background sync (ADR-0005).**
 *    `catch_up` / `digest_sources`, when the index is stale, return current data
 *    immediately AND kick off an incremental sync (debounced; reuses the existing
 *    sync + the sync_runs lock so there is never a second writer), reporting
 *    `sync_started` + `eta_seconds`. They never block.
 *  - **Recall, not lookup (DESIGN TEST a).** `search` is fuzzy ranked FTS;
 *    `find_person` ranks Correspondents first and resolves substrings;
 *    `graph_neighbors` falls back to a ranked near-miss set rather than a bare
 *    empty answer.
 *  - **Token-budget-conscious (DESIGN TEST b).** Compact shapes, snippet-first,
 *    full bodies opt-in (`get_message` level), sensible default limits.
 */

import type { OperatorConfig, AccountConfig } from '../config/index.js';
import type {
  Repo,
  MessageRow,
  ThreadRow,
  ContactDetailRow,
  ContactSort,
  GraphNeighborRow,
} from '../index/index.js';
import type { MailSource } from '../source/index.js';
import type { Curation } from '../index/schema.js';
import { CURATIONS } from '../index/schema.js';
import { enrichOne } from '../ingest/enrich.js';
import { buildFtsQuery } from '../cli/search.js';
import { propose, set as curationSet, get as curationGet } from '../curation/index.js';
import {
  saveSummary,
  domainsToCategorize as wbDomainsToCategorize,
  saveDomainCategory as wbSaveDomainCategory,
} from '../writeback/index.js';

/** Error thrown for a tool call that cannot proceed (bad ref, unknown tool). */
export class McpToolError extends Error {
  override name = 'McpToolError';
}

/**
 * Spawn a DETACHED background incremental sync for an account (ADR-0005). The
 * server wires a real implementation that re-execs the `mail-index sync` CLI
 * detached (so it outlives the MCP request — a request-scoped child cannot, per
 * ADR-0005); tests wire a spy. Returns `true` when a sync was actually started,
 * `false` when it was debounced/declined (e.g. a sync is already running).
 */
export type BackgroundSync = (account: string, since?: string) => boolean;

/** Everything the tools read/write. INDEX-ONLY except the one O(1) enrich seam. */
export interface ToolContext {
  repo: Repo;
  /** Operator config — used only to resolve an account's adapter for inline enrich. */
  config: OperatorConfig;
  /**
   * Build the per-account {@link MailSource} for the ONE permitted inline enrich
   * (`get_message`, ADR-0001). Optional: when absent (or it throws), a `meta`
   * `get_message` simply returns the meta shape rather than enriching — the
   * server stays usable read-only without provider creds.
   */
  buildSource?: (account: AccountConfig) => MailSource;
  /** Spawn the detached incremental sync for stale time-sensitive reads (ADR-0005). */
  backgroundSync?: BackgroundSync;
  /** Clock seam for deterministic freshness tests. Defaults to `Date`. */
  now?: () => Date;
}

/** The freshness staleness threshold for time-sensitive reads (ADR-0005): ~12h.
 * Per-account override is a v1.x follow-up; this global default matches the ADR. */
export const STALE_AFTER_MS = 12 * 60 * 60 * 1000;
/** Reported ETA for a spawned background incremental sync (ADR-0005). */
export const SYNC_ETA_SECONDS = 90;

// ---- freshness (ADR-0005) -------------------------------------------------

/**
 * The `index_as_of` for an account: the latest finished, error-free sync run.
 * Cross-account (no `account`) returns the OLDEST such timestamp across accounts
 * — the index is only as fresh as its stalest mailbox. Null when never synced.
 */
function indexAsOf(repo: Repo, account?: string): string | null {
  if (account) {
    const row = repo.db
      .prepare(
        `SELECT finished_at FROM sync_runs
          WHERE account = ? AND finished_at IS NOT NULL AND error IS NULL
          ORDER BY finished_at DESC LIMIT 1`,
      )
      .get(account) as { finished_at: string | null } | undefined;
    return row?.finished_at ?? null;
  }
  const rows = repo.db
    .prepare(
      `SELECT account, max(finished_at) AS f FROM sync_runs
        WHERE finished_at IS NOT NULL AND error IS NULL
        GROUP BY account`,
    )
    .all() as { account: string; f: string | null }[];
  if (rows.length === 0) return null;
  let oldest: string | null = null;
  for (const r of rows) {
    if (r.f == null) continue;
    if (oldest == null || r.f < oldest) oldest = r.f;
  }
  return oldest;
}

/** A response carrying the ADR-0005 freshness stamp. */
export interface WithMeta {
  index_as_of: string | null;
}

/** Stamp `index_as_of` onto a result object (ADR-0005: every response carries it). */
function withMeta<T extends object>(repo: Repo, account: string | undefined, body: T): T & WithMeta {
  return { ...body, index_as_of: indexAsOf(repo, account) };
}

// ---- command handbacks (ADR-0001) ----------------------------------------

/** Quote a CLI argument for the handback string when it contains whitespace. */
function quoteArg(v: string): string {
  return /\s/.test(v) ? `'${v.replace(/'/g, "'\\''")}'` : v;
}

/** Build a `mail-index <args...>` command-handback string (CONTEXT.md). */
export function handback(...args: string[]): string {
  return ['mail-index', ...args.map(quoteArg)].join(' ');
}

// ---- compact projections (DESIGN TEST b: token-conscious) -----------------

/** The `<account>:<id>` ref the CLI `show`/`open` consume (shared handle). */
function messageRef(row: Pick<MessageRow, 'account' | 'gmail_message_id'>): string {
  return `${row.account}:${row.gmail_message_id}`;
}

/** Collapse a snippet to one capped line for skimmability. */
function compactSnippet(snippet: string | null, max = 160): string | null {
  if (!snippet) return null;
  const one = snippet.replace(/\s+/g, ' ').trim();
  if (one === '') return null;
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

function isoDate(internalDate: number | null): string | null {
  if (internalDate == null) return null;
  const d = new Date(internalDate);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A compact search/thread hit row — snippet-first, never the body. */
export interface HitShape {
  ref: string;
  account: string;
  from: string | null;
  subject: string | null;
  date: string | null;
  snippet: string | null;
  body_state: string;
  has_summary: boolean;
  unread: boolean;
  direction: string;
}

function toHit(row: MessageRow): HitShape {
  return {
    ref: messageRef(row),
    account: row.account,
    from: row.from_addr,
    subject: row.subject,
    date: isoDate(row.internal_date),
    snippet: compactSnippet(row.snippet),
    body_state: row.body_state,
    has_summary: row.summary_text != null,
    unread: row.unread === 1,
    direction: row.direction,
  };
}

/** A compact contact shape for list/find/get. */
export interface ContactShape {
  address: string;
  account: string;
  displayName: string | null;
  domain: string | null;
  msgsReceived: number;
  msgsSent: number;
  correspondent: boolean;
  repliedCount: number;
  starredCount: number;
  importantCount: number;
  lastSeen: string | null;
  engagementScore: number | null;
  centrality: number | null;
  communityId: number | null;
  curation: Curation | null;
}

function toContact(row: ContactDetailRow): ContactShape {
  return {
    address: row.address,
    account: row.account,
    displayName: row.display_name,
    domain: row.domain,
    msgsReceived: row.msgs_received,
    msgsSent: row.msgs_sent,
    correspondent: row.msgs_sent > 0,
    repliedCount: row.replied_count,
    starredCount: row.starred_count,
    importantCount: row.important_count,
    lastSeen: row.last_seen,
    engagementScore: row.engagement_score,
    centrality: row.centrality,
    communityId: row.community_id,
    curation: row.curation,
  };
}

/** A compact thread shape (metadata + summary presence; never the bodies). */
export interface ThreadShape {
  ref: string;
  account: string;
  subject: string | null;
  msgCount: number;
  unreadCount: number;
  userParticipated: boolean;
  firstAt: string | null;
  lastAt: string | null;
  hasSummary: boolean;
}

function toThread(row: ThreadRow): ThreadShape {
  return {
    ref: `${row.account}:${row.thread_id}`,
    account: row.account,
    subject: row.subject,
    msgCount: row.msg_count,
    unreadCount: row.unread_count,
    userParticipated: row.user_participated === 1,
    firstAt: row.first_at,
    lastAt: row.last_at,
    hasSummary: row.summary_text != null,
  };
}

/** Parse an `<account>:<id>` ref (message id or thread id), both sides non-empty. */
export function parseToolRef(raw: string): { account: string; id: string } {
  const idx = raw.indexOf(':');
  if (idx <= 0 || idx === raw.length - 1) {
    throw new McpToolError(
      `invalid reference "${raw}" — expected <account>:<id> (e.g. personal:18f0a1b2c3)`,
    );
  }
  return { account: raw.slice(0, idx), id: raw.slice(idx + 1) };
}

// =========================================================================
// PRIMITIVES (PLAN §12)
// =========================================================================

export interface SearchArgs {
  query: string;
  account?: string;
  limit?: number;
}

/**
 * `search` — ranked FTS recall, snippet-first (PLAN §12, DESIGN TEST recall).
 * Fuzzy: each term is a prefix-matched, OR-combined FTS literal (shared with the
 * CLI's {@link buildFtsQuery}), so a half-remembered detail still surfaces
 * neighbours rather than nothing. Never dumps bodies — the agent opts in per hit
 * via `get_message`.
 */
export function search(ctx: ToolContext, args: SearchArgs): WithMeta & { hits: HitShape[] } {
  const terms = args.query.split(/\s+/).filter((t) => t !== '');
  const q = buildFtsQuery(terms);
  const rows = q === '' ? [] : ctx.repo.searchMessages(q, {
    ...(args.account ? { account: args.account } : {}),
    limit: args.limit ?? 15,
  });
  return withMeta(ctx.repo, args.account, { hits: rows.map(toHit) });
}

export interface GetMessageArgs {
  ref: string;
  /**
   * What to return (PLAN §12): `summary` → the agent summary if present else the
   * distilled/snippet; `body` → the distilled body (inline-enriching a `meta` row
   * once, ADR-0001 O(1)); `meta` → headers + snippet only, no fetch. Default:
   * `summary` (token-conscious — the cheapest informative shape).
   */
  level?: 'summary' | 'body' | 'meta';
}

/** Full single-message detail. The body is opt-in via `level: 'body'`. */
export interface MessageDetail extends WithMeta {
  ref: string;
  account: string;
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  date: string | null;
  threadRef: string | null;
  category: string | null;
  unread: boolean;
  starred: boolean;
  important: boolean;
  isList: boolean;
  direction: string;
  bodyState: string;
  summary: string | null;
  /** The distilled body — only populated at `level: 'body'`. */
  body: string | null;
  snippet: string | null;
  /** True when this call performed the single O(1) inline enrich (ADR-0001). */
  enriched: boolean;
}

/**
 * `get_message` — the ladder summary → distilled body → inline-enrich (PLAN §12,
 * ADR-0001). At `level: 'body'` a still-`meta` row is enriched with the ONE
 * permitted inline O(1) provider fetch (gated on a source being wired in); every
 * other level reads the index only. Bodies are opt-in (token-conscious).
 */
export async function getMessage(ctx: ToolContext, args: GetMessageArgs): Promise<MessageDetail> {
  const { account, id } = parseToolRef(args.ref);
  const level = args.level ?? 'summary';
  let row = ctx.repo.getMessage(account, id);
  if (!row) {
    throw new McpToolError(
      `message ${account}:${id} is not in the index — sync the account first ` +
        `(${handback('sync', '--account', account)})`,
    );
  }

  let enriched = false;
  // ADR-0001: ONE bounded inline fetch, only when the agent asked for the body
  // and the row is still meta, and only when a source is wired in.
  if (level === 'body' && row.body_state === 'meta' && ctx.buildSource) {
    try {
      const accCfg = ctx.config.accounts[account];
      if (accCfg) {
        const source = ctx.buildSource(accCfg);
        enriched = await enrichOne({ account, id, source, repo: ctx.repo });
        const refreshed = ctx.repo.getMessage(account, id);
        if (refreshed) row = refreshed;
      }
    } catch {
      // Best-effort inline enrich: a fetch failure falls back to the meta shape
      // (read-only resilience; the agent can run `show` via a handback instead).
    }
  }

  const body = level === 'body' && row.body_state === 'full' ? row.body_text : null;
  return withMeta(ctx.repo, account, {
    ref: messageRef(row),
    account: row.account,
    from: row.from_addr,
    to: row.to_addr,
    cc: row.cc_addr,
    subject: row.subject,
    date: isoDate(row.internal_date),
    threadRef: row.thread_id ? `${row.account}:${row.thread_id}` : null,
    category: row.category,
    unread: row.unread === 1,
    starred: row.starred === 1,
    important: row.important === 1,
    isList: row.is_list === 1,
    direction: row.direction,
    bodyState: row.body_state,
    summary: row.summary_text,
    body,
    snippet: compactSnippet(row.snippet),
    enriched,
  });
}

export interface GetThreadArgs {
  ref: string;
}

/** `get_thread` — thread metadata + its messages + the thread summary (PLAN §12). */
export function getThread(
  ctx: ToolContext,
  args: GetThreadArgs,
): WithMeta & {
  thread: ThreadShape | null;
  summary: string | null;
  messages: HitShape[];
} {
  const { account, id } = parseToolRef(args.ref);
  const row = ctx.repo.getThread(account, id);
  const messages = ctx.repo.threadMessages(account, id);
  if (!row && messages.length === 0) {
    throw new McpToolError(`thread ${account}:${id} is not in the index`);
  }
  return withMeta(ctx.repo, account, {
    thread: row ? toThread(row) : null,
    summary: row?.summary_text ?? null,
    messages: messages.map(toHit),
  });
}

export interface ListContactsArgs {
  account?: string;
  sort?: ContactSort;
  /** `correspondent` | a curation label (`important`/`muted`/`blocked`). */
  filter?: string;
  limit?: number;
}

/** `list_contacts` — ranked, filterable contact list (PLAN §12, DESIGN TEST recall). */
export function listContacts(
  ctx: ToolContext,
  args: ListContactsArgs,
): WithMeta & { contacts: ContactShape[] } {
  const filter: { correspondent?: boolean; curation?: Curation } = {};
  if (args.filter === 'correspondent') filter.correspondent = true;
  else if (args.filter && (CURATIONS as readonly string[]).includes(args.filter)) {
    filter.curation = args.filter as Curation;
  }
  const rows = ctx.repo.listContacts({
    ...(args.account ? { account: args.account } : {}),
    ...(args.sort ? { sort: args.sort } : {}),
    filter,
    limit: args.limit ?? 20,
  });
  return withMeta(ctx.repo, args.account, { contacts: rows.map(toContact) });
}

export interface GetContactArgs {
  address: string;
  account?: string;
}

/**
 * `get_contact` — one contact's stats, curation, and recent threads (PLAN §12).
 * Resolves the contact across accounts when `account` is omitted (first match).
 * On a non-exact hit it falls back to {@link findContacts} so a near-miss returns
 * the ranked candidates rather than nothing (DESIGN TEST recall).
 */
export function getContact(
  ctx: ToolContext,
  args: GetContactArgs,
): WithMeta & {
  contact: ContactShape | null;
  recentThreads: ThreadShape[];
  candidates?: ContactShape[];
} {
  let account = args.account;
  let row = account ? ctx.repo.getContactDetail(account, args.address) : undefined;
  if (!row && !account) {
    // Cross-account exact resolution: the first account that has the address.
    const found = ctx.repo
      .findContacts(args.address, { limit: 25 })
      .find((c) => c.address === args.address);
    if (found) {
      account = found.account;
      row = found;
    }
  }
  if (!row) {
    // Near-miss: return ranked candidates so the answer is never a bare empty.
    const candidates = ctx.repo
      .findContacts(args.address, { ...(account ? { account } : {}), limit: 10 })
      .map(toContact);
    return withMeta(ctx.repo, account, { contact: null, recentThreads: [], candidates });
  }
  const recentThreads = ctx.repo.threadsForContact(row.account, row.address, 10).map(toThread);
  return withMeta(ctx.repo, row.account, { contact: toContact(row), recentThreads });
}

export interface FindPersonArgs {
  hint: string;
  account?: string;
  limit?: number;
}

/**
 * `find_person` — fuzzy contact resolution from a vague hint (PLAN §12, the
 * entry point for "who was that insurance contact from last spring?"). Ranks
 * Correspondents FIRST (people remember by who they talked to) and matches
 * substrings of name/address/domain, so a half-remembered fragment resolves and
 * never returns a bare empty set where a near-miss exists (DESIGN TEST recall).
 */
export function findPerson(
  ctx: ToolContext,
  args: FindPersonArgs,
): WithMeta & { matches: ContactShape[] } {
  const rows = ctx.repo.findContacts(args.hint, {
    ...(args.account ? { account: args.account } : {}),
    limit: args.limit ?? 10,
  });
  return withMeta(ctx.repo, args.account, { matches: rows.map(toContact) });
}

export interface ListThreadsArgs {
  contact?: string;
  query?: string;
  account?: string;
  limit?: number;
}

/** `list_threads` — conversations by contact OR by query (PLAN §12). */
export function listThreads(
  ctx: ToolContext,
  args: ListThreadsArgs,
): WithMeta & { threads: ThreadShape[] } {
  let rows: ThreadRow[];
  if (args.contact) {
    // By-contact needs an account to scope the participant search; default to
    // the contact's resolved account when omitted.
    let account = args.account;
    if (!account) {
      const found = ctx.repo.findContacts(args.contact, { limit: 1 })[0];
      account = found?.account;
    }
    rows = account ? ctx.repo.threadsForContact(account, args.contact, args.limit ?? 20) : [];
  } else if (args.query) {
    const q = buildFtsQuery(args.query.split(/\s+/).filter((t) => t !== ''));
    rows = q === '' ? [] : ctx.repo.threadsForQuery(q, {
      ...(args.account ? { account: args.account } : {}),
      limit: args.limit ?? 20,
    });
  } else {
    throw new McpToolError('list_threads requires either "contact" or "query"');
  }
  return withMeta(ctx.repo, args.account, { threads: rows.map(toThread) });
}

export interface GraphNeighborsArgs {
  address: string;
  account?: string;
  limit?: number;
}

/**
 * `graph_neighbors` — ranked co-recipiency neighbours of a contact (PLAN §12,
 * D8/D9). On a miss (no non-list co-recipients, or no graph built) it falls back
 * to ranked near-misses via {@link findContacts} so the answer is never a bare
 * empty set (DESIGN TEST recall); `fallback` flags that.
 */
export function graphNeighbors(
  ctx: ToolContext,
  args: GraphNeighborsArgs,
): WithMeta & { neighbors: GraphNeighborRow[]; fallback: boolean } {
  let account = args.account;
  if (!account) {
    const found = ctx.repo.findContacts(args.address, { limit: 1 })[0];
    account = found?.account;
  }
  const neighbors = account
    ? ctx.repo.graphNeighbors(account, args.address, args.limit ?? 15)
    : [];
  if (neighbors.length > 0) {
    return withMeta(ctx.repo, account, { neighbors, fallback: false });
  }
  // Near-miss fallback: project the ranked contact candidates as zero-weight
  // neighbours so the agent still gets ranked entry points.
  const fb = ctx.repo.findContacts(args.address, { ...(account ? { account } : {}), limit: 10 });
  return withMeta(ctx.repo, account, {
    neighbors: fb
      .filter((c) => c.address !== args.address)
      .map((c) => ({
        address: c.address,
        display_name: c.display_name,
        domain: c.domain,
        shared_threads: 0,
        engagement_score: c.engagement_score,
        centrality: c.centrality,
        community_id: c.community_id,
      })),
    fallback: true,
  });
}

export interface GraphCommunitiesArgs {
  account?: string;
  memberLimit?: number;
}

/** `graph_communities` — detected social circles (PLAN §12, D8). */
export function graphCommunities(
  ctx: ToolContext,
  args: GraphCommunitiesArgs,
): WithMeta & {
  communities: ReturnType<Repo['graphCommunities']>;
  /** A handback to (re)build the graph when none exists (ADR-0001, O(N)). */
  build_command?: string;
} {
  // Communities require an account scope (community ids are per-account); default
  // to the sole account when omitted.
  const account = args.account ?? soleAccount(ctx);
  const communities = account
    ? ctx.repo.graphCommunities(account, args.memberLimit ?? 10)
    : [];
  const body: { communities: typeof communities; build_command?: string } = { communities };
  if (communities.length === 0 && account) {
    body.build_command = handback('graph', 'build', '--account', account);
  }
  return withMeta(ctx.repo, account, body);
}

// ---- curation write-back loop (M3.1, PLAN §11) ----------------------------

export interface InterestProposeArgs {
  account?: string;
  contactLimit?: number;
  domainLimit?: number;
}

/** `interest_propose` — the curation SEED shortlist (PLAN §11/§12, D13). */
export function interestPropose(ctx: ToolContext, args: InterestProposeArgs): WithMeta & {
  proposal: ReturnType<typeof propose>;
} {
  const account = requireAccount(ctx, args.account, 'interest_propose');
  const proposal = propose(ctx.repo, account, {
    ...(args.contactLimit != null ? { contactLimit: args.contactLimit } : {}),
    ...(args.domainLimit != null ? { domainLimit: args.domainLimit } : {}),
  });
  return withMeta(ctx.repo, account, { proposal });
}

export interface InterestSetArgs {
  account?: string;
  contacts?: { address: string; curation: Curation | null }[];
  domains?: { domain: string; curation: Curation | null }[];
  keywords?: string[];
}

/** `interest_set` — persist the curation disposition (PLAN §11/§12, D14). */
export function interestSet(ctx: ToolContext, args: InterestSetArgs): WithMeta & {
  result: ReturnType<typeof curationSet>;
} {
  const account = requireAccount(ctx, args.account, 'interest_set');
  const result = curationSet(ctx.repo, account, {
    ...(args.contacts ? { contacts: args.contacts } : {}),
    ...(args.domains ? { domains: args.domains } : {}),
    ...(args.keywords ? { keywords: args.keywords } : {}),
  });
  return withMeta(ctx.repo, account, { result });
}

export interface InterestGetArgs {
  account?: string;
}

/** `interest_get` — read back the curated profile (PLAN §11/§12). */
export function interestGet(ctx: ToolContext, args: InterestGetArgs): WithMeta & {
  profile: ReturnType<typeof curationGet>;
} {
  const account = requireAccount(ctx, args.account, 'interest_get');
  return withMeta(ctx.repo, account, { profile: curationGet(ctx.repo, account) });
}

// ---- summarization write-back (M3.5, ADR-0003) ----------------------------

export interface SaveSummaryArgs {
  ref: string;
  text: string;
  /** `message` (default) or `thread`. */
  level?: 'message' | 'thread';
}

/** `save_summary` — persist an agent summary at message/thread level (PLAN §12, ADR-0003). */
export function saveSummaryTool(ctx: ToolContext, args: SaveSummaryArgs): WithMeta & {
  result: ReturnType<typeof saveSummary>;
} {
  const { account, id } = parseToolRef(args.ref);
  const level = args.level ?? 'message';
  const result = saveSummary(ctx.repo, account, level, id, args.text);
  return withMeta(ctx.repo, account, { result });
}

// ---- domain categorization write-back (M3.5, PLAN §12) --------------------

export interface DomainsToCategorizeArgs {
  account?: string;
  includeCategorized?: boolean;
  limit?: number;
}

/** `domains_to_categorize` — PROPOSE domains for the categorization loop (PLAN §12). */
export function domainsToCategorizeTool(
  ctx: ToolContext,
  args: DomainsToCategorizeArgs,
): WithMeta & { candidates: ReturnType<typeof wbDomainsToCategorize> } {
  const account = requireAccount(ctx, args.account, 'domains_to_categorize');
  const candidates = wbDomainsToCategorize(ctx.repo, account, {
    ...(args.includeCategorized != null ? { includeCategorized: args.includeCategorized } : {}),
    ...(args.limit != null ? { limit: args.limit } : {}),
  });
  return withMeta(ctx.repo, account, { candidates });
}

export interface SaveDomainCategoryArgs {
  domain: string;
  category: string;
  note?: string;
  account?: string;
}

/** `save_domain_category` — PERSIST an agent-assigned domain category (PLAN §12). */
export function saveDomainCategoryTool(
  ctx: ToolContext,
  args: SaveDomainCategoryArgs,
): WithMeta & { result: ReturnType<typeof wbSaveDomainCategory> } {
  const account = requireAccount(ctx, args.account, 'save_domain_category');
  const result = wbSaveDomainCategory(ctx.repo, account, args.domain, args.category, args.note ?? null);
  return withMeta(ctx.repo, account, { result });
}

// ---- sync status (PLAN §12, ADR-0005) -------------------------------------

export interface SyncStatusArgs {
  account?: string;
}

/** Per-account freshness/shape, the ADR-0005 freshness contract surfaced to the agent. */
export interface SyncStatusEntry {
  account: string;
  index_as_of: string | null;
  syncing: boolean;
  messages: number;
  bodyStates: { meta: number; full: number; 'summary-only': number };
}

/** `sync_status` — counts, last run, body-ladder split, freshness (PLAN §12). */
export function syncStatus(ctx: ToolContext, args: SyncStatusArgs): WithMeta & {
  accounts: SyncStatusEntry[];
} {
  const labels = args.account ? [args.account] : discoverAccounts(ctx.repo);
  const accounts: SyncStatusEntry[] = labels.map((account) => {
    const counts = { meta: 0, full: 0, 'summary-only': 0 };
    const rows = ctx.repo.db
      .prepare(`SELECT body_state, count(*) c FROM messages WHERE account = ? GROUP BY body_state`)
      .all(account) as { body_state: string; c: number }[];
    for (const r of rows) {
      if (r.body_state === 'meta' || r.body_state === 'full' || r.body_state === 'summary-only') {
        counts[r.body_state] = r.c;
      }
    }
    return {
      account,
      index_as_of: indexAsOf(ctx.repo, account),
      syncing: ctx.repo.activeSyncRun(account) != null,
      messages: ctx.repo.countMessages(account),
      bodyStates: counts,
    };
  });
  return withMeta(ctx.repo, args.account, { accounts });
}

// =========================================================================
// COMPOSITES (PLAN §12) — SQL views over the index, stale → background sync
// =========================================================================

export interface CatchUpArgs {
  since: string;
  account?: string;
}

/** A catch_up section's compact rows + a handback to read the bodies in bulk. */
export interface CatchUpResult extends WithMeta {
  since_ms: number;
  /** New mail from curated-important contacts. */
  fromImportant: HitShape[];
  /** New replies in threads the user took part in. */
  inUserThreads: HitShape[];
  /** Interest-keyword hits. */
  keywordHits: HitShape[];
  /** Command handback to enrich the surfaced bodies (ADR-0001, O(N)). */
  bodies_command: string;
  /** ADR-0005: set when this stale read spawned a detached incremental sync. */
  sync_started?: boolean;
  eta_seconds?: number;
}

/**
 * `catch_up` — the "what did I miss" briefing (PLAN §12). Three compact feeds
 * since `since`: new mail from curated-important contacts, new replies in
 * user-participated threads, and interest-keyword hits. Bodies are NOT fetched
 * (O(N)) — a command handback enriches them. When the index is stale (ADR-0005)
 * it returns current data immediately AND spawns a detached incremental sync,
 * reporting `sync_started` + `eta_seconds`; it never blocks.
 */
export function catchUp(ctx: ToolContext, args: CatchUpArgs): CatchUpResult {
  const account = requireAccount(ctx, args.account, 'catch_up');
  const sinceMs = parseSince(args.since, ctx.now?.() ?? new Date());

  const fromImportant = ctx.repo.db
    .prepare(catchUpFromImportantSql())
    .all(account, sinceMs) as unknown as MessageRow[];
  const inUserThreads = ctx.repo.db
    .prepare(catchUpUserThreadsSql())
    .all(account, sinceMs) as unknown as MessageRow[];

  const keywords = ctx.repo.getInterestProfile(account).keywords;
  let keywordHits: MessageRow[] = [];
  if (keywords.length > 0) {
    const q = keywords.map((k) => `"${k.replace(/"/g, '""')}"`).join(' OR ');
    keywordHits = ctx.repo.db
      .prepare(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
          WHERE messages_fts MATCH ? AND m.account = ? AND m.internal_date >= ?
          ORDER BY m.internal_date DESC LIMIT 25`,
      )
      .all(q, account, sinceMs) as unknown as MessageRow[];
  }

  const base: CatchUpResult = withMeta(ctx.repo, account, {
    since_ms: sinceMs,
    fromImportant: fromImportant.map(toHit),
    inUserThreads: inUserThreads.map(toHit),
    keywordHits: keywordHits.map(toHit),
    bodies_command: handback('enrich', '--account', account, '--profile'),
  });
  return applyStaleSync(ctx, account, base);
}

export interface DigestSourcesArgs {
  since?: string;
  account?: string;
}

/** A digest source: a newsletter/list sender ranked by engagement + interest. */
export interface DigestSource {
  address: string;
  displayName: string | null;
  domain: string | null;
  engagementScore: number | null;
  curation: Curation | null;
  /** Issues received (optionally since `since`). */
  issues: number;
  /** Unread issues. */
  unread: number;
  /** Issues with no agent summary yet (the digest loop's worklist). */
  unsummarized: number;
}

export interface DigestSourcesResult extends WithMeta {
  sources: DigestSource[];
  /** Per-issue read loop handback (the digest routine, PLAN §12). */
  read_command: string;
  sync_started?: boolean;
  eta_seconds?: number;
}

/**
 * `digest_sources` — newsletter/list senders ranked by engagement + interest,
 * with unread/unsummarized counts (PLAN §12). The digest routine then loops:
 * `digest_sources` → `get_message` per issue → `save_summary` → bodies demote
 * (ADR-0003). Like `catch_up`, a stale index returns current data immediately
 * and spawns a detached incremental sync (ADR-0005).
 */
export function digestSources(ctx: ToolContext, args: DigestSourcesArgs): DigestSourcesResult {
  const account = requireAccount(ctx, args.account, 'digest_sources');
  const sinceMs = args.since ? parseSince(args.since, ctx.now?.() ?? new Date()) : 0;

  const rows = ctx.repo.db
    .prepare(digestSourcesSql())
    .all(account, sinceMs) as {
      address: string;
      display_name: string | null;
      domain: string | null;
      engagement_score: number | null;
      curation: Curation | null;
      issues: number;
      unread: number;
      unsummarized: number;
    }[];

  const base: DigestSourcesResult = withMeta(ctx.repo, account, {
    sources: rows.map((r) => ({
      address: r.address,
      displayName: r.display_name,
      domain: r.domain,
      engagementScore: r.engagement_score,
      curation: r.curation,
      issues: r.issues,
      unread: r.unread,
      unsummarized: r.unsummarized,
    })),
    read_command: handback('search', '<sender or subject>', '--account', account),
  });
  return applyStaleSync(ctx, account, base);
}

// ---- stale-read background sync (ADR-0005) --------------------------------

/**
 * If the account's index is stale (older than {@link STALE_AFTER_MS}) and no
 * sync is already running, spawn a DETACHED incremental sync and annotate the
 * result with `sync_started` + `eta_seconds` (ADR-0005). Never blocks; the
 * debounce (no sync started when one is in flight, or when fresh) lives here so
 * both composites share it. The actual detached spawn is `ctx.backgroundSync`.
 */
function applyStaleSync<T extends { sync_started?: boolean; eta_seconds?: number }>(
  ctx: ToolContext,
  account: string,
  result: T,
): T {
  const asOf = indexAsOf(ctx.repo, account);
  const now = (ctx.now?.() ?? new Date()).getTime();
  const stale = asOf == null || now - new Date(asOf).getTime() > STALE_AFTER_MS;
  if (!stale) return result;
  // Debounce: never two writers (WAL is on; the sync_runs lock is the guard).
  if (ctx.repo.activeSyncRun(account) != null) return result;
  if (!ctx.backgroundSync) return result;
  // ADR-0005: the background sweep must be INCREMENTAL, never a full sweep. Derive
  // a relative `--since` from the last-synced timestamp (Gmail `newer_than:` takes
  // relative tokens, not ISO) — days elapsed + 1 day of overlap (idempotent upsert
  // makes re-fetching the boundary day harmless). A never-synced account (asOf null)
  // passes no `since`, so its first sweep is a correct initial full sync.
  const since =
    asOf == null
      ? undefined
      : `${Math.ceil((now - new Date(asOf).getTime()) / 86_400_000) + 1}d`;
  const started = ctx.backgroundSync(account, since);
  if (started) {
    result.sync_started = true;
    result.eta_seconds = SYNC_ETA_SECONDS;
  }
  return result;
}

// ---- shared SQL + helpers -------------------------------------------------

function catchUpFromImportantSql(): string {
  // New mail since cutoff from a curated-important contact (or important domain).
  return `SELECT m.* FROM messages m
           WHERE m.account = ? AND m.internal_date >= ? AND m.direction = 'received'
             AND (
               EXISTS (
                 SELECT 1 FROM contacts c
                  WHERE c.account = m.account AND c.curation = 'important'
                    AND (m.from_addr = c.address OR lower(m.from_addr) LIKE '%<' || lower(c.address) || '>%')
               )
               OR EXISTS (
                 SELECT 1 FROM domains d
                  WHERE d.account = m.account AND d.curation = 'important'
                    AND (lower(m.from_addr) LIKE '%@' || lower(d.domain) OR lower(m.from_addr) LIKE '%@' || lower(d.domain) || '>%')
               )
             )
           ORDER BY m.internal_date DESC LIMIT 25`;
}

function catchUpUserThreadsSql(): string {
  // New replies since cutoff in threads the user took part in.
  return `SELECT m.* FROM messages m
            JOIN threads t ON t.account = m.account AND t.thread_id = m.thread_id
           WHERE m.account = ? AND m.internal_date >= ?
             AND t.user_participated = 1 AND m.direction = 'received'
           ORDER BY m.internal_date DESC LIMIT 25`;
}

function digestSourcesSql(): string {
  // List/bulk senders ranked by engagement then volume, with issue counts.
  return `SELECT c.address, c.display_name, c.domain, c.engagement_score, c.curation,
                 count(m.gmail_message_id) AS issues,
                 sum(CASE WHEN m.unread = 1 THEN 1 ELSE 0 END) AS unread,
                 sum(CASE WHEN m.summary_text IS NULL THEN 1 ELSE 0 END) AS unsummarized
            FROM contacts c
            JOIN messages m
              ON m.account = c.account
             AND (m.from_addr = c.address OR lower(m.from_addr) LIKE '%<' || lower(c.address) || '>%')
           WHERE c.account = ?
             AND m.direction = 'received'
             AND m.internal_date >= ?
             AND (m.is_list = 1 OR m.category IN ('promotions','social','updates','forums'))
           GROUP BY c.account, c.address
          HAVING issues > 0
           ORDER BY c.engagement_score IS NULL, c.engagement_score DESC, issues DESC, c.address ASC
           LIMIT 20`;
}

/**
 * Parse a `since` token into an epoch-ms cutoff: a relative `<n>[dwhmo]` token
 * (`30d`, `2w`, `12h`, `1mo`) or an ISO-8601 timestamp. Relative tokens subtract
 * from `now`. Throws {@link McpToolError} on an unparseable token.
 */
export function parseSince(since: string, now: Date): number {
  const s = since.trim();
  const rel = /^(\d+)\s*(mo|[dwhm])$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms =
      unit === 'mo'
        ? n * 30 * 24 * 60 * 60 * 1000
        : unit === 'w'
          ? n * 7 * 24 * 60 * 60 * 1000
          : unit === 'd'
            ? n * 24 * 60 * 60 * 1000
            : unit === 'h'
              ? n * 60 * 60 * 1000
              : n * 60 * 1000; // 'm' = minutes
    return now.getTime() - ms;
  }
  const ts = Date.parse(s);
  if (!Number.isNaN(ts)) return ts;
  throw new McpToolError(
    `invalid "since" "${since}" — expected a relative token (30d, 2w, 12h, 1mo) or an ISO timestamp`,
  );
}

/** Discover every account label that appears anywhere in the index. */
function discoverAccounts(repo: Repo): string[] {
  const rows = repo.db
    .prepare(
      `SELECT account FROM messages
       UNION SELECT account FROM contacts
       UNION SELECT account FROM sync_runs
       ORDER BY account`,
    )
    .all() as { account: string }[];
  return rows.map((r) => r.account);
}

/** The sole configured/indexed account, or undefined when ambiguous/none. */
function soleAccount(ctx: ToolContext): string | undefined {
  const cfg = Object.keys(ctx.config.accounts);
  if (cfg.length === 1) return cfg[0]!;
  const seen = discoverAccounts(ctx.repo);
  return seen.length === 1 ? seen[0]! : undefined;
}

/**
 * Resolve the account an account-scoped tool needs: the explicit arg, else the
 * sole configured/indexed account. Throws {@link McpToolError} when ambiguous so
 * the agent passes one rather than silently picking.
 */
function requireAccount(ctx: ToolContext, account: string | undefined, tool: string): string {
  if (account) return account;
  const sole = soleAccount(ctx);
  if (sole) return sole;
  const known = [...new Set([...Object.keys(ctx.config.accounts), ...discoverAccounts(ctx.repo)])];
  throw new McpToolError(
    `${tool} needs an "account" — configured/indexed: ${known.length ? known.join(', ') : '(none)'}`,
  );
}
