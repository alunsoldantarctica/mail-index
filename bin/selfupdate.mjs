/**
 * Self-update worker — the ONE network seam outside the provider adapter.
 *
 * QUARANTINE: this file lives in bin/, NOT src/. The core (src/) is provably
 * egress-free (test/egress-guard.test.ts, CI-enforced). This launcher-side
 * worker is the single sanctioned exception: it reaches the npm registry to see
 * if a newer mail-index is published and, if so, updates the install for the
 * NEXT launch — it never touches the currently-running process (so a long-lived
 * MCP server keeps serving its loaded build until Claude Desktop restarts it,
 * and CLI + MCP stay in lockstep on one install). The egress-guard scans bin/
 * too and allow-lists exactly this file.
 *
 * Properties: detached + fire-and-forget (never blocks startup), throttled to
 * once / 24h via a data-dir stamp, opt-out via MAIL_INDEX_NO_AUTOUPDATE=1, and
 * fail-quiet (any error just skips the update — it must never break launch). A
 * git checkout is updated with `git pull --ff-only && build` but ONLY when it
 * is a clean checkout on the default branch (never clobbers a dev's WIP); any
 * other install (npm global) is updated with `npm i -g mail-index@<latest>`.
 */

import { spawnSync } from 'node:child_process';
import { get } from 'node:https';
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { isNewer } from './semver.mjs';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const THROTTLE_MS = 24 * 60 * 60 * 1000;
const REGISTRY = 'https://registry.npmjs.org/mail-index/latest';

const stateDir = process.env.XDG_DATA_HOME
  ? join(process.env.XDG_DATA_HOME, 'mail-index')
  : join(homedir(), '.local', 'share', 'mail-index');
const stamp = join(stateDir, '.update-check');

/** True when an update check ran within the throttle window. */
function recentlyChecked() {
  try {
    return Date.now() - statSync(stamp).mtimeMs < THROTTLE_MS;
  } catch {
    return false;
  }
}

/** Record a check attempt (throttle even on failure, so we never hammer). */
function touch() {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stamp, new Date().toISOString());
  } catch {
    /* best-effort */
  }
}

/** GET registry latest version, or null on any error/timeout. */
function npmLatest() {
  return new Promise((resolve) => {
    const req = get(REGISTRY, { headers: { accept: 'application/json' }, timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).version ?? null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

async function main() {
  if (process.env.MAIL_INDEX_NO_AUTOUPDATE === '1') return;
  if (recentlyChecked()) return;
  touch();

  let current;
  try {
    current = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return;
  }

  const latest = await npmLatest();
  if (!latest || !isNewer(latest, current)) return;

  if (existsSync(join(PKG_ROOT, '.git'))) {
    // Git checkout: only auto-update a CLEAN checkout on the default branch, so
    // a developer's feature branch / uncommitted work is never disturbed.
    const branch = run('git', ['-C', PKG_ROOT, 'rev-parse', '--abbrev-ref', 'HEAD']).stdout?.trim();
    const dirty = run('git', ['-C', PKG_ROOT, 'status', '--porcelain']).stdout?.trim();
    if (branch !== 'main' || dirty) return;
    if (run('git', ['-C', PKG_ROOT, 'pull', '--ff-only']).status !== 0) return;
    // Build with the project's package manager (pnpm if its lockfile is present;
    // pnpm scopes with -C, npm with --prefix).
    const usePnpm = existsSync(join(PKG_ROOT, 'pnpm-lock.yaml'));
    if (usePnpm) run('pnpm', ['-C', PKG_ROOT, 'run', 'build'], { stdio: 'ignore' });
    else run('npm', ['--prefix', PKG_ROOT, 'run', 'build'], { stdio: 'ignore' });
  } else {
    // Published install (npm global): pull the new version for next launch.
    run('npm', ['install', '-g', `mail-index@${latest}`], { stdio: 'ignore' });
  }
}

main().catch(() => {
  /* never let the updater surface an error to the user */
});
