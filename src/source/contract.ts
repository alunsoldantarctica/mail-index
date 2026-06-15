/**
 * The reusable `MailSource` contract test suite (SCOPE 0.3, PLAN §19 "a
 * MailSource fixture every adapter must pass"). Every adapter — the in-memory
 * fake, the gws adapter, future Direct/IMAP adapters — proves conformance by
 * running this suite against recorded fixtures, with NO live network.
 *
 * Usage from a test file (which imports the compiled output, per the repo
 * convention in test/*.ts):
 *
 *   import { test } from 'node:test';
 *   import { runMailSourceContract } from '../dist/source/contract.js';
 *   import { FakeMailSource } from '../dist/source/fake.js';
 *   import { DEFAULT_FIXTURES } from '../dist/source/fixtures/index.js';
 *
 *   runMailSourceContract(test, () => new FakeMailSource(DEFAULT_FIXTURES),
 *     DEFAULT_FIXTURES);
 *
 * The suite is parameterised over `(makeSource, fixtures)` so it never bakes in
 * a particular adapter. `register` is the `node:test` `test` function, injected
 * so this module carries no test-runner import (keeping the source dir free of
 * a node:test dependency for non-test consumers).
 */

import assert from 'node:assert/strict';
import type { MailSource } from './index.js';
import type { MailSourceFixtures } from './fixtures/index.js';

/** Minimal shape of the `node:test` `test()` function the suite needs. */
export type TestRegister = (name: string, fn: () => void | Promise<void>) => unknown;

/** Drain an async iterable of ids into an array. */
async function collectIds(source: MailSource): Promise<string[]> {
  const ids: string[] = [];
  for await (const id of source.listIds()) ids.push(id);
  return ids;
}

/**
 * Register the contract suite. `makeSource` must return a fresh adapter already
 * loaded with `fixtures` (so assertions about ids/addresses line up).
 */
export function runMailSourceContract(
  register: TestRegister,
  makeSource: () => MailSource,
  fixtures: MailSourceFixtures,
): void {
  const expectedIds = fixtures.messages.map((m) => m.id);
  const prefix = 'MailSource contract';

  register(`${prefix}: exposes a provider identifier`, () => {
    const source = makeSource();
    assert.equal(typeof source.provider, 'string');
    assert.ok(source.provider.length > 0, 'provider must be a non-empty string');
  });

  register(`${prefix}: check() probes auth/identity`, async () => {
    const source = makeSource();
    const identity = await source.check();
    assert.equal(identity.ok, true, 'fixture-backed source must authenticate');
    assert.equal(identity.address, fixtures.address);
  });

  register(`${prefix}: listIds() yields the fixture ids`, async () => {
    const source = makeSource();
    const ids = await collectIds(source);
    assert.deepEqual(
      [...ids].sort(),
      [...expectedIds].sort(),
      'listIds must surface every fixture message id exactly once',
    );
  });

  register(`${prefix}: listIds() honours the limit scope`, async () => {
    const source = makeSource();
    const limited: string[] = [];
    for await (const id of source.listIds({ limit: 1 })) limited.push(id);
    assert.equal(limited.length, 1, 'limit:1 must yield a single id');
  });

  register(`${prefix}: getMetadata() returns the declared shape for known ids`, async () => {
    const source = makeSource();
    const metas = await source.getMetadata(expectedIds);
    assert.equal(metas.length, expectedIds.length, 'one record per known id');

    for (const meta of metas) {
      // Every declared metadata field is present (value may be null).
      for (const key of [
        'id',
        'threadId',
        'internalDate',
        'dateHeader',
        'from',
        'to',
        'cc',
        'subject',
        'labels',
        'snippet',
        'sizeEstimate',
      ] as const) {
        assert.ok(key in meta, `metadata record missing field: ${key}`);
      }
      assert.ok(Array.isArray(meta.labels), 'labels must be an array');
      // The contract forbids a body leaking through the metadata shape.
      assert.ok(!('bodyText' in meta), 'metadata must not carry a body');
      assert.ok(!('bodyHtml' in meta), 'metadata must not carry a body');
    }
  });

  register(`${prefix}: getMetadata() omits unknown ids rather than holing`, async () => {
    const source = makeSource();
    const metas = await source.getMetadata(['does-not-exist', ...expectedIds]);
    assert.equal(metas.length, expectedIds.length);
    assert.ok(
      metas.every((m) => m.id !== 'does-not-exist'),
      'unknown ids must be omitted, not represented as null holes',
    );
  });

  register(`${prefix}: getFull() includes a body for a known id`, async () => {
    const source = makeSource();
    const firstId = expectedIds[0];
    assert.ok(firstId, 'fixtures must contain at least one message');

    const full = await source.getFull(firstId);
    assert.ok(full, 'getFull must return a record for a known id');
    assert.equal(full.id, firstId);
    assert.ok('bodyText' in full && 'bodyHtml' in full, 'full record carries body fields');
    const hasBody = (full.bodyText ?? '').length > 0 || (full.bodyHtml ?? '').length > 0;
    assert.ok(hasBody, 'full record must include a non-empty body');
  });

  register(`${prefix}: getFull() returns null for an unknown id`, async () => {
    const source = makeSource();
    const full = await source.getFull('does-not-exist');
    assert.equal(full, null);
  });

  register(`${prefix}: fixture set spans more than one message`, () => {
    // §19 calls for a small recorded set (a direct + a list message at least);
    // the suite stays adapter-neutral by asserting breadth, not specific
    // addresses. Adapter authors supply fixtures covering their own shapes.
    assert.ok(expectedIds.length >= 2, 'contract fixtures must span ≥2 messages');
  });
}
