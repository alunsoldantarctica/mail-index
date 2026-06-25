/**
 * Mutate — the OPT-IN mailbox-write path (archive + label edit).
 *
 * This is the ONE place mail-index writes to the provider mailbox, and it is
 * NEVER reached by sync/enrich. It exists only behind the explicit
 * `mail-index archive`/`label` CLI commands and the `archive_message`/
 * `modify_labels` MCP tools. The default `gmail.readonly` install cannot reach
 * the provider here: `MailSource.modify` is absent on read-only adapters, and a
 * scope-limited grant makes the adapter throw {@link InsufficientScopeError}.
 *
 * Order matters: the provider write happens FIRST; only on its success do we
 * update the local index ({@link Repo.applyLabelChange}) so the index never
 * claims a change the mailbox rejected.
 *
 * Provider-neutral: speaks only the {@link MailSource} contract + the {@link Repo}.
 * See docs/adr/0007-opt-in-mailbox-writes.md.
 */

import type { LabelChange, MailSource } from '../source/index.js';
import type { Repo } from '../index/repo.js';

/** Thrown when the wired adapter does not support writes at all (read-only). */
export class MailboxWriteUnsupportedError extends Error {
  override name = 'MailboxWriteUnsupportedError';
}

/** Inputs for {@link applyLabelChange}. */
export interface MutateInput {
  account: string;
  id: string;
  source: MailSource;
  repo: Repo;
  change: LabelChange;
}

/** Outcome: the resulting label set and whether the local index had the row. */
export interface MutateResult {
  account: string;
  id: string;
  /** Resulting labels after the change, when the message is in the index. */
  labels: string[] | null;
  /** False when the provider write succeeded but no local row existed to update. */
  indexed: boolean;
}

/**
 * Apply a label {@link LabelChange} to one message: provider write first, then
 * the local index. Throws {@link MailboxWriteUnsupportedError} if the adapter is
 * read-only, or {@link InsufficientScopeError} (from the adapter) if the grant
 * lacks write scope — both carry actionable guidance for the surface to relay.
 */
export async function applyLabelChange(input: MutateInput): Promise<MutateResult> {
  const { account, id, source, repo, change } = input;

  if (typeof source.modify !== 'function') {
    throw new MailboxWriteUnsupportedError(
      `the "${source.provider}" adapter is read-only — mailbox writes are not supported`,
    );
  }

  // Provider write FIRST (may throw InsufficientScopeError on a readonly grant).
  await source.modify(id, change);

  // Then reflect it locally so search/recall stay consistent before next sync.
  const labels = repo.applyLabelChange(account, id, {
    add: change.addLabelIds ?? [],
    remove: change.removeLabelIds ?? [],
  });

  return { account, id, labels, indexed: labels !== null };
}

/** Archive = drop the INBOX label. The one well-known compound. */
export function archiveChange(): LabelChange {
  return { removeLabelIds: ['INBOX'] };
}
