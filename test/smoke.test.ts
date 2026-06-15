import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'dist');

test('cli bin prints usage and exits 0', () => {
  const out = execFileSync('node', [join(distDir, 'cli', 'index.js')], {
    encoding: 'utf8',
  });
  assert.match(out, /Usage:/);
  assert.match(out, /mail-index/);
});

test('mcp bin prints stub line and exits 0', () => {
  const out = execFileSync('node', [join(distDir, 'mcp', 'index.js')], {
    encoding: 'utf8',
  });
  assert.match(out, /mail-index-mcp stub/);
});
