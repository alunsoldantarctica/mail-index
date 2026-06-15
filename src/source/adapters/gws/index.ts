/**
 * The gws `MailSource` adapter (SCOPE 0.4, D1 — adapter #1, PLAN §7 two-phase
 * sync, §8 classification, §15 multi-account).
 *
 * Wraps the gws Google Workspace CLI by shelling out (via an injectable
 * {@link GwsRunner}) with the account's per-account
 * `GOOGLE_WORKSPACE_CLI_CONFIG_DIR`. It is the only place that knows the Gmail
 * REST JSON shape gws emits; it translates that into the provider-neutral
 * `MailSource` records the rest of the tool consumes (no Gmail JSON leaks above
 * this layer).
 *
 * Method → gws call mapping:
 *  - {@link GwsAdapter.check}       `gmail users getProfile`            (auth/identity probe)
 *  - {@link GwsAdapter.listIds}     `gmail users messages list`         (paged; honours scope)
 *  - {@link GwsAdapter.getMetadata} `gmail users messages get format=metadata`
 *  - {@link GwsAdapter.getFull}     `gmail users messages get format=full`
 *
 * §8 pitfall: `getMetadata` uses **plain** `format=metadata` and never passes
 * `metadataHeaders` — restricting headers through gws is unreliable and silently
 * drops `List-*` headers, which would break `is_list` classification.
 *
 * Distillation is NOT done here (CONTEXT.md "Enrichment"): `getFull` hands back
 * the body parts as gws/Gmail gave them (decoded from base64url to UTF-8), and
 * the ingest layer distills.
 */

import type {
  MailScope,
  MailSource,
  MessageFull,
  MessageMetadata,
  SourceIdentity,
} from '../../index.js';
import { type GwsRunner, GwsError, spawnGwsRunner } from './runner.js';

/** Construction options for {@link GwsAdapter}. */
export interface GwsAdapterOptions {
  /**
   * Per-account `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` — the isolated gws config for
   * this mailbox (from the operator config's `configDir`, §15).
   */
  configDir: string;
  /**
   * The gws invocation seam. Defaults to the process-backed {@link spawnGwsRunner};
   * tests inject a fixture-backed runner for replay with no network.
   */
  runner?: GwsRunner;
  /**
   * Page size for `messages list` (Gmail `maxResults`, max 500). Defaults to
   * 100 (the Gmail API default).
   */
  pageSize?: number;
}

/** Gmail `messages.list` response (only the fields the adapter reads). */
interface GmailListResponse {
  messages?: { id?: string; threadId?: string }[];
  nextPageToken?: string;
}

/** A header entry in a Gmail message payload. */
interface GmailHeader {
  name?: string;
  value?: string;
}

/** A Gmail message payload (recursive: MIME parts nest payloads). */
interface GmailPayload {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPayload[];
}

/** Gmail `messages.get` response (the fields the adapter maps). */
interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPayload;
}

/** Gmail `users.getProfile` response. */
interface GmailProfile {
  emailAddress?: string;
}

/** Case-insensitive lookup of a single header value from a payload. */
function header(payload: GmailPayload | undefined, name: string): string | null {
  const headers = payload?.headers;
  if (!headers) return null;
  const want = name.toLowerCase();
  for (const h of headers) {
    if (h.name?.toLowerCase() === want) return h.value ?? null;
  }
  return null;
}

/** Decode a Gmail base64url body part to a UTF-8 string. */
function decodeBody(data: string | undefined): string | null {
  if (!data) return null;
  // Gmail uses base64url (`-`/`_`); Buffer's 'base64url' handles it directly.
  return Buffer.from(data, 'base64url').toString('utf8');
}

/**
 * Walk a Gmail payload tree collecting the first text/plain and first text/html
 * body parts. Returns the decoded bodies + the mimeType the body was sourced
 * from (text/plain preferred for the distiller's `mimeType` hint).
 */
function extractBodies(payload: GmailPayload | undefined): {
  bodyText: string | null;
  bodyHtml: string | null;
  mimeType: string | null;
} {
  let bodyText: string | null = null;
  let bodyHtml: string | null = null;

  const visit = (p: GmailPayload | undefined): void => {
    if (!p) return;
    const mime = p.mimeType ?? '';
    if (mime === 'text/plain' && bodyText === null) {
      bodyText = decodeBody(p.body?.data);
    } else if (mime === 'text/html' && bodyHtml === null) {
      bodyHtml = decodeBody(p.body?.data);
    }
    // A non-multipart message carries its body on the top-level payload with no
    // parts; multipart messages nest text/* under `parts` (possibly deeper).
    if (p.parts) for (const child of p.parts) visit(child);
  };
  visit(payload);

  const mimeType = bodyText !== null ? 'text/plain' : bodyHtml !== null ? 'text/html' : null;
  return { bodyText, bodyHtml, mimeType };
}

/** Map a Gmail message resource to the provider-neutral metadata shape. */
function toMetadata(msg: GmailMessage): MessageMetadata {
  const internal = msg.internalDate;
  return {
    id: msg.id ?? '',
    threadId: msg.threadId ?? null,
    internalDate: internal != null && internal !== '' ? Number(internal) : null,
    dateHeader: header(msg.payload, 'Date'),
    from: header(msg.payload, 'From'),
    to: header(msg.payload, 'To'),
    cc: header(msg.payload, 'Cc'),
    subject: header(msg.payload, 'Subject'),
    labels: msg.labelIds ?? [],
    snippet: msg.snippet ?? null,
    sizeEstimate: msg.sizeEstimate ?? null,
  };
}

export class GwsAdapter implements MailSource {
  readonly provider = 'gws';
  readonly #configDir: string;
  readonly #runner: GwsRunner;
  readonly #pageSize: number;

  constructor(options: GwsAdapterOptions) {
    if (!options.configDir || options.configDir.trim() === '') {
      throw new GwsError('GwsAdapter requires a non-empty configDir');
    }
    this.#configDir = options.configDir;
    this.#runner = options.runner ?? spawnGwsRunner();
    this.#pageSize = options.pageSize ?? 100;
  }

  #run(args: readonly string[]): Promise<unknown> {
    return this.#runner(args, this.#configDir);
  }

  async check(): Promise<SourceIdentity> {
    try {
      const res = (await this.#run([
        'gmail',
        'users',
        'getProfile',
        '--params',
        JSON.stringify({ userId: 'me' }),
      ])) as GmailProfile;
      const address = res?.emailAddress ?? null;
      if (!address) {
        return { ok: false, address: null, reason: 'gws getProfile returned no emailAddress' };
      }
      return { ok: true, address };
    } catch (err) {
      return { ok: false, address: null, reason: (err as Error).message };
    }
  }

  async *listIds(scope: MailScope = {}): AsyncIterable<string> {
    // Build the Gmail search query from the scope. `includeSent !== false`
    // keeps Sent in scope (D11); `includeSent: false` excludes it via a query
    // term. `since`/`query` are passed through as Gmail search terms.
    const terms: string[] = [];
    if (scope.query) terms.push(scope.query);
    if (scope.since) terms.push(`newer_than:${normaliseSince(scope.since)}`);
    if (scope.includeSent === false) terms.push('-in:sent');
    const q = terms.join(' ').trim();

    const limit = scope.limit;
    let emitted = 0;
    let pageToken: string | undefined;

    do {
      const remaining = limit != null ? limit - emitted : undefined;
      if (remaining != null && remaining <= 0) return;
      const maxResults =
        remaining != null ? Math.min(this.#pageSize, remaining) : this.#pageSize;

      const params: Record<string, unknown> = { userId: 'me', maxResults };
      if (q) params['q'] = q;
      if (pageToken) params['pageToken'] = pageToken;

      const res = (await this.#run([
        'gmail',
        'users',
        'messages',
        'list',
        '--params',
        JSON.stringify(params),
      ])) as GmailListResponse;

      for (const m of res.messages ?? []) {
        if (!m.id) continue;
        if (limit != null && emitted >= limit) return;
        emitted += 1;
        yield m.id;
      }

      pageToken = res.nextPageToken;
    } while (pageToken);
  }

  async getMetadata(ids: readonly string[]): Promise<MessageMetadata[]> {
    const out: MessageMetadata[] = [];
    for (const id of ids) {
      let res: GmailMessage;
      try {
        // §8 pitfall: plain format=metadata, NEVER metadataHeaders.
        res = (await this.#run([
          'gmail',
          'users',
          'messages',
          'get',
          '--params',
          JSON.stringify({ userId: 'me', id, format: 'metadata' }),
        ])) as GmailMessage;
      } catch {
        // An id the provider cannot return (deleted, inaccessible) is omitted
        // rather than represented as a hole — per the contract.
        continue;
      }
      if (res?.id) out.push(toMetadata(res));
    }
    return out;
  }

  async getFull(id: string): Promise<MessageFull | null> {
    let res: GmailMessage;
    try {
      res = (await this.#run([
        'gmail',
        'users',
        'messages',
        'get',
        '--params',
        JSON.stringify({ userId: 'me', id, format: 'full' }),
      ])) as GmailMessage;
    } catch {
      return null;
    }
    if (!res?.id) return null;
    const { bodyText, bodyHtml, mimeType } = extractBodies(res.payload);
    return { ...toMetadata(res), bodyText, bodyHtml, mimeType };
  }
}

/**
 * Normalise a `since` token to a Gmail `newer_than:` argument. Gmail accepts
 * `Nd`/`Nm`/`Ny`; the CLI/scope also allows `1mo`. ISO-8601 dates and unknown
 * tokens pass through unchanged (Gmail also accepts `newer_than:YYYY/MM/DD`).
 */
function normaliseSince(since: string): string {
  const mo = /^(\d+)mo$/.exec(since.trim());
  if (mo) return `${mo[1]}m`;
  return since.trim();
}

export { GwsError } from './runner.js';
export type { GwsRunner, SpawnRunnerOptions } from './runner.js';
export { spawnGwsRunner } from './runner.js';
