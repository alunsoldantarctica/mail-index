/**
 * Tiny, dependency-free semver comparison for the self-updater. Pure (no I/O,
 * no network, no spawn) so it lives outside the egress seam and is unit-tested
 * directly. Compares the numeric release triple and treats any prerelease
 * (`-beta.1`) as LOWER than its release, so the updater never "upgrades" a user
 * onto a prerelease of the same version.
 */

/** Parse `1.2.3` / `1.2.3-beta.4` → { rel:[1,2,3], pre:'beta.4'|null }, or null. */
function parse(v) {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) return null;
  return { rel: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/**
 * Compare two version strings. Returns 1 if a>b, -1 if a<b, 0 if equal.
 * Unparseable input sorts LOW (so a malformed "latest" never triggers an
 * update). A release outranks its own prerelease.
 */
export function compareVersions(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa.rel[i] > pb.rel[i]) return 1;
    if (pa.rel[i] < pb.rel[i]) return -1;
  }
  // Same release triple: a release (no pre) outranks a prerelease.
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
}

/** True when `latest` is a strict upgrade over `current`. */
export function isNewer(latest, current) {
  return compareVersions(latest, current) > 0;
}
