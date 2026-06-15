/**
 * `mail-index init` (SCOPE 0.7, PLAN §13).
 *
 * Scaffolds the operator's private config from the shipped `config.example.json`
 * placeholder and creates the index data directory. This is the 2a→2b seam
 * (PLAN §2): the distributable tool carries only the schema + example; `init`
 * stands up the operator's local files without ever shipping account data.
 *
 * Idempotent and non-destructive: an existing config is never overwritten (the
 * operator's real accounts are sacred). The example template lives next to the
 * built CLI in the package, located relative to this module so it works from a
 * global install as well as a repo checkout.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultConfigPath } from '../config/index.js';
import { defaultDbPath } from '../index/db.js';

/** Result of an {@link runInit} run, for testable assertions + output. */
export interface InitResult {
  configPath: string;
  /** True when this run wrote a fresh config; false when one already existed. */
  configCreated: boolean;
  dataDir: string;
}

/**
 * Locate the shipped `config.example.json`. Built to `dist/cli/init.js`, the
 * example sits two levels up at the package root; in the source tree it is the
 * same relative path from `src/cli/`.
 */
function exampleConfigPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'config.example.json');
}

/**
 * Scaffold the operator config + data dir. `configPath` and `examplePath` are
 * injectable for tests; production uses the XDG default + shipped example.
 */
export function runInit(
  opts: { configPath?: string; examplePath?: string; dataDir?: string } = {},
): InitResult {
  const configPath = opts.configPath ?? defaultConfigPath();
  const examplePath = opts.examplePath ?? exampleConfigPath();
  const dataDir = opts.dataDir ?? dirname(defaultDbPath());

  mkdirSync(dataDir, { recursive: true });

  let configCreated = false;
  if (!existsSync(configPath)) {
    mkdirSync(dirname(configPath), { recursive: true });
    copyFileSync(examplePath, configPath);
    configCreated = true;
  }

  return { configPath, configCreated, dataDir };
}

/** Render the init outcome + next steps as the CLI prints them. */
export function formatInit(result: InitResult): string {
  const lines: string[] = [];
  if (result.configCreated) {
    lines.push(`Created operator config at ${result.configPath}`);
    lines.push('');
    lines.push('Next steps:');
    lines.push(`  1. Edit ${result.configPath} — replace the placeholder accounts with`);
    lines.push('     your own (each maps a label to a gws configDir; see CONTEXT.md "Account").');
    lines.push('  2. Run: mail-index sync --account <label> --since 1mo');
    lines.push('  3. Then: mail-index search "your query"');
  } else {
    lines.push(`Operator config already exists at ${result.configPath} — left untouched.`);
    lines.push(`Index data dir: ${result.dataDir}`);
  }
  return lines.join('\n') + '\n';
}
