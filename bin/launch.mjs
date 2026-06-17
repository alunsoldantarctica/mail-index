/**
 * Shared launch logic for the mail-index `cli` and `mcp` entrypoints.
 *
 * Each bin target (bin/cli.mjs, bin/mcp.mjs) calls `launch(target)`. It does two
 * things, in order:
 *   1. Fires a DETACHED, fire-and-forget self-update check (bin/selfupdate.mjs)
 *      — never blocks startup, opt-out via MAIL_INDEX_NO_AUTOUPDATE=1. Any update
 *      it finds is applied for the NEXT launch, never hot-swapped into this
 *      process (so a long-lived MCP keeps serving its loaded build, and CLI + MCP
 *      stay in lockstep on one install).
 *   2. Hands off in-process to the real entrypoint (dist/<target>/index.js),
 *      leaving process.argv so the entry's argv.slice(2) yields its own args.
 *
 * This lives in bin/ (not src/) because the self-update path it kicks off reaches
 * the network — keeping it out of the egress-guarded core.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Kick off the detached, opt-out, throttled self-update check (never blocks). */
function fireUpdateCheck() {
  if (process.env.MAIL_INDEX_NO_AUTOUPDATE === '1') return;
  try {
    const child = spawn(process.execPath, [join(here, 'selfupdate.mjs')], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    /* an updater that won't even spawn must not stop the tool from running */
  }
}

/** Fire the update check, then hand off in-process to the real entrypoint. */
export async function launch(target) {
  fireUpdateCheck();
  const entry = join(here, '..', 'dist', target === 'mcp' ? 'mcp' : 'cli', 'index.js');
  await import(entry);
}
