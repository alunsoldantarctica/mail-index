/**
 * `mail-index archive <ref>` and `mail-index label <ref> [--add L] [--remove L]`
 * — the OPT-IN mailbox-write commands (the only two that mutate the mailbox).
 *
 * Both resolve the `<account>:<gmail-message-id>` ref, build the account's
 * adapter via the shared {@link buildSource} seam, and run the one provider
 * write path ({@link applyLabelChange}). The default `gmail.readonly` install
 * cannot reach the provider here — the adapter throws
 * {@link InsufficientScopeError} with the exact re-auth command, which bubbles
 * to the CLI error printer. See docs/adr/0007-opt-in-mailbox-writes.md.
 */

import { resolveAccount, type AccountConfig, type OperatorConfig } from '../config/index.js';
import { Repo } from '../index/repo.js';
import type { LabelChange, MailSource } from '../source/index.js';
import { applyLabelChange, archiveChange, type MutateResult } from '../ingest/mutate.js';

import { buildSource } from './sync.js';
import { parseRef, type MessageRef } from './show.js';

/**
 * Run an archive (drop INBOX) or an arbitrary label change against one message.
 * `buildSourceFn` is injectable so tests wire a fake adapter without a live
 * provider. Throws when the account is unknown (via {@link resolveAccount}).
 */
export async function runLabelChange(
  config: OperatorConfig,
  repo: Repo,
  ref: MessageRef,
  change: LabelChange,
  buildSourceFn: (account: AccountConfig) => MailSource = buildSource,
): Promise<MutateResult> {
  const account = resolveAccount(config, ref.account);
  const source = buildSourceFn(account);
  return applyLabelChange({ account: ref.account, id: ref.id, source, repo, change });
}

/** One-line CLI summary of a completed mutation. */
export function formatMutateResult(verb: string, result: MutateResult): string {
  const where = result.indexed
    ? `local labels now: ${(result.labels ?? []).join(', ') || '∅'}`
    : 'message not in local index (provider updated; will reconcile on next sync)';
  return `${verb} ${result.account}:${result.id} — ${where}\n`;
}

export { parseRef, archiveChange };
