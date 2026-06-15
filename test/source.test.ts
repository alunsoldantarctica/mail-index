/**
 * Source-layer tests (SCOPE 0.3). Runs the reusable MailSource contract suite
 * against the in-memory fake built from the recorded fixtures — proving the
 * harness itself works, with no live network. Tests import compiled output
 * (matching the other test files); `pnpm test` builds first via pretest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runMailSourceContract } from '../dist/source/contract.js';
import { FakeMailSource } from '../dist/source/fake.js';
import { DEFAULT_FIXTURES } from '../dist/source/fixtures/index.js';

// The body of the suite: every assertion in contract.ts, run against the fake.
runMailSourceContract(test, () => new FakeMailSource(DEFAULT_FIXTURES), DEFAULT_FIXTURES);

// A direct sanity check that the fake reads back a recorded body, independent of
// the contract harness (guards against the harness silently passing on a no-op).
test('FakeMailSource returns a recorded body via getFull', async () => {
  const source = new FakeMailSource(DEFAULT_FIXTURES);
  const full = await source.getFull('fixt-direct-1');
  assert.ok(full);
  assert.match(full.bodyText ?? '', /deposit/i);
});

test('FakeMailSource defaults to the bundled fixtures', async () => {
  const source = new FakeMailSource();
  const identity = await source.check();
  assert.equal(identity.ok, true);
  assert.equal(identity.address, 'al@example.com');
});

test('FakeMailSource excludes Sent when includeSent is false', async () => {
  const source = new FakeMailSource(DEFAULT_FIXTURES);
  const ids: string[] = [];
  for await (const id of source.listIds({ includeSent: false })) ids.push(id);
  assert.ok(!ids.includes('fixt-sent-1'), 'Sent fixture must be filtered out');
  assert.ok(ids.includes('fixt-direct-1'));
});
