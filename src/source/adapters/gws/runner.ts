/**
 * The gws CLI invocation seam (SCOPE 0.4). The {@link GwsAdapter} never spawns a
 * process directly — it calls a {@link GwsRunner}, an injectable function that
 * runs one `gws <args>` invocation with a per-account
 * `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` and resolves to the parsed JSON stdout.
 *
 * This is the single point where live network would happen, so it is the single
 * point a test swaps for recorded fixtures (capture/replay): the contract suite
 * runs the *real* adapter logic — argument building, pagination, JSON parsing,
 * payload walking — against a fixture-backed runner, with NO child process and
 * NO network (PLAN §19).
 */

import { spawn } from 'node:child_process';

/** Error thrown for gws adapter failures (spawn, non-zero exit, bad JSON). */
export class GwsError extends Error {
  override name = 'GwsError';
}

/**
 * Runs one gws invocation and returns its parsed JSON stdout.
 *
 * @param args     argv after the binary (e.g. `['gmail','users','messages','list','--params','{...}']`).
 * @param configDir value for `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` (the account's isolated config).
 */
export type GwsRunner = (args: readonly string[], configDir: string) => Promise<unknown>;

/** Options for the default process-backed runner. */
export interface SpawnRunnerOptions {
  /** Path/name of the gws binary. Defaults to `gws` (resolved via PATH). */
  bin?: string;
}

/**
 * The production {@link GwsRunner}: spawns the gws binary with the account's
 * config dir exported, captures stdout/stderr, and parses stdout as JSON.
 * Rejects with {@link GwsError} on spawn failure, non-zero exit, or unparseable
 * output.
 */
export function spawnGwsRunner(options: SpawnRunnerOptions = {}): GwsRunner {
  const bin = options.bin ?? 'gws';
  return (args, configDir) =>
    new Promise<unknown>((resolve, reject) => {
      const child = spawn(bin, [...args], {
        env: { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: configDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c: string) => (stdout += c));
      child.stderr.on('data', (c: string) => (stderr += c));

      child.on('error', (err) => {
        reject(new GwsError(`failed to spawn ${bin}: ${err.message}`));
      });

      child.on('close', (code) => {
        if (code !== 0) {
          const detail = stderr.trim() || stdout.trim() || '(no output)';
          reject(new GwsError(`${bin} ${args.join(' ')} exited ${code ?? '?'}: ${detail}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (err) {
          reject(
            new GwsError(
              `failed to parse gws JSON output for ${args.join(' ')}: ${(err as Error).message}`,
            ),
          );
        }
      });
    });
}
