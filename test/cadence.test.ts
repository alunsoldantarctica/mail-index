/**
 * Cadence (correspondent frequency) tests (intelligence/cadence.ts). Seeds an
 * in-memory index with received mail across several brands (some sharing a
 * bulk-subdomain split), runs aggregation, then asserts computeCadence groups by
 * registrable domain, counts distinct senders, honours the entity-category
 * filter (via save_domain_category write-back), the `sinceMs` bound, the limit,
 * and excludes Sent mail. Tests import the compiled output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { aggregateAccount } from '../dist/intelligence/aggregate.js';
import { computeCadence } from '../dist/intelligence/cadence.js';

const ACCOUNT = 'fora';
const DAY = 86_400_000;

function seed(repo, m) {
  repo.upsertMessage({
    account: ACCOUNT,
    gmailMessageId: m.id,
    threadId: m.id,
    internalDate: m.internalDate ?? null,
    fromAddr: m.from ?? null,
    toAddr: m.to ?? null,
    subject: m.subject ?? null,
    direction: m.direction ?? 'received',
    isList: m.isList ?? false,
    snippet: m.snippet ?? null,
    bodyState: 'meta',
  });
}

/**
 * Two Silversea hosts (brand fragmented) + one Quark + one user-sent message.
 * t0 anchors the window; Silversea spans 30 days.
 */
function seedBrands(repo, t0) {
  seed(repo, { id: 's1', from: 'Rep A <a@email.silversea.com>', to: 'me@fora.travel', internalDate: t0 });
  seed(repo, { id: 's2', from: 'Rep B <b@silversea.com>', to: 'me@fora.travel', internalDate: t0 + 10 * DAY });
  seed(repo, { id: 's3', from: 'Rep A <a@email.silversea.com>', to: 'me@fora.travel', internalDate: t0 + 30 * DAY });
  seed(repo, { id: 'q1', from: 'Crystal <c@email.quarkexpeditions.com>', to: 'me@fora.travel', internalDate: t0 + 5 * DAY });
  // Sent mail must NOT count toward inbound cadence.
  seed(repo, { id: 'sent1', from: 'me@fora.travel', to: 'a@silversea.com', internalDate: t0 + 1 * DAY, direction: 'sent' });
}

test('cadence groups by registrable brand, counts distinct senders, excludes Sent', () => {
  const repo = new Repo(openDb({ path: ':memory:' }));
  const t0 = Date.UTC(2026, 0, 1);
  seedBrands(repo, t0);
  aggregateAccount(repo, ACCOUNT, ['me@fora.travel']);

  const rows = computeCadence(repo, ACCOUNT);
  const byDomain = new Map(rows.map((r) => [r.domain, r]));

  // Two Silversea hosts collapse to one brand row with 3 msgs, 2 senders.
  const sv = byDomain.get('silversea.com');
  assert.ok(sv, 'expected a silversea.com brand row');
  assert.equal(sv.msgs, 3);
  assert.equal(sv.senders, 2);
  assert.equal(new Date(sv.firstMs).toISOString().slice(0, 10), '2026-01-01');
  assert.equal(new Date(sv.lastMs).toISOString().slice(0, 10), '2026-01-31');

  // Quark present; the user's Sent mail produced no inbound brand row.
  assert.ok(byDomain.get('quarkexpeditions.com'));
  assert.equal(rows.reduce((n, r) => n + r.msgs, 0), 4, 'sent mail excluded');

  // Ranked by volume desc → Silversea first.
  assert.equal(rows[0].domain, 'silversea.com');
});

test('cadence --category filters to domains tagged via save_domain_category', () => {
  const repo = new Repo(openDb({ path: ':memory:' }));
  const t0 = Date.UTC(2026, 0, 1);
  seedBrands(repo, t0);
  aggregateAccount(repo, ACCOUNT, ['me@fora.travel']);

  // Tag both Silversea hosts (aggregation keys domains by raw host).
  repo.setDomainCategory({ account: ACCOUNT, domain: 'email.silversea.com', category: 'expedition-operator' });
  repo.setDomainCategory({ account: ACCOUNT, domain: 'silversea.com', category: 'expedition-operator' });

  const ops = computeCadence(repo, ACCOUNT, { category: 'expedition-operator' });
  assert.equal(ops.length, 1, 'only the tagged brand');
  assert.equal(ops[0].domain, 'silversea.com');
  assert.equal(ops[0].msgs, 3);

  // Quark is untagged → excluded by the category filter.
  assert.ok(!ops.some((r) => r.domain === 'quarkexpeditions.com'));
});

test('cadence honours the sinceMs bound and the limit', () => {
  const repo = new Repo(openDb({ path: ':memory:' }));
  const t0 = Date.UTC(2026, 0, 1);
  seedBrands(repo, t0);
  aggregateAccount(repo, ACCOUNT, ['me@fora.travel']);

  // Window starting after the first two Silversea msgs: only s3 (day 30) counts.
  const recent = computeCadence(repo, ACCOUNT, { sinceMs: t0 + 20 * DAY });
  const sv = recent.find((r) => r.domain === 'silversea.com');
  assert.equal(sv.msgs, 1);

  assert.equal(computeCadence(repo, ACCOUNT, { limit: 1 }).length, 1);
});
