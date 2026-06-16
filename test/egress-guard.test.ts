/**
 * Egress guard (privacy invariant, enforced in CI).
 *
 * mail-index's core promise is local-first: the tool itself makes NO network
 * calls. The only way it ever reaches the network is by spawning the provider
 * adapter CLI (e.g. `gws`) — a single, auditable trust boundary. This test makes
 * that promise a build-breaking invariant: it scans every source file and fails
 * if a direct network primitive appears anywhere, or if a process is spawned
 * outside the two allow-listed seams (the gws adapter runner, and the MCP
 * server's detached background-sync re-exec of our own CLI).
 *
 * If this test fails, the privacy claim in README/SECURITY/THREAT-MODEL no
 * longer holds — fix the code, do not relax the guard without updating those.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Direct network egress — none of these may appear anywhere in src/. */
const NETWORK = [
  { re: /\bfetch\s*\(/, what: 'fetch()' },
  { re: /['"]node:(?:http|https|net|dgram|tls)['"]/, what: 'node net/http import' },
  { re: /\b(?:XMLHttpRequest|WebSocket|EventSource)\b/, what: 'browser network API' },
  { re: /['"](?:axios|node-fetch|undici|got|superagent|ws|request)['"]/, what: 'network library import' },
  { re: /\b(?:posthog|mixpanel|sentry|amplitude|segment|datadog|analytics)\b/i, what: 'telemetry/analytics' },
];

/**
 * Process spawning is the ONLY sanctioned egress (via the adapter CLI). It is
 * allowed exclusively in these files. `\bspawn\b` / `child_process` — note
 * `db.exec(...)` (SQLite) and `regex.exec(...)` are intentionally not matched.
 */
const PROC = /\bchild_process\b|\bspawn\b/;
const PROC_ALLOW = new Set([
  'source/adapters/gws/runner.ts', // spawns the gws CLI — the provider boundary
  'source/adapters/gog/runner.ts', // spawns the gog CLI — the provider boundary
  'mcp/server.ts', // detached re-exec of our own `mail-index sync` (ADR-0005)
]);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (e.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Strip comments so the guard scans CODE, not prose (a docstring may say
 * "spawns a detached sync" or "one bounded fetch" without being either). The
 * `[^:]//` guard preserves `https://` inside string literals.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const files = tsFiles(SRC).map((f) => ({ rel: relative(SRC, f), code: stripComments(readFileSync(f, 'utf8')) }));

test('no direct network primitives anywhere in src/', () => {
  const hits: string[] = [];
  for (const { rel, code } of files) {
    for (const { re, what } of NETWORK) {
      if (re.test(code)) hits.push(`${rel} → ${what}`);
    }
  }
  assert.equal(hits.length, 0, `network egress found in src (privacy violation):\n  ${hits.join('\n  ')}`);
});

test('process spawning only in the allow-listed adapter/server seams', () => {
  const hits: string[] = [];
  for (const { rel, code } of files) {
    if (PROC_ALLOW.has(rel)) continue;
    if (PROC.test(code)) hits.push(rel);
  }
  assert.equal(hits.length, 0, `process spawn outside the allow-list (new egress surface):\n  ${hits.join('\n  ')}`);
});

test('the allow-listed seams still exist (guard cannot silently pass)', () => {
  const present = new Set(files.map((f) => f.rel));
  for (const a of PROC_ALLOW) assert.ok(present.has(a), `allow-listed seam missing: ${a}`);
});
