# Publishing — npm + the MCP Registry

The official [MCP Registry](https://registry.modelcontextprotocol.io) hosts only
*metadata*; the runnable artifact must live on **npm** first. So publishing is
two steps: (1) publish the npm package, (2) publish `server.json` to the registry.

Both steps need **your** credentials (npm login + GitHub OAuth) and are run
interactively — they can't be automated from an agent session. Everything below
is already prepared in the repo; you run the credentialed commands.

## Prerequisites

- An **npm account** (`mail-index` and `@alunsoldantarctica/mail-index` were both
  free as of prep — unscoped `mail-index` is configured).
- A **GitHub account** in the `alunsoldantarctica` namespace (it owns the
  `io.github.alunsoldantarctica/*` registry namespace via OIDC).
- Node 24+ and `pnpm`.

## What's already set up

- `package.json`: `"private": false`, `"publishConfig": { "access": "public" }`,
  `"mcpName": "io.github.alunsoldantarctica/mail-index"` (the registry ownership
  check), `"files": ["dist"]`, both bins, and `prepublishOnly: tsc` (builds
  `dist/` before publish).
- `server.json`: the registry manifest. Note the `runtimeArguments` — they make a
  client launch the **MCP** bin, not the CLI: `npx -y -p mail-index mail-index-mcp`
  (the package ships two bins, `mail-index` and `mail-index-mcp`).

## Step 1 — publish to npm

```sh
pnpm install
pnpm build            # also runs via prepublishOnly
pnpm test             # green gate before shipping
npm login             # your npm account + 2FA  (use `npm`, not pnpm, for auth)
npm publish           # publishes unscoped public `mail-index@1.0.0`
```

Verify: `npm view mail-index version` → `1.0.0`, and `npx -y -p mail-index mail-index-mcp`
should start the stdio server (Ctrl-C to exit).

## Step 2 — publish to the MCP Registry

Install the publisher CLI:

```sh
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
sudo mv mcp-publisher /usr/local/bin/
mcp-publisher --help
```

Then, from the repo root:

```sh
# (optional) regenerate a schema-current template and re-apply our runtimeArguments:
# mcp-publisher init
mcp-publisher login github      # opens a browser; authorizes the alunsoldantarctica namespace
mcp-publisher publish server.json
```

Verify:

```sh
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.alunsoldantarctica/mail-index"
```

## Dual-bin note (read before publishing)

mail-index ships **two** bins — `mail-index` (CLI) and `mail-index-mcp` (server).
Plain `npx mail-index` runs the CLI, so `server.json` uses `runtimeArguments` to
launch `mail-index-mcp` explicitly. If a consuming client doesn't honor those
args, the reliable fallback for users is a global install + the documented config:

```sh
npm i -g mail-index
# agent config: { "mcpServers": { "mail-index": { "command": "mail-index-mcp" } } }
```

After a real client test confirms the registry launch, no change is needed. If it
proves fiddly, the clean long-term fix is to make `mail-index-mcp` the package's
default bin (or split the CLI into a subcommand).

## Other directories (optional, after npm publish)

Once on npm, these directories accept a submission or auto-index from the registry
and let you specify the exact launch command:
[Smithery](https://smithery.ai), [PulseMCP](https://www.pulsemcp.com),
[mcp.so](https://mcp.so), [Glama](https://glama.ai/mcp/servers). Use the
`mail-index-mcp` command (global install) or `npx -y -p mail-index mail-index-mcp`.

## Releasing new versions

Bump `version` in **both** `package.json` and `server.json`, `npm publish`, then
`mcp-publisher publish server.json`. Consider the
[publish-mcp GitHub Action](https://github.com/modelcontextprotocol/registry/blob/main/docs/guides/publishing/github-actions.md)
to automate step 2 on tag.
