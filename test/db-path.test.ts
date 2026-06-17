/**
 * Default DB-path resolution (db.ts). Locks the precedence that keeps dev
 * worktrees from bumping the production index: an explicit MAIL_INDEX_DB wins
 * over the XDG default, so a worktree can point at its own file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultDbPath } from '../dist/index/db.js';

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('MAIL_INDEX_DB overrides the default index path (worktree isolation seam)', () => {
  withEnv({ MAIL_INDEX_DB: '/tmp/some-worktree/.mail-index-dev.sqlite' }, () => {
    assert.equal(defaultDbPath(), '/tmp/some-worktree/.mail-index-dev.sqlite');
  });
});

test('falls back to XDG_DATA_HOME, then ~/.local/share, when MAIL_INDEX_DB is unset/blank', () => {
  withEnv({ MAIL_INDEX_DB: undefined, XDG_DATA_HOME: '/tmp/xdg' }, () => {
    assert.equal(defaultDbPath(), '/tmp/xdg/mail-index/mail.sqlite');
  });
  withEnv({ MAIL_INDEX_DB: '   ', XDG_DATA_HOME: '/tmp/xdg' }, () => {
    assert.equal(defaultDbPath(), '/tmp/xdg/mail-index/mail.sqlite'); // blank ignored
  });
});
