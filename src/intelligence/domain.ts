/**
 * Deterministic domain normalization (no network, no public-suffix download).
 *
 * Marketing/transactional mail arrives from per-message bulk subdomains
 * (`email.silversea.com`, `mail.travelhx.com`, `cruises.ponant.com`), so the raw
 * host is a poor grouping key — the same brand fragments across many hosts. The
 * intelligence layer needs a stable BRAND key to roll a correspondent up by, and
 * the only way that stays deterministic (vs. an LLM guessing "these three hosts
 * are all Silversea") is a fixed registrable-domain (eTLD+1) reduction.
 *
 * This is a compact, dependency-free eTLD+1: collapse a host to its last two
 * labels, except when the last two labels form one of the multi-part public
 * suffixes below (`co.uk`, `com.au`, …), in which case keep three. It is NOT a
 * full Public Suffix List — it covers the suffixes that actually appear in
 * correspondence and is easy to extend. Unknown/edge hosts degrade gracefully to
 * last-two-labels, which is correct for the overwhelmingly common `brand.tld`.
 */

/**
 * Two-label public suffixes under which the registrable domain is the third
 * label from the right (e.g. `bbc.co.uk` → keep `bbc.co.uk`, not `co.uk`).
 * Extend as new ccTLD shapes appear in the mailbox.
 */
const MULTIPART_SUFFIXES = new Set<string>([
  // UK
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk',
  // Australia / NZ
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  // Asia
  'co.jp', 'or.jp', 'ne.jp', 'co.kr', 'or.kr', 'com.cn', 'com.hk', 'com.sg', 'com.tw',
  // Americas
  'com.br', 'com.mx', 'com.ar', 'com.co',
  // Europe / other
  'co.za', 'com.tr', 'co.in', 'com.ua',
]);

/**
 * Reduce a host to its registrable (eTLD+1) domain. Lower-cases, strips a
 * trailing dot and any port, and collapses bulk subdomains:
 *
 *   email.silversea.com        → silversea.com
 *   mail.travelhx.com          → travelhx.com
 *   news.hl-cruises.com        → hl-cruises.com
 *   bbc.co.uk                  → bbc.co.uk
 *   luxurylodges.com.au        → luxurylodges.com.au
 *
 * Returns the input (trimmed/lower-cased) unchanged when it has two or fewer
 * labels or is empty.
 */
export function registrableDomain(host: string | null | undefined): string | null {
  if (!host) return null;
  let h = host.trim().toLowerCase();
  if (h === '') return null;
  // strip port and a single trailing dot
  const colon = h.indexOf(':');
  if (colon >= 0) h = h.slice(0, colon);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h === '') return null;

  const labels = h.split('.').filter((l) => l !== '');
  if (labels.length <= 2) return labels.join('.') || null;

  const lastTwo = labels.slice(-2).join('.');
  const take = MULTIPART_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** The host portion of a bare address (`a@b.com` → `b.com`), lower-cased, or null. */
export function hostOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  if (at < 0 || at === address.length - 1) return null;
  return address.slice(at + 1).toLowerCase();
}
