#!/usr/bin/env node
/**
 * mail-index CLI entry point.
 *
 * M0.1 scaffold: prints usage and exits 0. Subcommands (init, sync, search,
 * status) land in M0.7.
 */

const USAGE = `mail-index — a local, agent-queryable mail intelligence layer

Usage:
  mail-index <command> [options]

Commands:
  init      Initialize the local index and operator config
  sync      Sync message metadata for an account
  search    Search the index
  status    Show index status

Run 'mail-index <command> --help' for command-specific options.
`;

function main(): number {
  process.stdout.write(USAGE);
  return 0;
}

process.exit(main());
