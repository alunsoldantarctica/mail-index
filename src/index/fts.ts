/**
 * The **FTS contract** (CONTEXT.md "FTS contract", ADR-0006).
 *
 * The single home for how a Message becomes searchable and ranked, so that
 * *index-time* (the Repo's FTS sync + migrations that (re)build the index) and
 * *query-time* (search) can never drift apart — drift between the two would make
 * bm25 ranking non-reproducible. Everything the two phases must agree on lives
 * here and nowhere else:
 *
 *  - {@link FTS_TABLE_DDL} / {@link FTS_TOKENIZER} — the `messages_fts` shape and
 *    tokenizer (porter, for morphological recall: "refund" matches "refunds").
 *    Built by the migration that (re)creates the index.
 *  - {@link projectBody} / {@link projectRecipients} / {@link projectFtsRow} —
 *    index-time: compute the FTS columns from a Message's stored fields. Imported
 *    by the Repo's FTS sync AND by the index-rebuild migration — the same
 *    projection on both paths is the whole point (the drift-free guarantee).
 *  - {@link buildMatch} / {@link expandQuery} — query-time: turn free-text terms
 *    into a safe FTS5 MATCH expression. Imported by both the CLI search command
 *    and the MCP `search` tool (neither reaches into the other).
 *  - {@link BM25_WEIGHTS} / {@link bm25Expr} — query-time ranking: subject and
 *    sender outrank an incidental body mention.
 *
 * Pure and dependency-free: no DB handle, no I/O. The Repo owns execution (it
 * keeps the `DatabaseSync` behind its seam); this module owns the *definition*.
 */

// ---- index-time: the table shape -----------------------------------------

/**
 * The `messages_fts` tokenizer. `porter` stems English morphology (plurals,
 * tenses: refund/refunds/refunding collapse to one stem) over the default
 * `unicode61` word splitter — the biggest "feels semantic" recall win at zero
 * architectural cost. Fixed at table-create time, so changing it means a full
 * index rebuild (a migration), never an `ALTER`.
 */
export const FTS_TOKENIZER = 'porter unicode61';

/**
 * The canonical `messages_fts` DDL. Used by the index-rebuild migration; kept
 * here (not inlined in a migration) so the table's columns and tokenizer have a
 * single definition. NOTE the original `m001` migration created this table with
 * the default tokenizer and is frozen (append-only); the porter rebuild lives in
 * its own later migration and recreates the table from this DDL.
 */
export const FTS_TABLE_DDL = `CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject,
  sender,
  recipients,
  body,
  tokenize = '${FTS_TOKENIZER}'
);`;

// ---- index-time: the column projection (drift-free contract) -------------

/** The Body-state fields that feed the FTS `body` column. */
export interface FtsBodyFields {
  snippet: string | null;
  bodyText: string | null;
  summary?: string | null;
}

/**
 * Compute the FTS `body` column from a Message's Body-state fields. Across the
 * ladder this means: `meta` indexes the snippet; `full` indexes snippet +
 * distilled body; `summary-only` indexes snippet + summary (the demoted body is
 * gone). A summary present on a `full` row is additive (ADR-0003), so both body
 * and summary feed FTS there. Returns `null` when nothing is searchable.
 */
export function projectBody(fields: FtsBodyFields): string | null {
  return [fields.snippet, fields.bodyText, fields.summary].filter(Boolean).join('\n') || null;
}

/**
 * Compute the FTS `recipients` column: the to + cc addresses joined on a space
 * (FTS tokenizes on whitespace), or `null` when neither is present. Single-
 * sourced so the Repo's sync and the index-rebuild migration index recipients
 * identically.
 */
export function projectRecipients(toAddr: string | null, ccAddr: string | null): string | null {
  return [toAddr, ccAddr].filter(Boolean).join(' ') || null;
}

/** A Message's stored columns that the FTS index is projected from. */
export interface FtsSourceRow {
  subject: string | null;
  fromAddr: string | null;
  toAddr: string | null;
  ccAddr: string | null;
  snippet: string | null;
  bodyText: string | null;
  summary: string | null;
}

/** The four `messages_fts` columns, in table order. */
export interface FtsRow {
  subject: string | null;
  sender: string | null;
  recipients: string | null;
  body: string | null;
}

/**
 * Project a Message's stored columns to its `messages_fts` row. The ONE mapping
 * shared by index-time sync and the index-rebuild migration — keep both on this
 * function and the index can never disagree with itself.
 */
export function projectFtsRow(row: FtsSourceRow): FtsRow {
  return {
    subject: row.subject,
    sender: row.fromAddr,
    recipients: projectRecipients(row.toAddr, row.ccAddr),
    body: projectBody(row),
  };
}

// ---- query-time: the MATCH builder ---------------------------------------

/**
 * A small, deliberately-tiny starter map of query synonyms for {@link
 * expandQuery}. mail-index's stance (ADR-0004) is that real semantic expansion
 * is the *agent's* job — so this is a safety net for the few high-value mail
 * equivalences porter stemming can't reach (different words, not word forms),
 * NOT a thesaurus. Keys and values are lower-cased, stem-agnostic single tokens.
 */
export const QUERY_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  invoice: ['receipt', 'bill'],
  receipt: ['invoice', 'bill'],
  bill: ['invoice', 'receipt'],
  flight: ['airfare', 'itinerary'],
  airfare: ['flight', 'itinerary'],
  refund: ['reimbursement', 'credit'],
};

/**
 * Expand search terms with the curated {@link QUERY_SYNONYMS} (opt-in). Each
 * term contributes itself plus any synonyms; the result is de-duplicated and
 * order-stable (term first, then its synonyms). A no-op for any term not in the
 * map. The real expansion is still the agent's job — this only catches a few
 * common mail equivalences.
 */
export function expandQuery(terms: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string): void => {
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  for (const term of terms) {
    push(term);
    for (const syn of QUERY_SYNONYMS[term.toLowerCase()] ?? []) push(syn);
  }
  return out;
}

/** Options for {@link buildMatch}. */
export interface BuildMatchOptions {
  /** Apply curated {@link expandQuery} synonyms before building. Default false. */
  expand?: boolean;
}

/**
 * Turn free-text search terms into a safe FTS5 MATCH expression. Each term is
 * wrapped in double quotes (FTS5 string literal) so user input with FTS
 * operators, punctuation, or reserved words cannot break the query or trigger a
 * syntax error; a trailing `*` makes each term a prefix match for fuzzier
 * recall. Terms are OR-combined so a partial overlap still surfaces neighbours
 * rather than an empty set. With `{ expand: true }`, curated synonyms are mixed
 * in first. Returns `''` when no usable term remains (the caller treats an empty
 * match as "no query, no rows").
 */
export function buildMatch(terms: readonly string[], options: BuildMatchOptions = {}): string {
  const source = options.expand ? expandQuery(terms) : terms;
  const cleaned = source
    .map((t) => t.trim())
    .filter((t) => t !== '')
    // Escape embedded double quotes per FTS5 string-literal rules ("" = ").
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
  return cleaned.join(' OR ');
}

// ---- query-time: bm25 ranking --------------------------------------------

/**
 * bm25 column weights for `messages_fts(subject, sender, recipients, body)`. A
 * subject/sender hit outranks an incidental body mention. bm25 returns negative
 * scores (smaller = better), so callers `ORDER BY bm25(...)` ascending.
 */
export const BM25_WEIGHTS: readonly [number, number, number, number] = [10, 8, 4, 1];

/** The weighted `bm25(messages_fts, …)` ORDER BY expression. */
export function bm25Expr(table = 'messages_fts'): string {
  return `bm25(${table}, ${BM25_WEIGHTS.join(', ')})`;
}
