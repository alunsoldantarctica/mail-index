/**
 * Body distillation (SCOPE 1.1, PLAN §7 phase 2, CONTEXT.md "Enrichment",
 * ADR-0003). Turns a raw provider {@link MessageFull} body into the compact,
 * plain-text form the index stores — bodies are ALWAYS stored DISTILLED; raw
 * provider bytes are never persisted.
 *
 * This is the SIZE LEVER of the whole index: a newsletter's HTML body is mostly
 * markup, tracking pixels, and footer chrome; distilling it down to its real
 * prose is what keeps a full mailbox a few tens of MB. Everything here is
 * deterministic and dependency-free (no DOM, no network, no clock) so it stays
 * unit-testable and cheap — a small hand-rolled stripper, per the project's
 * no-heavy-deps rule.
 *
 * Pipeline ({@link distill}):
 *   1. Pick the source: prefer `bodyText` when the provider supplied one;
 *      otherwise strip `bodyHtml` to text.
 *   2. De-boilerplate: drop quoted reply history (`>` lines, "On … wrote:",
 *      gmail_quote blocks), signatures, and unsubscribe/list footers.
 *   3. Normalise whitespace so the result is stable and compact.
 *
 * The distiller is conservative about REAL content: it removes structurally
 * recognisable boilerplate, not arbitrary prose, so the message's actual body
 * survives while quotes/sigs/footers go.
 */

/** Strip HTML to plain text: remove script/style/head, drop tags, decode
 * entities, and turn block-level boundaries into line breaks. Deterministic and
 * dependency-free. */
export function htmlToText(html: string): string {
  let s = html;

  // Remove whole non-content elements (and their contents) first.
  s = s.replace(/<!--[\s\S]*?-->/g, ' '); // comments
  s = s.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  // Tracking pixels / spacer images and standalone media leave no text — the
  // tag removal below already drops them, but normalise <br> and block edges to
  // newlines so paragraph structure survives as line breaks.
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|table|ul|ol|blockquote|section|article|header|footer)\s*>/gi, '\n');
  s = s.replace(/<\s*(p|div|tr|li|h[1-6]|table|ul|ol|blockquote|section|article|header|footer)\b[^>]*>/gi, '\n');

  // Drop every remaining tag.
  s = s.replace(/<[^>]+>/g, '');

  // Decode the handful of entities that actually matter for prose.
  s = decodeEntities(s);

  return s;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  bull: '•',
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

/** Decode named + numeric HTML entities relevant to prose. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Markers that begin quoted reply history. A line matching one of these (and
 * everything after it) is dropped — the quoted thread is already its own
 * indexed Message, so re-storing it bloats the index and poisons FTS ranking.
 */
const QUOTE_HEADER_PATTERNS: RegExp[] = [
  // "On Tue, 28 May 2024 at 14:40, Jordan <…> wrote:" and locale variants.
  /^\s*On\b.*\bwrote:\s*$/i,
  // "On Tue, 28 May 2024, Jordan wrote:" without "at".
  /^\s*On\b.*,.*\bwrote:\s*$/i,
  // Outlook-style "-----Original Message-----".
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  // "From: …" block that Outlook prepends to quoted replies.
  /^\s*From:\s.+$/i,
];

/**
 * Markers that begin a signature block. A line matching one of these (and
 * everything after it) is dropped.
 */
const SIGNATURE_PATTERNS: RegExp[] = [
  // The conventional "-- " sig delimiter (RFC 3676), with or without trailing space.
  /^--\s*$/,
];

/**
 * Markers that begin a list/unsubscribe/footer block — common newsletter
 * chrome. A line matching one of these (and everything after it) is dropped.
 */
const FOOTER_PATTERNS: RegExp[] = [
  /\bunsubscribe\b/i,
  /\bupdate (your )?(email )?preferences\b/i,
  /\bmanage (your )?(email )?(subscription|preferences)\b/i,
  /\bview (this email )?in (your )?browser\b/i,
  /\byou (are )?receiv(e|ing) this (email|message)\b/i,
  /\bsent to you by\b/i,
  /^\s*©\s*\d{4}\b/,
  /\ball rights reserved\b/i,
];

/** A line that is just a quote prefix (`>`), optionally repeated/nested. */
const QUOTE_LINE = /^\s*>+/;

/**
 * Remove quoted reply history, signatures, and footers from already-plain text.
 * The strategy is line-based and truncating: once a quote-header / signature /
 * footer marker is hit, everything from that line onward is dropped (these
 * blocks always sit at the tail of a real message). Standalone `>`-quoted lines
 * are also dropped even when interleaved.
 */
export function deboilerplate(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];

  for (const line of lines) {
    // A quoted-history header, a signature delimiter, or a footer marker ends
    // the real content — stop here.
    if (QUOTE_HEADER_PATTERNS.some((re) => re.test(line))) break;
    if (SIGNATURE_PATTERNS.some((re) => re.test(line))) break;
    if (FOOTER_PATTERNS.some((re) => re.test(line))) break;
    // A bare quoted line (`> …`) is reply history — skip it but keep scanning.
    if (QUOTE_LINE.test(line)) continue;
    kept.push(line);
  }

  return kept.join('\n');
}

/** Collapse runs of blank lines and trailing whitespace into a stable, compact form. */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n') // CRLF / CR → LF
    .replace(/[ \t\u00A0]+/g, " ") // runs of spaces/tabs/nbsp -> single space
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // collapse 3+ blank lines to one
    .trim();
}

/** Minimal subset of {@link MessageFull} the distiller needs. */
export interface DistillInput {
  bodyText: string | null;
  bodyHtml: string | null;
  mimeType?: string | null;
}

/**
 * Distil a raw provider body into compact plain text for storage. Prefers
 * `bodyText` when present; otherwise strips `bodyHtml`. Always de-boilerplates
 * and normalises. Returns an empty string when there is no usable body (the
 * caller still records the enrichment; a bodyless message just has no body
 * text).
 */
export function distill(input: DistillInput): string {
  const source =
    input.bodyText && input.bodyText.trim() !== ''
      ? input.bodyText
      : input.bodyHtml
        ? htmlToText(input.bodyHtml)
        : '';

  return normalizeWhitespace(deboilerplate(source));
}
