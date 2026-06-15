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

test('mcp bin fails fast with a config error (no operator config) — never blocks stdio', () => {
  // The MCP bin is a real stdio server (M3.4). With no operator config it must
  // exit non-zero with a clear ConfigError on STDERR (STDOUT is the JSON-RPC
  // transport and must stay clean). Point XDG_CONFIG_HOME at an empty dir so the
  // run is hermetic regardless of the machine's real config.
  let stderr = '';
  let code = 0;
  try {
    execFileSync('node', [join(distDir, 'mcp', 'index.js')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      env: { ...process.env, XDG_CONFIG_HOME: join(here, '__no_such_config__') },
    });
  } catch (err) {
    code = err.status ?? 1;
    stderr = String(err.stderr ?? '');
  }
  assert.notEqual(code, 0, 'exits non-zero when it cannot start');
  assert.match(stderr, /mail-index-mcp:/);
  assert.match(stderr, /no operator config|config/);
});
