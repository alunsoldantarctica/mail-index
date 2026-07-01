/**
 * Index-layer tests (SCOPE 0.2): migrations run clean, upsert idempotency, the
 * no-downgrade rule, and FTS round-trips. All against an in-memory DB.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Tests import the compiled output (matching test/smoke.test.ts); `pnpm test`
// builds first via the pretest hook so dist is fresh.
import { openDb, IndexError } from '../dist/index/db.js';
import { getUserVersion, runMigrations } from '../dist/index/migrations.js';
import { Repo } from '../dist/index/repo.js';
import { SCHEMA_VERSION } from '../dist/index/schema.js';

function freshRepo(): Repo {
  return new Repo(openDb({ path: ':memory:' }));
}

const TABLES = [
  'messages',
  'messages_fts',
  'contacts',
  'domains',
  'threads',
  'interest_profile',
  'contact_stats_snapshot',
  'sync_runs',
  'account_identity',
  'labels',
];

test('migrations run clean on a fresh db and create every PLAN §6 table', () => {
  const db = openDb({ path: ':memory:' });
  assert.equal(getUserVersion(db), SCHEMA_VERSION);

  const names = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`).all() as {
      name: string;
    }[]
  ).map((r) => r.name);

  for (const t of TABLES) {
    assert.ok(names.includes(t), `expected table ${t} to exist`);
  }
});

test('running migrations twice is a no-op (idempotent)', () => {
  const db = openDb({ path: ':memory:' });
  const before = getUserVersion(db);
  runMigrations(db); // second pass
  assert.equal(getUserVersion(db), before);
});

test('forward-only: refuses to open a db newer than the build', () => {
  const db = openDb({ path: ':memory:', skipMigrations: true });
  db.exec('PRAGMA user_version = 9999');
  assert.throws(() => runMigrations(db), /newer than this build/);
});

test('upsertMessage is idempotent by (account, gmail_message_id)', () => {
  const repo = freshRepo();
  const input = {
    account: 'acct-a',
    gmailMessageId: 'm1',
    subject: 'Deposit terms',
    fromAddr: 'partner@example.com',
    snippet: 'about the deposit',
  };
  repo.upsertMessage(input);
  repo.upsertMessage(input);
  repo.upsertMessage({ ...input, subject: 'Deposit terms (updated)' });

  assert.equal(repo.countMessages(), 1);
  assert.equal(repo.countMessages('acct-a'), 1);
  const row = repo.getMessage('acct-a', 'm1');
  assert.equal(row?.subject, 'Deposit terms (updated)');
});

test('account namespacing: same message id in two accounts are distinct rows', () => {
  const repo = freshRepo();
  repo.upsertMessage({ account: 'acct-a', gmailMessageId: 'shared' });
  repo.upsertMessage({ account: 'acct-b', gmailMessageId: 'shared' });
  assert.equal(repo.countMessages(), 2);
  assert.equal(repo.countMessages('acct-a'), 1);
});

test('no-downgrade: a meta re-sync never clobbers a full body', () => {
  const repo = freshRepo();
  repo.upsertMessage({ account: 'a', gmailMessageId: 'm1', snippet: 'snip' });

  // Enrich to full.
  const full = repo.upsertMessage({
    account: 'a',
    gmailMessageId: 'm1',
    snippet: 'snip',
    bodyState: 'full',
    bodyText: 'the full distilled body',
  });
  assert.equal(full, 'full');

  // A later metadata-only sync arrives (body_state defaults to meta).
  const after = repo.upsertMessage({
    account: 'a',
    gmailMessageId: 'm1',
    snippet: 'snip refreshed',
  });
  assert.equal(after, 'full', 'state must stay full');

  const row = repo.getMessage('a', 'm1');
  assert.equal(row?.body_state, 'full');
  assert.equal(row?.body_text, 'the full distilled body', 'body must survive');
  // Metadata still refreshes.
  assert.equal(row?.snippet, 'snip refreshed');
});

test('no-downgrade: full does not clobber summary-only', () => {
  const repo = freshRepo();
  repo.upsertMessage({ account: 'a', gmailMessageId: 'm1', bodyState: 'full', bodyText: 'b' });
  // Simulate demotion to summary-only at the storage level via a direct write,
  // then prove a full re-sync is held back.
  repo.db
    .prepare(`UPDATE messages SET body_state='summary-only', body_text=NULL WHERE gmail_message_id='m1'`)
    .run();

  const after = repo.upsertMessage({
    account: 'a',
    gmailMessageId: 'm1',
    bodyState: 'full',
    bodyText: 'refetched body',
  });
  assert.equal(after, 'summary-only');
  assert.equal(repo.getMessage('a', 'm1')?.body_state, 'summary-only');
});

test('FTS insert + search round-trips on metadata fields', () => {
  const repo = freshRepo();
  repo.upsertMessage({
    account: 'a',
    gmailMessageId: 'm1',
    subject: 'Antarctica logistics',
    fromAddr: 'ops@expedition.example',
    toAddr: 'al@example.com',
    snippet: 'the zodiac schedule for landings',
  });

  assert.equal(repo.searchMessages('Antarctica').length, 1);
  assert.equal(repo.searchMessages('zodiac').length, 1, 'snippet is indexed as body');
  assert.equal(repo.searchMessages('expedition').length, 1, 'sender is indexed');
  assert.equal(repo.searchMessages('nonexistentterm').length, 0);
});

test('FTS reflects body text after enrichment to full', () => {
  const repo = freshRepo();
  repo.upsertMessage({ account: 'a', gmailMessageId: 'm1', subject: 'Q', snippet: 'snip' });
  assert.equal(repo.searchMessages('deposit').length, 0);

  repo.upsertMessage({
    account: 'a',
    gmailMessageId: 'm1',
    subject: 'Q',
    snippet: 'snip',
    bodyState: 'full',
    bodyText: 'we agreed on a 20% deposit by Friday',
  });
  assert.equal(repo.searchMessages('deposit').length, 1, 'body now searchable');
});

test('FTS search can be scoped by account', () => {
  const repo = freshRepo();
  repo.upsertMessage({ account: 'a', gmailMessageId: 'm1', subject: 'shared topic' });
  repo.upsertMessage({ account: 'b', gmailMessageId: 'm2', subject: 'shared topic' });
  assert.equal(repo.searchMessages('shared').length, 2);
  assert.equal(repo.searchMessages('shared', { account: 'a' }).length, 1);
});

test('sync_runs start/finish audit row', () => {
  const repo = freshRepo();
  const id = repo.startSyncRun({ account: 'a', phase: 'sync', selector: '--all' });
  repo.finishSyncRun(id, { fetched: 10, indexed: 10 });
  const row = repo.db.prepare('SELECT * FROM sync_runs WHERE id = ?').get(id) as {
    fetched: number;
    indexed: number;
    finished_at: string | null;
  };
  assert.equal(row.fetched, 10);
  assert.ok(row.finished_at);
});

test('activeSyncRun: a fresh in-progress row locks; a >6h-old one is a dead lock', () => {
  const repo = freshRepo();
  const id = repo.startSyncRun({ account: 'a', phase: 'sync', selector: null });
  assert.equal(repo.activeSyncRun('a'), id, 'a fresh in-progress row is the live lock');

  // Backdate its start past the stale-lock threshold (crashed sync, row never closed).
  const old = new Date(Date.now() - 7 * 3_600_000).toISOString();
  repo.db.prepare('UPDATE sync_runs SET started_at = ? WHERE id = ?').run(old, id);
  assert.equal(repo.activeSyncRun('a'), undefined, 'a stale lock no longer blocks');

  // A new run can now take the lock.
  const next = repo.startSyncRun({ account: 'a', phase: 'sync', selector: null });
  assert.equal(repo.activeSyncRun('a', next), undefined, 'only the stale row exists besides the new one');
  assert.equal(repo.activeSyncRun('a'), next, 'the new run is the live lock');
});

test('closed-enum guards throw IndexError', () => {
  const repo = freshRepo();
  assert.throws(
    () =>
      repo.upsertMessage({
        account: 'a',
        gmailMessageId: 'm1',
        // @ts-expect-error invalid by design
        bodyState: 'garbage',
      }),
    IndexError,
  );
  assert.throws(
    () => repo.startSyncRun({ account: 'a', phase: 'nope' as never }),
    IndexError,
  );
});

test('contact + domain-category write-backs are idempotent', () => {
  const repo = freshRepo();
  repo.upsertContact({ account: 'a', address: 'x@y.com', domain: 'y.com', displayName: 'X' });
  repo.upsertContact({ account: 'a', address: 'x@y.com', curation: 'important' });
  const c = repo.db
    .prepare(`SELECT display_name, curation FROM contacts WHERE address='x@y.com'`)
    .get() as { display_name: string; curation: string };
  assert.equal(c.display_name, 'X', 'COALESCE keeps prior display_name');
  assert.equal(c.curation, 'important');

  repo.setDomainCategory({ account: 'a', domain: 'y.com', category: 'travel operator' });
  const d = repo.db.prepare(`SELECT category FROM domains WHERE domain='y.com'`).get() as {
    category: string;
  };
  assert.equal(d.category, 'travel operator');
});
