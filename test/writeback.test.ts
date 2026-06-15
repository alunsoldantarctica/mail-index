/**
 * Write-back loop tests (SCOPE 3.5, ADR-0003/0004, CONTEXT.md "Write-back loop"
 * / "Demotion" / "Entity category").
 *
 * The index PROPOSES, the agent's LLM JUDGES, a write-back tool PERSISTS with
 * model provenance — the tool ships no intelligence (ADR-0002/0004). The tests
 * seed a tmp DB, aggregate it, then assert the engine over a seeded index:
 *
 *  - saveSummary persists a message/thread summary, provenance-marked,
 *    FTS-searchable, NEVER overwriting source fields;
 *  - compact demotes ONLY eligible bodies (summarized + bulk + past grace) and
 *    spares curated-important senders, user-participated threads, and direct
 *    human mail; --now collapses the grace window;
 *  - domainsToCategorize returns Correspondent-bearing candidates + context;
 *    saveDomainCategory persists onto domains.category (open vocabulary).
 *
 * Tests import the compiled output; `pnpm test` builds first via pretest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { aggregateAccount } from '../dist/intelligence/aggregate.js';
import {
  saveSummary,
  compact,
  domainsToCategorize,
  saveDomainCategory,
  DEFAULT_GRACE_MS,
} from '../dist/writeback/index.js';
import { set as curationSet } from '../dist/curation/index.js';

const ACCOUNT = 'test-acct';
const ME = 'al@example.com';
const NOW = new Date(Date.UTC(2026, 5, 15));

function freshRepo() {
  return new Repo(openDb({ path: ':memory:' }));
}

function seed(repo, m) {
  repo.upsertMessage({
    account: ACCOUNT,
    gmailMessageId: m.id,
    threadId: m.threadId ?? null,
    internalDate: m.internalDate ?? null,
    fromAddr: m.from ?? null,
    toAddr: m.to ?? null,
    subject: m.subject ?? null,
    direction: m.direction ?? 'received',
    isList: m.isList ?? false,
    category: m.category ?? null,
    unread: m.unread ?? false,
    snippet: m.snippet ?? null,
    bodyText: m.bodyText ?? null,
    bodyState: m.bodyState ?? 'meta',
  });
}

const T0 = NOW.getTime();

/**
 * Seed:
 *  - a newsletter issue (is_list, enriched to full) — the demotion target;
 *  - a curated-important sender's bulk mail (full) — must be SPARED;
 *  - a user-participated thread message (full, is_list) — must be SPARED;
 *  - a direct human mail (full, not list) — must be SPARED (not bulk);
 *  - a Correspondent at vendor.example.com for the categorization loop.
 */
function seedMailbox(repo) {
  // Newsletter — bulk, enriched.
  seed(repo, {
    id: 'news1', threadId: 't-news', internalDate: T0 - 5000,
    from: 'Digest <digest@news.example.com>', to: ME, subject: 'weekly digest',
    isList: true, category: 'promotions', bodyState: 'full',
    snippet: 'newsletter snippet', bodyText: 'the full newsletter body verbatim',
  });

  // Curated-important sender, bulk mail (must be spared even when summarized).
  seed(repo, {
    id: 'vip1', threadId: 't-vip', internalDate: T0 - 4000,
    from: 'VIP <vip@important.example.com>', to: ME, subject: 'promo from vip',
    isList: true, category: 'promotions', bodyState: 'full',
    snippet: 'vip snippet', bodyText: 'vip body',
  });

  // User-participated thread: bulk-classified but user replied → spared.
  seed(repo, {
    id: 'part1', threadId: 't-part', internalDate: T0 - 3500,
    from: 'List <list@forum.example.com>', to: ME, subject: 'thread topic',
    isList: true, category: 'forums', bodyState: 'full',
    snippet: 'part snippet', bodyText: 'forum body',
  });
  seed(repo, {
    id: 'part2', threadId: 't-part', internalDate: T0 - 3400,
    from: ME, to: 'list@forum.example.com', subject: 're: thread topic',
    direction: 'sent', bodyState: 'meta',
  });

  // Direct human mail, not bulk (must be spared by the bulk-only rule).
  seed(repo, {
    id: 'direct1', threadId: 't-direct', internalDate: T0 - 3000,
    from: 'Pat <pat@human.example.com>', to: ME, subject: 'lunch?',
    bodyState: 'full', snippet: 'lunch snippet', bodyText: 'are you free for lunch',
  });

  // Correspondent at vendor — user has written to them (for categorization).
  seed(repo, {
    id: 'v1', threadId: 't-v', internalDate: T0 - 2000,
    from: 'Casey <casey@vendor.example.com>', to: ME, subject: 'invoice 42',
  });
  seed(repo, {
    id: 'v2', threadId: 't-v', internalDate: T0 - 1900,
    from: ME, to: 'casey@vendor.example.com', subject: 're: invoice 42',
    direction: 'sent',
  });
}

function aggregated() {
  const repo = freshRepo();
  seedMailbox(repo);
  aggregateAccount(repo, ACCOUNT, [ME]);
  return repo;
}

const iso = (ms) => new Date(ms).toISOString();

// ---- saveSummary (message) ------------------------------------------------

test('saveSummary persists a message summary, FTS-searchable, source preserved', () => {
  const repo = aggregated();
  const at = iso(T0 - 5000);
  const result = saveSummary(repo, ACCOUNT, 'message', 'news1', 'A weekly roundup of Antarctic logistics.', { at });

  assert.equal(result.level, 'message');
  assert.equal(result.ref, 'news1');
  assert.equal(result.summarizedAt, at);

  const row = repo.getMessage(ACCOUNT, 'news1');
  // Summary persisted, provenance marked (model by default), eligibility stamped.
  assert.equal(row.summary_text, 'A weekly roundup of Antarctic logistics.');
  assert.equal(row.summary_is_model, 1);
  assert.equal(row.summarized_at, at);
  // Source fields untouched (ADR-0003: never overwrites source).
  assert.equal(row.subject, 'weekly digest');
  assert.equal(row.body_text, 'the full newsletter body verbatim');
  assert.equal(row.body_state, 'full');

  // The summary improves recall: a term ONLY in the summary now matches.
  const hits = repo.searchMessages('Antarctic', { account: ACCOUNT });
  assert.ok(hits.some((h) => h.gmail_message_id === 'news1'), 'summary term is FTS-searchable');
  // The original body is still searchable too (summary is additive on a full row).
  const bodyHits = repo.searchMessages('verbatim', { account: ACCOUNT });
  assert.ok(bodyHits.some((h) => h.gmail_message_id === 'news1'));
});

test('saveSummary rejects empty text and an unknown message', () => {
  const repo = aggregated();
  assert.throws(() => saveSummary(repo, ACCOUNT, 'message', 'news1', '   '), /non-empty/);
  assert.throws(() => saveSummary(repo, ACCOUNT, 'message', 'nope', 'x'), /unknown message/);
});

test('saveSummary can mark provenance as not-model', () => {
  const repo = aggregated();
  saveSummary(repo, ACCOUNT, 'message', 'news1', 'hand-written', { isModel: false, at: iso(T0) });
  assert.equal(repo.getMessage(ACCOUNT, 'news1').summary_is_model, 0);
});

// ---- saveSummary (thread) -------------------------------------------------

test('saveSummary persists a thread summary; survives re-aggregation', () => {
  const repo = aggregated();
  const at = iso(T0 - 1000);
  const result = saveSummary(repo, ACCOUNT, 'thread', 't-v', 'Invoice 42 discussion with Casey.', { at });
  assert.equal(result.level, 'thread');

  const thread = repo.getThread(ACCOUNT, 't-v');
  assert.equal(thread.summary_text, 'Invoice 42 discussion with Casey.');
  assert.equal(thread.summary_is_model, 1);
  assert.equal(thread.summarized_at, at);
  // Source fields preserved (the aggregated thread subject is untouched by the
  // summary write — it lands in its own column).
  const subjectBefore = thread.subject;
  assert.equal(thread.msg_count, 2);

  // Re-aggregating must NOT wipe the thread summary (UPSERT, not clean replace),
  // and leaves the source subject as the aggregation computes it.
  aggregateAccount(repo, ACCOUNT, [ME]);
  const after = repo.getThread(ACCOUNT, 't-v');
  assert.equal(after.summary_text, 'Invoice 42 discussion with Casey.');
  assert.equal(after.subject, subjectBefore);
});

test('saveSummary rejects an unknown thread', () => {
  const repo = aggregated();
  assert.throws(() => saveSummary(repo, ACCOUNT, 'thread', 'no-thread', 'x'), /unknown thread/);
});

// ---- compact / demotion ---------------------------------------------------

test('compact demotes only eligible bodies past the grace window', () => {
  const repo = aggregated();
  // Summarize four full bodies, all stamped 10 days ago (past the 7-day grace).
  const old = iso(T0 - 10 * 24 * 60 * 60 * 1000);
  for (const id of ['news1', 'vip1', 'part1', 'direct1']) {
    saveSummary(repo, ACCOUNT, 'message', id, `summary of ${id}`, { at: old });
  }
  // Curate the VIP domain important — its bulk mail must be spared.
  curationSet(repo, ACCOUNT, { domains: [{ domain: 'important.example.com', curation: 'important' }] });

  const result = compact(repo, ACCOUNT, { asOf: NOW });

  // Only the plain newsletter demotes. VIP (curated-important domain),
  // part1 (user-participated thread), and direct1 (not bulk) are spared.
  assert.equal(result.demoted, 1);
  assert.equal(repo.getMessage(ACCOUNT, 'news1').body_state, 'summary-only');
  assert.equal(repo.getMessage(ACCOUNT, 'news1').body_text, null, 'distilled body dropped');
  assert.equal(repo.getMessage(ACCOUNT, 'vip1').body_state, 'full', 'curated-important spared');
  assert.equal(repo.getMessage(ACCOUNT, 'part1').body_state, 'full', 'user-participated thread spared');
  assert.equal(repo.getMessage(ACCOUNT, 'direct1').body_state, 'full', 'non-bulk human mail spared');

  // After demotion the summary still feeds FTS; the dropped body does not.
  const summHits = repo.searchMessages('summary', { account: ACCOUNT });
  assert.ok(summHits.some((h) => h.gmail_message_id === 'news1'));
  const goneBody = repo.searchMessages('verbatim', { account: ACCOUNT });
  assert.ok(!goneBody.some((h) => h.gmail_message_id === 'news1'), 'demoted body no longer indexed');
});

test('compact respects the grace window; --now overrides it', () => {
  const repo = aggregated();
  // Summarized just now → inside the 7-day grace.
  saveSummary(repo, ACCOUNT, 'message', 'news1', 'fresh summary', { at: iso(T0) });

  const held = compact(repo, ACCOUNT, { asOf: NOW });
  assert.equal(held.demoted, 0, 'within grace, nothing demotes');
  assert.equal(repo.getMessage(ACCOUNT, 'news1').body_state, 'full');

  const forced = compact(repo, ACCOUNT, { asOf: NOW, now: true });
  assert.equal(forced.demoted, 1, '--now ignores the grace window');
  assert.equal(repo.getMessage(ACCOUNT, 'news1').body_state, 'summary-only');
});

test('compact never demotes a body without a summary', () => {
  const repo = aggregated();
  // news1 is full + bulk but never summarized → not eligible.
  const result = compact(repo, ACCOUNT, { asOf: NOW, now: true });
  assert.equal(result.demoted, 0);
  assert.equal(repo.getMessage(ACCOUNT, 'news1').body_state, 'full');
});

test('compact cutoff is grace before asOf', () => {
  const repo = aggregated();
  const result = compact(repo, ACCOUNT, { asOf: NOW });
  assert.equal(result.cutoff, iso(T0 - DEFAULT_GRACE_MS));
});

test('a re-sync (meta upsert) never re-inflates a demoted body', () => {
  const repo = aggregated();
  saveSummary(repo, ACCOUNT, 'message', 'news1', 'a summary', { at: iso(T0 - 10 * 86_400_000) });
  compact(repo, ACCOUNT, { asOf: NOW });
  assert.equal(repo.getMessage(ACCOUNT, 'news1').body_state, 'summary-only');
  // A plain metadata re-sync arrives as meta — no-downgrade keeps summary-only.
  seed(repo, {
    id: 'news1', threadId: 't-news', internalDate: T0 - 5000,
    from: 'Digest <digest@news.example.com>', to: ME, subject: 'weekly digest',
    isList: true, category: 'promotions', bodyState: 'meta', snippet: 'newsletter snippet',
  });
  assert.equal(repo.getMessage(ACCOUNT, 'news1').body_state, 'summary-only');
  assert.equal(repo.getMessage(ACCOUNT, 'news1').summary_text, 'a summary', 'summary survives re-sync');
});

// ---- domain categorization loop -------------------------------------------

test('domainsToCategorize returns Correspondent-bearing candidates + context', () => {
  const repo = aggregated();
  const candidates = domainsToCategorize(repo, ACCOUNT);

  // vendor.example.com has a Correspondent (user replied to Casey); news/forum
  // domains have no Correspondent → excluded.
  const vendor = candidates.find((c) => c.domain === 'vendor.example.com');
  assert.ok(vendor, 'vendor domain (has a Correspondent) is a candidate');
  assert.ok(vendor.correspondentCount >= 1);
  assert.ok(!candidates.some((c) => c.domain === 'news.example.com'), 'no-Correspondent domain excluded');

  // Sample context: the sender + recent subjects the agent judges on.
  const casey = vendor.samples.find((s) => s.address === 'casey@vendor.example.com');
  assert.ok(casey, 'sample sender present');
  assert.ok(casey.subjects.includes('invoice 42'), 'recent subjects given as context');
});

test('saveDomainCategory persists onto domains.category (open vocabulary)', () => {
  const repo = aggregated();
  const result = saveDomainCategory(repo, ACCOUNT, 'vendor.example.com', 'travel operator', 'books Antarctic charters');
  assert.equal(result.category, 'travel operator');

  const row = repo.getDomain(ACCOUNT, 'vendor.example.com');
  assert.equal(row.category, 'travel operator');

  // Once categorized it drops out of the default (uncategorized-only) proposal,
  // and reappears when explicitly including categorized domains.
  assert.ok(!domainsToCategorize(repo, ACCOUNT).some((c) => c.domain === 'vendor.example.com'));
  assert.ok(
    domainsToCategorize(repo, ACCOUNT, { includeCategorized: true }).some(
      (c) => c.domain === 'vendor.example.com' && c.category === 'travel operator',
    ),
  );
});

test('saveDomainCategory rejects empty domain/category', () => {
  const repo = aggregated();
  assert.throws(() => saveDomainCategory(repo, ACCOUNT, '  ', 'vendor'), /non-empty domain/);
  assert.throws(() => saveDomainCategory(repo, ACCOUNT, 'x.example.com', ''), /non-empty category/);
});

test('domainsToCategorize is token-conscious (respects limit)', () => {
  const repo = aggregated();
  const capped = domainsToCategorize(repo, ACCOUNT, { limit: 1, includeCategorized: true });
  assert.ok(capped.length <= 1);
});
