/**
 * Message classification (SCOPE 0.5, PLAN §8). Pure functions that derive a
 * Message's `category`, `is_list`, and `direction` from *metadata only* —
 * Gmail labels plus a few headers — with no body needed and no I/O.
 *
 * These three fields feed the graph (D9 — co-recipiency over `is_list=0`
 * threads), the interest model (§10), and the enrichment policy (§7), so they
 * are computed once at phase-1 sync and stored on the Message row (the field
 * names line up with `index/repo.ts` `MessageInput`: `category`, `isList`,
 * `direction`).
 *
 * Design notes:
 *  - Everything here is a pure function over plain inputs — no DB, no network,
 *    no clock. The sync layer gathers labels/headers from the `MailSource`
 *    adapter and calls these; that keeps the rules unit-testable in isolation
 *    and trivially portable across adapters.
 *  - §8 PITFALL: `is_list` keys off the *presence* of `List-Id` /
 *    `List-Unsubscribe` headers, which must come from a plain `format=metadata`
 *    fetch. Restricting the fetch via `metadataHeaders` is unreliable through
 *    gws and silently drops headers — so an adapter must hand us the full
 *    header set, and classification must never assume a header is absent merely
 *    because a restricted projection omitted it. We therefore treat headers as
 *    an open, case-insensitive bag and only ever test for *presence*.
 */

import type { Category, Direction } from '../index/schema.js';

/**
 * The Gmail `CATEGORY_*` label → {@link Category} map. Gmail attaches at most
 * one inbox-tab category label per message; if (defensively) more than one is
 * present we resolve deterministically by this precedence order, which mirrors
 * Gmail's own tab ordering (Primary is implicit — it has no `CATEGORY_*`
 * label, see {@link classifyCategory}).
 */
const CATEGORY_LABELS: ReadonlyArray<readonly [label: string, category: Category]> = [
  ['CATEGORY_PERSONAL', 'personal'],
  ['CATEGORY_SOCIAL', 'social'],
  ['CATEGORY_PROMOTIONS', 'promotions'],
  ['CATEGORY_UPDATES', 'updates'],
  ['CATEGORY_FORUMS', 'forums'],
];

/**
 * Headers an adapter passes to classification. Keys are header names as the
 * provider supplied them (any case); values are the raw header value. Only
 * presence is consulted (see the §8 pitfall above), never the value.
 *
 * Modeled as an open record rather than a fixed shape because the §8 pitfall
 * forbids relying on a restricted header projection — the adapter hands over
 * whatever `format=metadata` returned.
 */
export type MessageHeaders = Readonly<Record<string, string | null | undefined>>;

/** Inputs every classifier shares. Plain, provider-neutral, body-free. */
export interface ClassifyInput {
  /**
   * Gmail label ids on the message (`INBOX`, `SENT`, `CATEGORY_PROMOTIONS`,
   * `UNREAD`, …). Order-insensitive.
   */
  labels: readonly string[];
  /** Raw headers from a plain `format=metadata` fetch (case-insensitive). */
  headers?: MessageHeaders;
  /** The message's `From:` header (display-name form tolerated). */
  from?: string | null;
  /**
   * Bare addresses that belong to the authenticated account(s). A message
   * `from` one of these is `sent` even without a `SENT` label (§8). Compared
   * case-insensitively against the address extracted from `from`.
   */
  knownAddresses?: readonly string[];
}

/** Whether a header is present in the bag, matched case-insensitively. */
function hasHeader(headers: MessageHeaders | undefined, name: string): boolean {
  if (!headers) return false;
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      const value = headers[key];
      // Presence means the key exists with a non-nullish value. An adapter
      // that surfaces a header at all (even empty string) counts as present;
      // null/undefined means "not supplied".
      if (value !== null && value !== undefined) return true;
    }
  }
  return false;
}

/**
 * Extract the bare email address from a `From:`-style value, lowercased.
 * Handles `Name <addr@host>` and a bare `addr@host`. Returns null when no
 * address-shaped token is found.
 */
export function extractAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const angle = value.match(/<([^>]+)>/);
  const candidate = (angle?.[1] ?? value).trim();
  // Keep it simple and dependency-free: an address is `local@domain` with no
  // whitespace. Good enough for the equality check direction needs.
  const match = candidate.match(/[^\s<>@]+@[^\s<>@]+/);
  return match?.[0] ? match[0].toLowerCase() : null;
}

/**
 * Derive the inbox-tab {@link Category} from labels (§8):
 *  - a `CATEGORY_*` label → its mapped category;
 *  - else `primary` when the message is in the inbox (no `CATEGORY_*` label but
 *    `INBOX` present — Gmail's Primary tab carries no category label);
 *  - else `null` (uncategorisable from labels alone, e.g. archived non-tab
 *    mail or a Sent message with no category label).
 */
export function classifyCategory(labels: readonly string[]): Category | null {
  for (const [label, category] of CATEGORY_LABELS) {
    if (labels.includes(label)) return category;
  }
  if (labels.includes('INBOX')) return 'primary';
  return null;
}

/**
 * Whether the message is list/bulk mail (§8): true iff a `List-Id` or
 * `List-Unsubscribe` header is present. Presence only — never the value — and
 * matched case-insensitively over the full (non-restricted) header bag.
 */
export function classifyIsList(headers?: MessageHeaders): boolean {
  return hasHeader(headers, 'List-Id') || hasHeader(headers, 'List-Unsubscribe');
}

/**
 * Derive {@link Direction} (§8): `sent` when the message carries the `SENT`
 * label OR its `from` address is one of `knownAddresses`; otherwise
 * `received`. The address path catches Sent mail that lost its label (e.g.
 * surfaced through a search scope that doesn't preserve `SENT`).
 */
export function classifyDirection(
  labels: readonly string[],
  from?: string | null,
  knownAddresses: readonly string[] = [],
): Direction {
  if (labels.includes('SENT')) return 'sent';
  const addr = extractAddress(from);
  if (addr && knownAddresses.some((known) => known.toLowerCase() === addr)) {
    return 'sent';
  }
  return 'received';
}

/** The three classification fields, named to match `MessageInput`. */
export interface Classification {
  category: Category | null;
  isList: boolean;
  direction: Direction;
}

/**
 * Run all three classifiers over one message's metadata. Convenience wrapper
 * the sync layer calls per message; the individual functions stay exported for
 * targeted use and testing.
 */
export function classifyMessage(input: ClassifyInput): Classification {
  return {
    category: classifyCategory(input.labels),
    isList: classifyIsList(input.headers),
    direction: classifyDirection(input.labels, input.from, input.knownAddresses),
  };
}
