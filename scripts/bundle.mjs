/**
 * Pack a SELF-CONTAINED Claude Desktop bundle (mail-index.mcpb).
 *
 * Claude Desktop runs the server as `node ${__dirname}/dist/mcp/index.js` with
 * its own bundled Node (see manifest.json mcp_config) — no npx, no network, no
 * system Node. So the bundle must ship `dist/` AND a flat production
 * `node_modules`. The repo dev tree is pnpm (symlinked node_modules, which packs
 * badly), so we stage a clean tree in a temp dir and `npm install --omit=dev`
 * there, leaving the dev tree untouched, then `mcpb pack` the stage.
 *
 * We install with pnpm (the repo's package manager, present in CI too) using a
 * HOISTED node-linker so the staged node_modules is flat and symlink-free —
 * portable inside the .mcpb, unlike pnpm's default virtual store.
 *
 * ponytail: deps resolve to latest matching semver (no lockfile in the stage).
 * Fine for 4 pure-JS deps; if reproducibility matters, stage the repo lockfile
 * and add `--frozen-lockfile`.
 *
 * Run via `pnpm run bundle` (which builds first: tsc && node scripts/bundle.mjs).
 */
import { cpSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'mail-index.mcpb');

if (!existsSync(join(root, 'dist', 'mcp', 'index.js'))) {
  console.error('dist/mcp/index.js missing — run `tsc` (or `pnpm run build`) first.');
  process.exit(1);
}

const stage = mkdtempSync(join(tmpdir(), 'mail-index-mcpb-'));
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    rmSync(stage, { recursive: true, force: true });
    console.error(`\n${cmd} ${args.join(' ')} failed (exit ${r.status}).`);
    process.exit(r.status ?? 1);
  }
}

try {
  // Only what the bundle needs: manifest + entry tree + package.json (deps +
  // "type":"module" so node loads dist/*.js as ESM).
  for (const f of ['manifest.json', 'package.json']) cpSync(join(root, f), join(stage, f));
  cpSync(join(root, 'dist'), join(stage, 'dist'), { recursive: true });

  // Flat, real (non-symlinked) production node_modules. --ignore-scripts so no
  // dependency install hook ever executes during packing; hoisted linker so the
  // tree is portable; --ignore-workspace so the tmpdir stage never attaches to a
  // surrounding pnpm workspace.
  sh(
    'pnpm',
    [
      'install',
      '--prod',
      '--ignore-scripts',
      '--node-linker=hoisted',
      '--ignore-workspace',
      '--no-frozen-lockfile',
    ],
    { cwd: stage },
  );

  // Drop pnpm bookkeeping the bundle doesn't need.
  for (const f of [
    'pnpm-lock.yaml',
    'node_modules/.modules.yaml',
    'node_modules/.pnpm-workspace-state-v1.json',
  ]) {
    rmSync(join(stage, f), { force: true });
  }

  sh('npx', ['-y', '@anthropic-ai/mcpb', 'pack', stage, out]);
  console.log(`\nPacked ${out}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
