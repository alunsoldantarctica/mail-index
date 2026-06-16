/**
 * The gog CLI invocation seam (adapter #2). The {@link GogAdapter} never spawns
 * a process directly — it calls a {@link GogRunner}, an injectable function that
 * runs one `gog <args>` invocation and resolves to the parsed JSON stdout.
 *
 * Unlike gws (which isolates each mailbox via a per-account
 * `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` env var), gog stores its own OAuth tokens in
 * its own config dir and selects the mailbox with `-a <email>` on the command
 * line. So the runner takes no config dir: the adapter puts `-a <account>` into
 * the argv it builds, and the runner only appends the output/JSON flags every
 * call needs (`-j`, `--gmail-no-send`) and parses stdout as JSON.
 *
 * This is the single point where live network would happen, so it is the single
 * point a test swaps for recorded fixtures (capture/replay): the contract suite
 * runs the *real* adapter logic — argument building, pagination, JSON parsing,
 * payload walking — against a fixture-backed runner, with NO child process and
 * NO network (PLAN §19).
 */

import { spawn } from 'node:child_process';

/** Error thrown for gog adapter failures (spawn, non-zero exit, bad JSON). */
export class GogError extends Error {
  override name = 'GogError';
}

/**
 * Runs one gog invocation and returns its parsed JSON stdout.
 *
 * @param args argv after the binary (e.g. `['gmail','messages','search','newer_than:1m','-a','me@x.com','--max','100']`).
 */
export type GogRunner = (args: readonly string[]) => Promise<unknown>;

/** Options for the default process-backed runner. */
export interface SpawnRunnerOptions {
  /** Path/name of the gog binary. Defaults to `gog` (resolved via PATH). */
  bin?: string;
}

/**
 * The production {@link GogRunner}: spawns the gog binary, appends `-j` (JSON
 * output) and `--gmail-no-send` (read-only defence-in-depth) to whatever args
 * the adapter built, captures stdout/stderr, and parses stdout as JSON. Rejects
 * with {@link GogError} on spawn failure, non-zero exit, or unparseable output.
 */
export function spawnGogRunner(options: SpawnRunnerOptions = {}): GogRunner {
  const bin = options.bin ?? 'gog';
  return (args) =>
    new Promise<unknown>((resolve, reject) => {
      const argv = [...args, '-j', '--gmail-no-send'];
      const child = spawn(bin, argv, {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c: string) => (stdout += c));
      child.stderr.on('data', (c: string) => (stderr += c));

      child.on('error', (err) => {
        reject(new GogError(`failed to spawn ${bin}: ${err.message}`));
      });

      child.on('close', (code) => {
        if (code !== 0) {
          const detail = stderr.trim() || stdout.trim() || '(no output)';
          reject(new GogError(`${bin} ${argv.join(' ')} exited ${code ?? '?'}: ${detail}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (err) {
          reject(
            new GogError(
              `failed to parse gog JSON output for ${args.join(' ')}: ${(err as Error).message}`,
            ),
          );
        }
      });
    });
}
