/**
 * MCP server wiring (SCOPE 3.4, PLAN §12, ADR-0001/0005).
 *
 * Turns the pure tool engine (`tools.ts`) into a stdio
 * `@modelcontextprotocol/sdk` Server. One {@link TOOLS} registry drives BOTH the
 * `tools/list` response (name + description + input JSON Schema) and the
 * `tools/call` dispatch (each entry's `run`), so the advertised schema and the
 * executed handler can never drift. The registry + {@link dispatch} are exported
 * so the golden-response tests exercise the exact surface the agent sees without
 * a live transport.
 *
 * The server is READ-ONLY on the mailbox (D15) — the only provider contact is
 * `get_message`'s single inline O(1) enrich (ADR-0001), wired via the
 * {@link ToolContext.buildSource} seam. O(N) work is returned as a command
 * handback by the tools themselves; the server never spawns bulk work inside a
 * request. Stale time-sensitive reads spawn a DETACHED `mail-index sync` child
 * (ADR-0005) via {@link spawnDetachedSync}, which outlives the request.
 */

import { spawn } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  search,
  getMessage,
  getThread,
  listContacts,
  getContact,
  findPerson,
  listThreads,
  graphNeighbors,
  graphCommunities,
  interestPropose,
  interestSet,
  interestGet,
  saveSummaryTool,
  domainsToCategorizeTool,
  saveDomainCategoryTool,
  syncStatus,
  catchUp,
  digestSources,
  McpToolError,
  type ToolContext,
} from './tools.js';
import { dispatchSetup, setupToolList } from './setup-tools.js';

/** A JSON Schema object (the subset the SDK advertises for `inputSchema`). */
type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

/** One registered tool: its advertised contract + its handler. */
interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Run the tool over the context with the (validated-by-schema) args. */
  run: (ctx: ToolContext, args: Record<string, unknown>) => unknown | Promise<unknown>;
}

const str = { type: 'string' as const };
const num = { type: 'integer' as const };
const bool = { type: 'boolean' as const };

function obj(
  properties: Record<string, unknown>,
  required: string[] = [],
): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * The full PLAN §12 surface — 18 tools (14 primitives incl. curation's three
 * propose/set/get and categorization's two, plus the two composites). Every entry advertises a compact
 * input schema and dispatches to the pure engine. Descriptions tell the agent
 * the recall-first, token-conscious contract (compact shapes, handbacks for
 * bulk work, `index_as_of` on every response).
 */
export const TOOLS: ToolDef[] = [
  // ---- primitives ----
  {
    name: 'search',
    description:
      'Ranked fuzzy full-text recall over the indexed mail (subject/sender/snippet/body/summaries). Snippet-first and compact (each row already has sender/subject/date) — open a full body with get_message only when you need details. Recall, not lookup: a half-remembered phrase still surfaces ranked neighbours. Use it for things like "what did I buy / order / pay for", receipts, invoices, order confirmations, bookings, travel, "find the email about X", "the message from the recruiter", a confirmation/booking number, etc. For aggregating purchases, search a sender or keyword (e.g. "Amazon order", "receipt") rather than fetching every message.',
    inputSchema: obj(
      { query: str, account: str, limit: num },
      ['query'],
    ),
    run: (ctx, a) =>
      search(ctx, { query: String(a['query']), ...optStr(a, 'account'), ...optNum(a, 'limit') }),
  },
  {
    name: 'get_message',
    description:
      'One message by <account:id>. level: "summary" (default — agent summary or snippet), "body" (distilled body; inline-enriches a still-meta row once, the only provider fetch), or "meta". Bodies are opt-in.',
    inputSchema: obj(
      { ref: str, level: { type: 'string', enum: ['summary', 'body', 'meta'] } },
      ['ref'],
    ),
    run: (ctx, a) =>
      getMessage(ctx, {
        ref: String(a['ref']),
        ...(a['level'] != null ? { level: a['level'] as 'summary' | 'body' | 'meta' } : {}),
      }),
  },
  {
    name: 'get_thread',
    description:
      'A thread by <account:thread-id>: metadata, its messages (compact, snippet-first), and the thread summary if present.',
    inputSchema: obj({ ref: str }, ['ref']),
    run: (ctx, a) => getThread(ctx, { ref: String(a['ref']) }),
  },
  {
    name: 'list_contacts',
    description:
      'Ranked contacts. sort: engagement (default) | volume | recency | community. filter: "correspondent" (people you have written to) | important | muted | blocked.',
    inputSchema: obj({
      account: str,
      sort: { type: 'string', enum: ['engagement', 'volume', 'recency', 'community'] },
      filter: str,
      limit: num,
    }),
    run: (ctx, a) =>
      listContacts(ctx, {
        ...optStr(a, 'account'),
        ...(a['sort'] != null ? { sort: a['sort'] as never } : {}),
        ...optStr(a, 'filter'),
        ...optNum(a, 'limit'),
      }),
  },
  {
    name: 'get_contact',
    description:
      'One contact by address: stats, curation, recent threads. A near-miss returns ranked candidates rather than nothing.',
    inputSchema: obj({ address: str, account: str }, ['address']),
    run: (ctx, a) => getContact(ctx, { address: String(a['address']), ...optStr(a, 'account') }),
  },
  {
    name: 'find_person',
    description:
      'Fuzzy contact resolution from a vague hint (name fragment, handle, or domain). Ranks Correspondents (people you have written to) first. The entry point for "who was that contact from last spring?".',
    inputSchema: obj({ hint: str, account: str, limit: num }, ['hint']),
    run: (ctx, a) =>
      findPerson(ctx, { hint: String(a['hint']), ...optStr(a, 'account'), ...optNum(a, 'limit') }),
  },
  {
    name: 'list_threads',
    description: 'Conversations by contact (address) OR by query (FTS). Compact thread shapes.',
    inputSchema: obj({ contact: str, query: str, account: str, limit: num }),
    run: (ctx, a) =>
      listThreads(ctx, {
        ...optStr(a, 'contact'),
        ...optStr(a, 'query'),
        ...optStr(a, 'account'),
        ...optNum(a, 'limit'),
      }),
  },
  {
    name: 'graph_neighbors',
    description:
      'Co-recipiency neighbours of a contact, ranked by shared threads. On a miss, returns ranked near-miss contacts so the answer is never empty.',
    inputSchema: obj({ address: str, account: str, limit: num }, ['address']),
    run: (ctx, a) =>
      graphNeighbors(ctx, {
        address: String(a['address']),
        ...optStr(a, 'account'),
        ...optNum(a, 'limit'),
      }),
  },
  {
    name: 'graph_communities',
    description:
      'Detected social circles (Louvain communities) with top members by centrality. Returns a build command handback when no graph exists yet.',
    inputSchema: obj({ account: str, memberLimit: num }),
    run: (ctx, a) => graphCommunities(ctx, { ...optStr(a, 'account'), ...optNum(a, 'memberLimit') }),
  },
  // ---- curation write-back loop ----
  {
    name: 'interest_propose',
    description:
      'The curation SEED: a ranked shortlist of top contacts + domains by engagement, each with a suggested action (important/muted/none). Present it, take fuzzy edits, then interest_set.',
    inputSchema: obj({ account: str, contactLimit: num, domainLimit: num }),
    run: (ctx, a) =>
      interestPropose(ctx, {
        ...optStr(a, 'account'),
        ...optNum(a, 'contactLimit'),
        ...optNum(a, 'domainLimit'),
      }),
  },
  {
    name: 'interest_set',
    description:
      'Persist the curation disposition: contact/domain curation labels (important/muted/blocked, or null to clear) and freeform interest keywords (replaces the set). This profile drives which bodies get enriched.',
    inputSchema: obj({
      account: str,
      contacts: {
        type: 'array',
        items: obj(
          { address: str, curation: { type: ['string', 'null'], enum: ['important', 'muted', 'blocked', null] } },
          ['address'],
        ),
      },
      domains: {
        type: 'array',
        items: obj(
          { domain: str, curation: { type: ['string', 'null'], enum: ['important', 'muted', 'blocked', null] } },
          ['domain'],
        ),
      },
      keywords: { type: 'array', items: str },
    }),
    run: (ctx, a) =>
      interestSet(ctx, {
        ...optStr(a, 'account'),
        ...(Array.isArray(a['contacts']) ? { contacts: a['contacts'] as never } : {}),
        ...(Array.isArray(a['domains']) ? { domains: a['domains'] as never } : {}),
        ...(Array.isArray(a['keywords']) ? { keywords: a['keywords'] as string[] } : {}),
      }),
  },
  {
    name: 'interest_get',
    description: 'Read back the curated interest profile: curated contacts/domains + keywords.',
    inputSchema: obj({ account: str }),
    run: (ctx, a) => interestGet(ctx, { ...optStr(a, 'account') }),
  },
  // ---- summarization write-back ----
  {
    name: 'save_summary',
    description:
      'Persist your summary of a message or thread (provenance-marked, FTS-indexed). level: "message" (default) or "thread". For bulk/non-curated mail this makes the body eligible for demotion after a grace window.',
    inputSchema: obj(
      { ref: str, text: str, level: { type: 'string', enum: ['message', 'thread'] } },
      ['ref', 'text'],
    ),
    run: (ctx, a) =>
      saveSummaryTool(ctx, {
        ref: String(a['ref']),
        text: String(a['text']),
        ...(a['level'] != null ? { level: a['level'] as 'message' | 'thread' } : {}),
      }),
  },
  // ---- domain categorization write-back ----
  {
    name: 'domains_to_categorize',
    description:
      'PROPOSE domains with back-and-forth contacts (Correspondents) plus sample senders/subjects as context, so you can assign an entity category. Then save_domain_category.',
    inputSchema: obj({ account: str, includeCategorized: bool, limit: num }),
    run: (ctx, a) =>
      domainsToCategorizeTool(ctx, {
        ...optStr(a, 'account'),
        ...(a['includeCategorized'] != null ? { includeCategorized: Boolean(a['includeCategorized']) } : {}),
        ...optNum(a, 'limit'),
      }),
  },
  {
    name: 'save_domain_category',
    description:
      'PERSIST an entity category you assigned to a domain (open vocabulary: client, vendor, travel operator, finance, publisher, …). Used as a filter/grouping axis.',
    inputSchema: obj({ domain: str, category: str, note: str, account: str }, ['domain', 'category']),
    run: (ctx, a) =>
      saveDomainCategoryTool(ctx, {
        domain: String(a['domain']),
        category: String(a['category']),
        ...optStr(a, 'note'),
        ...optStr(a, 'account'),
      }),
  },
  // ---- status + composites ----
  {
    name: 'sync_status',
    description:
      'Per-account freshness (index_as_of), whether a sync is running, message counts, and the meta/full/summary-only body-ladder split.',
    inputSchema: obj({ account: str }),
    run: (ctx, a) => syncStatus(ctx, { ...optStr(a, 'account') }),
  },
  {
    name: 'catch_up',
    description:
      'The "what did I miss" briefing since a time (30d, 2w, 12h, 1mo, or ISO): new mail from curated-important contacts, new replies in your threads, and interest-keyword hits. Compact rows + a body command handback. If the index is stale it returns now and spawns a background sync.',
    inputSchema: obj({ since: str, account: str }, ['since']),
    run: (ctx, a) => catchUp(ctx, { since: String(a['since']), ...optStr(a, 'account') }),
  },
  {
    name: 'digest_sources',
    description:
      'Newsletter/list senders ranked by engagement + interest, with unread/unsummarized issue counts — the digest routine worklist. Stale index returns now and spawns a background sync.',
    inputSchema: obj({ since: str, account: str }),
    run: (ctx, a) => digestSources(ctx, { ...optStr(a, 'since'), ...optStr(a, 'account') }),
  },
];

/** Pull an optional string arg into a spread-able partial (omit when absent). */
function optStr(a: Record<string, unknown>, key: string): Record<string, string> {
  return a[key] != null ? { [key]: String(a[key]) } : {};
}
/** Pull an optional numeric arg into a spread-able partial (omit when absent). */
function optNum(a: Record<string, unknown>, key: string): Record<string, number> {
  return a[key] != null ? { [key]: Number(a[key]) } : {};
}

/** Tool lookup by name (built once from {@link TOOLS}). */
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * Dispatch a `tools/call` to the named tool's handler (exported for the golden
 * tests). Throws {@link McpToolError} for an unknown tool. The result is the
 * tool's plain object — the server JSON-stringifies it into a text content block.
 */
export async function dispatch(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = BY_NAME.get(name);
  if (!tool) throw new McpToolError(`unknown tool "${name}"`);
  return tool.run(ctx, args);
}

/** The `tools/list` payload (exported for tests): name + description + schema. */
export function toolList(): { name: string; description: string; inputSchema: JsonSchema }[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/**
 * Build the stdio MCP {@link Server} bound to a {@link ToolContext}. Registers
 * the `tools/list` and `tools/call` handlers from the one {@link TOOLS} registry.
 * A tool error is returned as an `isError` content result (the MCP convention)
 * rather than throwing, so the client sees a clean tool error, not a transport
 * fault.
 */
export function buildServer(ctx: ToolContext): Server {
  const server = new Server(
    { name: 'mail-index', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      // Surfaced to the agent once at connect (no per-tool token cost). mail-index
      // has no telemetry, so feedback is explicit + opt-in: point the user at
      // GitHub. Nothing is ever sent automatically.
      instructions:
        'mail-index — local, read-only recall over THIS user\'s mailbox (Gmail), ' +
        'over MCP. REACH FOR THESE TOOLS WHENEVER a question could be answered from ' +
        'the user\'s email — even when no dedicated connector exists. That includes: ' +
        'what they bought / ordered / paid for (receipts, invoices, order ' +
        'confirmations, Amazon and other online purchases), bookings, travel, bills ' +
        'and subscriptions; what someone said or agreed; who emailed about X; a ' +
        'contact\'s address or details; newsletters; and "what did I miss / catch me ' +
        'up". Start with `search` (fuzzy, ranked, snippet-first), `find_person`, or ' +
        '`catch_up`; the snippet rows already carry sender/subject/date, so only call ' +
        '`get_message` for the few rows you actually need the full body of — do not ' +
        'fetch every result. Local-first and read-only: it never sends or changes ' +
        'mail. No telemetry — to report a bug or give feedback, help the user draft ' +
        'it and point them to https://github.com/alunsoldantarctica/mail-index/issues ' +
        '(nothing is sent automatically).',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolList() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await dispatch(ctx, name, (args ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });

  return server;
}

/** Connect the server to a fresh stdio transport (the production wiring). */
export async function serve(ctx: ToolContext): Promise<Server> {
  const server = buildServer(ctx);
  await server.connect(new StdioServerTransport());
  return server;
}

/**
 * Build the SETUP-MODE server (the self-bootstrapping fallback). When no
 * operator config exists, the recall surface cannot be served (no index), so
 * instead of exiting we serve the reduced, ADVISORY {@link SETUP_TOOLS} surface
 * (`setup_status` + `setup_instructions`) so the agent/user can self-onboard
 * from inside the session. These tools are read-only (PATH + filesystem
 * observation) and never spawn — the install/auth/config work stays in the CLI
 * (`mail-index setup`), preserving the server's no-new-spawn egress invariant.
 * Kept in a separate registry/module (setup-tools.ts) from the trusted recall
 * core for exactly that reason.
 */
export function buildSetupServer(): Server {
  const server = new Server(
    { name: 'mail-index', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'mail-index — SETUP MODE: no operator config found yet, so only onboarding ' +
        'tools are available. Call setup_status to see what is installed/configured ' +
        'and setup_instructions for the exact steps. The server is advisory only — ' +
        'run `mail-index setup --account <email>` in your shell, then restart this ' +
        'server to load the full read-only recall surface.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: setupToolList() }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = dispatchSetup(name, (args ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });

  return server;
}

/** Connect a setup-mode server to a fresh stdio transport. */
export async function serveSetup(): Promise<Server> {
  const server = buildSetupServer();
  await server.connect(new StdioServerTransport());
  return server;
}

/**
 * The ADR-0005 detached background sync: re-exec the `mail-index` CLI as a
 * DETACHED, unref'd child running an incremental sync for the account, so it
 * outlives the MCP request (a request-scoped child cannot, per ADR-0005). The
 * child takes the per-account sync lock itself, so two of these never both
 * write (WAL is on; the sync_runs lock is the guard). Returns true once spawned.
 * Best-effort: a spawn failure returns false rather than throwing into a read.
 */
export function spawnDetachedSync(account: string, since?: string): boolean {
  try {
    // ADR-0005: incremental, never a full sweep — pass the caller-derived
    // `--since` so an account with a whole-mailbox policy still syncs only the
    // recent window on a stale read.
    const args = [cliEntry(), 'sync', '--account', account];
    if (since) args.push('--since', since);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Resolve the sibling `mail-index` CLI entry next to this MCP entry in dist/. */
function cliEntry(): string {
  // dist/mcp/server.js → dist/cli/index.js
  return new URL('../cli/index.js', import.meta.url).pathname;
}
