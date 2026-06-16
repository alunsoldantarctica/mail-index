/**
 * Deterministic image triage for OCR (PLAN §8 classification, agent-OCR design).
 *
 * Marketing email increasingly puts the *content* — the offer, the price, the
 * deadline — inside images rather than text (e.g. a "SAVE UP TO 40% — EXPIRES
 * SEPTEMBER 8" hero graphic). The body text then distills to almost nothing.
 * mail-index never OCRs images itself (that would mean a vision model + network,
 * breaking the local-first contract); instead the MCP server hands the
 * *content-bearing* images to the local agent, which already has vision, to read.
 *
 * This module is the deterministic half of that: a pure function over the email
 * HTML that decides which `<img>`s plausibly carry readable content and which
 * are chrome (tracking pixels, spacers, dividers, icons, logos, social badges).
 * No network, no model, no randomness — just structural signals (dimensions,
 * filename/path, alt text, whether the image is a link). It is the same kind of
 * cheap, explainable classifier as `classify.ts`: it tags and ranks, it does not
 * read pixels.
 */

/** A parsed `<img>` from the email HTML, with the signals triage reads. */
export interface ImageRef {
  /** The image URL (`src`). */
  src: string;
  /** Declared pixel width (from the `width` attr or inline style), or null. */
  width: number | null;
  /** Declared pixel height, or null. */
  height: number | null;
  /** `alt` text, trimmed, or null when absent/empty. */
  alt: string | null;
  /** `href` of the wrapping `<a>`, when the image is a link (a CTA signal). */
  linkedHref: string | null;
}

/** What an image was triaged as. */
export type ImageKind =
  | 'content' // plausibly carries readable text/offer — an OCR candidate
  | 'pixel' // tracking pixel / 1x1 / near-zero area
  | 'spacer' // layout spacer (named, or a thin transparent gif)
  | 'divider' // rule/line (extreme aspect ratio, tiny minor dimension)
  | 'icon' // small icon / social badge / logo
  | 'unknown'; // no size signal and no decisive name hint

/** An image plus its deterministic triage verdict. */
export interface ImageVerdict extends ImageRef {
  kind: ImageKind;
  /** Higher = more likely to carry content worth OCR. 0 for non-content. */
  score: number;
  /** Human-readable signals behind the verdict (for explainability/debugging). */
  reasons: string[];
}

/** Tunables for {@link classifyImages}; defaults suit marketing email. */
export interface TriageOptions {
  /** Min width OR height (px) for an image to be content-sized. Default 200. */
  minContentDim?: number;
  /** Max dimension (px) at or below which an image reads as an icon. Default 64. */
  iconMaxDim?: number;
}

/** Decode the handful of HTML entities that show up in `src`/`alt`. */
function unentity(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Read an attribute's value from a tag's attribute soup (case-insensitive). */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!m) return null;
  return unentity((m[2] ?? m[3] ?? m[4] ?? '').trim());
}

/** Parse a pixel length from an attribute or `style` (e.g. "650", "650px"). */
function pxFrom(tag: string, attrName: string, styleProp: string): number | null {
  const a = attr(tag, attrName);
  if (a != null) {
    const m = /^(\d+(?:\.\d+)?)\s*(px)?$/.exec(a);
    if (m) return Math.round(Number(m[1]));
  }
  const style = attr(tag, 'style');
  if (style) {
    const m = new RegExp(`(?:^|;)\\s*${styleProp}\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s*px`, 'i').exec(style);
    if (m) return Math.round(Number(m[1]));
  }
  return null;
}

/**
 * Pull every `<img>` from the HTML as an {@link ImageRef}, recording whether it
 * sits inside an `<a href>` (a CTA/linked-content signal). Regex-based on
 * purpose — no DOM dependency, matching the repo's no-extra-deps ethos; email
 * HTML is flat enough that an anchor-then-img scan captures the link wrapping.
 */
export function parseImages(html: string): ImageRef[] {
  // Map each img's index to the nearest enclosing open <a href> (if any), by
  // tracking the last <a ...> / </a> seen before the img.
  const out: ImageRef[] = [];
  const tokenRe = /<a\b[^>]*>|<\/a>|<img\b[^>]*>/gi;
  let openHref: string | null = null;
  for (let m = tokenRe.exec(html); m; m = tokenRe.exec(html)) {
    const tok = m[0];
    const lower = tok.toLowerCase();
    if (lower.startsWith('</a')) {
      openHref = null;
    } else if (lower.startsWith('<a')) {
      openHref = attr(tok, 'href');
    } else {
      // <img>
      const src = attr(tok, 'src');
      if (!src) continue;
      const alt = attr(tok, 'alt');
      out.push({
        src,
        width: pxFrom(tok, 'width', 'width'),
        height: pxFrom(tok, 'height', 'height'),
        alt: alt && alt.trim() !== '' ? alt.trim() : null,
        linkedHref: openHref,
      });
    }
  }
  return out;
}

const SPACER_NAME = /spacer|pixel|1x1|blank|clear\.gif|transparent|\bpx\.gif|\/p\.gif|beacon|open\.aspx|track/i;
const ICON_NAME =
  /icon|logo|favicon|sprite|social|facebook|twitter|x-logo|instagram|youtube|linkedin|tiktok|pinterest|app-?store|google-?play|badge|bullet|arrow|chevron|star\b|flag-/i;
const CONTENT_NAME = /promo|offer|deal|hero|banner|header|content|sale|save|fare|price|special|expedition|voyage|itinerar|feature|cta|button/i;

/**
 * Triage every image in the HTML deterministically. Returns one
 * {@link ImageVerdict} per parsed `<img>`, in document order. Pure: identical
 * HTML always yields identical verdicts (no network, no model, no randomness).
 *
 * The rules, in priority order:
 *  1. **pixel** — width/height ≤ 2, or area ≤ 16: a tracking beacon.
 *  2. **spacer** — a spacer/beacon filename, or a thin transparent gif.
 *  3. **divider** — extreme aspect ratio with a tiny minor dimension (a rule).
 *  4. **icon** — both dimensions ≤ `iconMaxDim`, or an icon/logo/social name.
 *  5. **content** — content-sized (a dimension ≥ `minContentDim`), or a
 *     content-y name, or a sized image wrapped in a link. Scored by pixel area
 *     (capped) plus bonuses for content-y src, present alt, and link wrapping.
 *  6. **unknown** — no size signal and no decisive name hint.
 */
export function classifyImages(html: string, opts: TriageOptions = {}): ImageVerdict[] {
  const minContent = opts.minContentDim ?? 200;
  const iconMax = opts.iconMaxDim ?? 64;

  return parseImages(html).map((img) => {
    const reasons: string[] = [];
    const { width: w, height: h, src } = img;
    const area = w != null && h != null ? w * h : null;
    const minor = w != null && h != null ? Math.min(w, h) : null;
    const major = w != null && h != null ? Math.max(w, h) : null;

    const verdict = (kind: ImageKind, score: number): ImageVerdict => ({ ...img, kind, score, reasons });

    // 1. tracking pixel
    if ((w != null && w <= 2) || (h != null && h <= 2) || (area != null && area <= 16)) {
      reasons.push('near-zero dimensions (tracking pixel)');
      return verdict('pixel', 0);
    }
    // 2. spacer (named, or thin transparent gif)
    if (SPACER_NAME.test(src)) {
      reasons.push('spacer/beacon filename');
      return verdict('spacer', 0);
    }
    // 3. divider: extreme aspect ratio + tiny minor dimension (a horizontal rule)
    if (minor != null && major != null && minor <= 6 && major / minor >= 20) {
      reasons.push(`divider aspect ratio (${w}x${h})`);
      return verdict('divider', 0);
    }
    // 4. icon / logo / social badge
    if (ICON_NAME.test(src)) {
      reasons.push('icon/logo/social filename');
      return verdict('icon', 0);
    }
    if (major != null && major <= iconMax) {
      reasons.push(`small image (${w}x${h} ≤ ${iconMax}px)`);
      return verdict('icon', 0);
    }

    // 5. content scoring
    const sizedContent = major != null && major >= minContent;
    const contentName = CONTENT_NAME.test(src);
    const linkedSized = img.linkedHref != null && major != null && major >= iconMax;
    if (sizedContent || contentName || linkedSized) {
      let score = 0;
      if (area != null) {
        // area in "thousands of px", capped so one giant hero doesn't dwarf all.
        const a = Math.min(area, 1_000_000) / 1000;
        score += a;
        reasons.push(`content-sized (${w}x${h})`);
      } else {
        score += 50; // unsized but content-named/linked: middling prior
      }
      if (contentName) {
        score += 300;
        reasons.push('content-y filename');
      }
      if (img.alt) {
        score += 40;
        reasons.push('has alt text');
      }
      if (img.linkedHref) {
        score += 60;
        reasons.push('wrapped in a link (CTA)');
      }
      return verdict('content', Math.round(score));
    }

    // 6. no decisive signal
    reasons.push('no size signal and no decisive name hint');
    return verdict('unknown', 0);
  });
}

/**
 * Length of the *meaningful* text in a distilled body — what's left after
 * dropping the noise that inflates a near-empty body: leftover HTML-entity
 * tokens (`&zwnj;`, `&shy;`, `&#8203;` — preview-text padding that the distiller
 * may not have decoded), zero-width characters, and runs of whitespace. Used to
 * decide {@link isLikelyImageOnly} robustly even before the distiller learns to
 * strip those (see the quoted-printable/entity decode follow-up).
 */
/** Invisible code points that pad preview text but carry no meaning. */
const INVISIBLE_CODEPOINTS = new Set<number>([
  0x00ad, // soft hyphen
  0x034f, // combining grapheme joiner
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, // zero-width space/joiners/marks
  0x2060, // word joiner
  0xfeff, // BOM / zero-width no-break space
]);

export function meaningfulTextLength(bodyText: string | null | undefined): number {
  if (!bodyText) return 0;
  // Strip leftover HTML-entity tokens (preview padding the distiller may not
  // have decoded), then count only visible, non-whitespace characters.
  const stripped = bodyText.replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, '');
  let n = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0);
    if (cp != null && INVISIBLE_CODEPOINTS.has(cp)) continue;
    if (/\s/.test(ch)) continue;
    n += 1;
  }
  return n;
}

/**
 * Deterministic "the offer is in the images, not the text" signal: the distilled
 * body carries little meaningful text yet the email has content-bearing images.
 * This is the "when needed" trigger an agent reads to decide whether to OCR.
 */
export function isLikelyImageOnly(
  bodyText: string | null | undefined,
  candidateCount: number,
  threshold = 200,
): boolean {
  return candidateCount > 0 && meaningfulTextLength(bodyText) < threshold;
}

/**
 * The content-bearing images worth handing to the agent for OCR, deduplicated
 * by `src` and ranked best-first. `limit` caps how many are returned (default
 * 6) so an image-sliced newsletter doesn't flood the agent. Drops everything
 * that triaged to pixel/spacer/divider/icon/unknown.
 */
export function selectOcrCandidates(
  html: string,
  opts: TriageOptions & { limit?: number } = {},
): ImageVerdict[] {
  const limit = opts.limit ?? 6;
  const seen = new Set<string>();
  const content = classifyImages(html, opts)
    .filter((v) => v.kind === 'content')
    .filter((v) => {
      if (seen.has(v.src)) return false;
      seen.add(v.src);
      return true;
    })
    .sort((a, b) => b.score - a.score);
  return content.slice(0, limit);
}
