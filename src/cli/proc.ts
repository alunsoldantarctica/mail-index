/**
 * The onboarding process seam (SCOPE: `mail-index setup`).
 *
 * `mail-index setup` is the one CLI path that must invoke *other* programs —
 * `gog`/`brew` to detect, install, configure, and authenticate the provider
 * adapter. That makes it a process-spawning surface, which the egress guard
 * (test/egress-guard.test.ts) treats as a sanctioned-but-audited boundary. This
 * module is that single boundary: it is the ONLY onboarding file that imports
 * `node:child_process`, so the guard's PROC_ALLOW set has exactly one entry to
 * vouch for, and every other onboarding module (setup.ts) stays spawn-free and
 * unit-testable behind the injected {@link SetupDeps} contract.
 *
 * Nothing here reaches the network directly — the real network egress is the
 * `gog` CLI it shells out to, which is the same trust boundary the adapter
 * runners already document.
 */

import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { existsSync } from 'node:fs';

/** Result of running a child process: exit code + captured streams. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Options for {@link run}. */
export interface RunOptions {
  /** Data to pipe to the child's stdin (e.g. an OAuth client JSON over `set -`). */
  stdin?: string;
}

/**
 * Locate an executable on PATH (the production {@link SetupDeps.which}). Returns
 * the resolved absolute path, or null when the binary is not found. Pure lookup
 * — never spawns, so it is safe to call freely during detection.
 */
export function which(bin: string): string | null {
  const path = process.env['PATH'] ?? '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Run a child process to completion, capturing its output (the production
 * {@link SetupDeps.run}). Synchronous + captured so setup steps read like a
 * script; the detached background-sync re-exec lives elsewhere (server.ts).
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): RunResult {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    ...(opts.stdin != null ? { input: opts.stdin } : {}),
  });
  if (res.error) {
    return { code: 127, stdout: '', stderr: res.error.message };
  }
  return {
    code: res.status ?? 0,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}
