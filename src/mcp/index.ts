#!/usr/bin/env node
/**
 * mail-index-mcp server entry point (SCOPE 3.4, PLAN §12, §13 `mail-index mcp`).
 *
 * The thin process wiring: load the operator config, open the local index
 * (WAL — ADR-0005, so the detached background sync never blocks reads), build
 * the {@link ToolContext}, and connect the stdio MCP {@link serve}r. All tool
 * logic lives in `tools.ts` (pure, tested) and the surface registry in
 * `server.ts`; this file only assembles them and keeps the process alive.
 *
 * READ-ONLY on the mailbox (D15): the only provider seam wired in is
 * {@link buildSource} for `get_message`'s single inline O(1) enrich (ADR-0001).
 * Stale time-sensitive reads spawn a detached `mail-index sync` child
 * ({@link spawnDetachedSync}, ADR-0005). Diagnostics go to STDERR only — STDOUT
 * is the JSON-RPC transport and must carry nothing else.
 */

import { loadConfig } from '../config/index.js';
import { openDb } from '../index/db.js';
import { Repo } from '../index/repo.js';
import { buildSource } from '../cli/sync.js';
import { serve, spawnDetachedSync } from './server.js';
import type { ToolContext } from './tools.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb();
  const repo = new Repo(db);

  const ctx: ToolContext = {
    repo,
    config,
    buildSource,
    backgroundSync: spawnDetachedSync,
  };

  await serve(ctx);
  // serve() resolves once connected; the transport keeps the event loop alive
  // until stdin closes. Close the DB on shutdown so WAL is checkpointed.
  process.on('SIGINT', () => {
    db.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    db.close();
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`mail-index-mcp: ${message}\n`);
  process.exit(1);
});
