/**
 * `mail-index search` (SCOPE 0.7, PLAN §13, CONTEXT.md "Recall").
 *
 * Ranked FTS recall over the index, snippet-first. Honours the recall-not-lookup
 * spirit: the terms are treated as a fuzzy bag, not an exact key. Output is the
 * compact one-line-per-hit shape an agent (or human) skims:
 *
 *   sender · subject · date · snippet · ref
 *
 * where `ref` is the `<account>:<gmail-message-id>` handle the `show` / `open`
 * commands (M1) consume. Bodies are never dumped here — snippet only — keeping
 * the surface token-budget-conscious by default.
 */

import { Repo, type MessageRow } from '../index/repo.js';

/** Options for {@link runSearch}. */
export interface SearchFlags {
  account?: string;
  limit?: number;
}

/**
 * Turn free-text search terms into a safe FTS5 MATCH expression. Each term is
 * wrapped in double quotes (FTS5 string literal) so user input with FTS
 * operators, punctuation, or reserved words cannot break the query or trigger a
 * syntax error; a trailing `*` makes each term a prefix match for fuzzier
 * recall. Terms are OR-combined so a partial overlap still surfaces neighbours
 * rather than an empty set.
 */
export function buildFtsQuery(terms: readonly string[]): string {
  const cleaned = terms
    .map((t) => t.trim())
    .filter((t) => t !== '')
    // Escape embedded double quotes per FTS5 string-literal rules ("" = ").
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
  return cleaned.join(' OR ');
}

/** Run a search, returning ranked rows (best first). */
export function runSearch(repo: Repo, terms: readonly string[], flags: SearchFlags): MessageRow[] {
  const query = buildFtsQuery(terms);
  if (query === '') return [];
  return repo.searchMessages(query, { account: flags.account, limit: flags.limit ?? 20 });
}

/** The `<account>:<gmail-message-id>` reference handle (matches `show`/`open`). */
export function messageRef(row: MessageRow): string {
  return `${row.account}:${row.gmail_message_id}`;
}

/** Render an `internal_date` (epoch ms) as a compact `YYYY-MM-DD`, or `?`. */
function formatDate(internalDate: number | null): string {
  if (internalDate == null) return '?';
  const d = new Date(internalDate);
  if (Number.isNaN(d.getTime())) return '?';
  return d.toISOString().slice(0, 10);
}

/** Collapse a snippet to a single trimmed line, capped for skimmability. */
function compactSnippet(snippet: string | null, max = 100): string {
  if (!snippet) return '';
  const oneLine = snippet.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

/** Format one hit as the compact `sender · subject · date · snippet · ref` line. */
export function formatHit(row: MessageRow): string {
  const sender = row.from_addr ?? '(unknown sender)';
  const subject = row.subject ?? '(no subject)';
  const date = formatDate(row.internal_date);
  const snippet = compactSnippet(row.snippet);
  const ref = messageRef(row);
  const parts = [sender, subject, date];
  if (snippet) parts.push(snippet);
  parts.push(ref);
  return parts.join(' · ');
}

/** Format the whole result set (header + one line per hit, or an empty notice). */
export function formatResults(rows: readonly MessageRow[], terms: readonly string[]): string {
  if (rows.length === 0) {
    return `No matches for "${terms.join(' ')}".\n`;
  }
  const lines = rows.map(formatHit);
  return lines.join('\n') + '\n';
}
