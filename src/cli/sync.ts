/**
 * `mail-index sync` (SCOPE 0.7, PLAN §13, §7 phase 1, §15 multi-account).
 *
 * Resolves an account label to its adapter config (operator config, §15),
 * builds the concrete {@link MailSource} for that adapter, overlays the CLI
 * sync flags onto the account's stored `syncPolicy`, and runs the phase-1
 * metadata sweep ({@link syncMetadata}). Prints a concise fetched/indexed
 * summary.
 *
 * `--all-accounts` is a thin loop over every configured account (each is an
 * independent sweep using its own policy presets); a per-account failure does
 * not abort the others.
 *
 * Adapter construction lives here (not in the ingest layer) so the ingest layer
 * stays provider-neutral — it only ever sees the {@link MailSource} contract.
 * The adapter `id` → builder map is the single place a new adapter is wired for
 * the CLI.
 */

import { expandHome, resolveAccount, type AccountConfig, type OperatorConfig } from '../config/index.js';
import { Repo } from '../index/repo.js';
import { GwsAdapter } from '../source/adapters/gws/index.js';
import type { MailScope, MailSource } from '../source/index.js';
import { syncMetadata, type SyncResult } from '../ingest/sync.js';

/** CLI-supplied sync flags (already parsed; all optional). */
export interface SyncFlags {
  since?: string;
  /** `--all` — whole mailbox: clears `since`/`limit` so nothing bounds the sweep. */
  all?: boolean;
  query?: string;
  limit?: number;
}

/**
 * Build the concrete {@link MailSource} for an account's adapter binding. The
 * one place CLI sync knows which adapter class backs which `adapter` id.
 */
export function buildSource(account: AccountConfig): MailSource {
  switch (account.adapter) {
    case 'gws':
      return new GwsAdapter({ configDir: expandHome(account.configDir) });
    default: {
      // Exhaustiveness guard: AccountConfig.adapter is a closed union, but a
      // future adapter id added to config must be wired here too.
      const unknown: never = account.adapter;
      throw new Error(`no MailSource builder for adapter "${String(unknown)}"`);
    }
  }
}

/**
 * Compose the effective {@link MailScope} for a run: the account's stored
 * `syncPolicy` provides defaults; explicit CLI flags override field-by-field.
 * `--all` means "whole mailbox", so it wins over any `since`/`limit` (from flag
 * or policy) by clearing both. Returns `undefined` when nothing constrains the
 * scope (the adapter's own default policy then applies, per §15).
 */
export function composeScope(account: AccountConfig, flags: SyncFlags): MailScope | undefined {
  const policy = account.syncPolicy ?? {};
  const scope: MailScope = {};

  const query = flags.query ?? policy.query;
  if (query != null) scope.query = query;

  if (policy.includeSent != null) scope.includeSent = policy.includeSent;

  if (!flags.all) {
    const since = flags.since ?? policy.since;
    if (since != null) scope.since = since;
    const limit = flags.limit ?? policy.limit;
    if (limit != null) scope.limit = limit;
  }

  return Object.keys(scope).length > 0 ? scope : undefined;
}

/** Run a single account's sync, returning the ingest layer's result. */
export async function runSyncOne(
  config: OperatorConfig,
  label: string,
  flags: SyncFlags,
  repo: Repo,
  buildSourceFn: (account: AccountConfig) => MailSource = buildSource,
): Promise<SyncResult> {
  const account = resolveAccount(config, label);
  const source = buildSourceFn(account);
  const scope = composeScope(account, flags);
  return syncMetadata({ account: label, source, repo, scope });
}

/** Format a completed sync run as the one-line CLI summary. */
export function formatSyncResult(result: SyncResult): string {
  const scope = result.selector ? ` (${result.selector})` : ' (whole mailbox)';
  return `${result.account}: fetched ${result.fetched}, indexed ${result.indexed}${scope}`;
}

/** One account's outcome in an all-accounts sweep (success or isolated failure). */
export interface AccountSyncOutcome {
  account: string;
  /** The completed run, when the account synced successfully. */
  result?: SyncResult;
  /** The failure message, when this account's sweep failed (others continue). */
  error?: string;
}

/**
 * Run phase-1 sync for *every* configured account (SCOPE 1.3, PLAN §15), each
 * using its own stored `syncPolicy` preset overlaid with the shared CLI
 * `flags`. Each account is an independent sweep — its own `sync_runs` row + the
 * per-account lock (enforced down in {@link syncMetadata}) — so one account's
 * failure is captured as an {@link AccountSyncOutcome} error and does NOT abort
 * the rest. Returns one outcome per account, in config order.
 *
 * The loop body reuses {@link runSyncOne}; `buildSourceFn` is threaded through
 * so tests can wire fake sources per account without a live provider.
 */
export async function runSyncAll(
  config: OperatorConfig,
  flags: SyncFlags,
  repo: Repo,
  buildSourceFn: (account: AccountConfig) => MailSource = buildSource,
): Promise<AccountSyncOutcome[]> {
  const outcomes: AccountSyncOutcome[] = [];
  for (const label of Object.keys(config.accounts)) {
    try {
      const result = await runSyncOne(config, label, flags, repo, buildSourceFn);
      outcomes.push({ account: label, result });
    } catch (err) {
      outcomes.push({ account: label, error: (err as Error).message });
    }
  }
  return outcomes;
}
