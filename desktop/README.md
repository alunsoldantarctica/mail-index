# mail-index desktop

> **Status: scaffold only — not built yet.** This is a reviewable Tauri v2
> project + signing guide, not a compiled app. It also assumes a `mail-index
> setup --json` CLI that is **not built yet** (see the repo roadmap); the Rust
> commands are coded against that planned interface. Don't treat the `setup`
> commands below as callable today.

A thin **Tauri v2** GUI shell that walks a non-technical user through `mail-index`
onboarding. It does not implement any indexing itself — every step shells out to
the `mail-index` and `gog` CLIs and streams their output back to a 4-step
on-screen wizard:

1. **Install prerequisites** — installs `gog` (`brew install openclaw/tap/gogcli`
   on macOS; manual `gog.exe` on PATH on Windows) and verifies the bundled
   `mail-index` CLI.
2. **Sign in with Google** — runs `mail-index setup`, which places the bundled
   Google OAuth client and runs
   `gog auth add <email> --client mail-index --services gmail --gmail-scope=readonly`
   (opens the system browser; **read-only** Gmail).
3. **Sync now** — `mail-index sync --account <label> --since 1mo` with live progress.
4. **Connect to Claude** — prints the MCP config snippet
   `{ "mcpServers": { "mail-index": { "command": "mail-index-mcp" } } }`.

Per-account status comes from `mail-index status --json`; setup progress comes
from `mail-index setup … --json` (NDJSON step events). The CLI engine is built in
parallel — this shell codes against those interfaces.

## Layout

```
desktop/
├── package.json            # vite + @tauri-apps/cli v2 + @tauri-apps/api v2
├── tsconfig.json
├── vite.config.ts          # dev server on :1420
├── index.html              # the single onboarding screen (vertical stepper + log)
├── src/
│   ├── main.ts             # invokes Rust commands, listens for step://event
│   └── styles.css
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json     # bundle targets, window, resources
    ├── capabilities/
    │   └── default.json    # shell:allow-spawn/execute scope for the CLIs
    ├── resources/
    │   └── google-oauth-client.json(.example)  # OAuth client, injected at build
    ├── icons/              # generated via `pnpm tauri icon` (TODO)
    └── src/
        ├── main.rs
        └── lib.rs          # #[tauri::command] functions
```

## Rust commands

| Command            | CLI it drives                                              |
| ------------------ | --------------------------------------------------------- |
| `get_status`       | `mail-index status --json`                                |
| `install_prereqs`  | `gog --version` / `brew install openclaw/tap/gogcli`      |
| `run_setup`        | `mail-index setup --account <> --email <> --adapter <> --client <> --json` |
| `run_sync`         | `mail-index sync --account <> --since <>`                 |
| `open_mcp_help`    | (none — returns the MCP config snippet)                   |

## Develop

```sh
cd desktop
pnpm install
pnpm tauri dev
```

> Requires the Rust toolchain + Tauri v2 system deps. See
> https://v2.tauri.app/start/prerequisites/.

## Build installers

```sh
# macOS — Apple Disk Image (and .app)
pnpm tauri build --bundles dmg

# Windows — MSI (WiX) and NSIS
pnpm tauri build --bundles msi nsis
```

Output lands in `src-tauri/target/release/bundle/`.

## Build-time secret injection (OAuth client)

The Google **Desktop** OAuth client JSON is NOT committed. It lives in Bitwarden
Secrets Manager under key `mail-index/GOOGLE_OAUTH_CLIENT` and is written into
`src-tauri/resources/google-oauth-client.json` immediately before bundling, then
shipped as a Tauri resource and passed to `mail-index setup --client <path>`.

```sh
# Inject just before building (CI or local):
bws secret list \
  | jq -r '.[] | select(.key=="mail-index/GOOGLE_OAUTH_CLIENT") | .value' \
  > desktop/src-tauri/resources/google-oauth-client.json

pnpm tauri build --bundles dmg   # or: msi nsis
```

`resources/google-oauth-client.json` is gitignored. The committed
`.example` file documents the expected shape. **Never commit the real client.**

## Signing & notarization

Because this app spawns external binaries (`gog`, `mail-index`, `brew`), it
ships **outside** the Mac App Store / Microsoft Store — use Developer-ID signed
DMG (macOS) and an Authenticode-signed MSI/NSIS (Windows).

### macOS — Developer ID + notarytool

1. Set the signing identity in `tauri.conf.json` (`bundle.macOS.signingIdentity`)
   or via env, e.g. `APPLE_SIGNING_IDENTITY="Developer ID Application: Unsold Group (TEAMID)"`.
2. Build — Tauri codesigns the `.app` and `.dmg` with that identity:

   ```sh
   APPLE_SIGNING_IDENTITY="Developer ID Application: Unsold Group (TEAMID)" \
     pnpm tauri build --bundles dmg
   ```

3. Notarize with `notarytool` (Tauri can do this automatically when these env
   vars are set, or run it manually):

   ```sh
   export APPLE_ID="you@unsold.group"
   export APPLE_PASSWORD="app-specific-password"   # appleid.apple.com
   export APPLE_TEAM_ID="TEAMID"
   # Tauri auto-notarizes the DMG when the above are present, OR manually:
   xcrun notarytool submit \
     "src-tauri/target/release/bundle/dmg/mail-index_1.0.0_aarch64.dmg" \
     --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" \
     --wait
   ```

4. Staple the ticket so it validates offline:

   ```sh
   xcrun stapler staple "src-tauri/target/release/bundle/dmg/mail-index_1.0.0_aarch64.dmg"
   ```

   (Codesigning under the hood uses `codesign --deep --options runtime`; Tauri
   handles this with the hardened-runtime flag required for notarization.)

### Windows — Authenticode (signtool)

1. Obtain a code-signing certificate (OV or EV; EV avoids SmartScreen warmup).
2. Sign the produced MSI and NSIS installers:

   ```powershell
   signtool sign /fd SHA256 /a /tr http://timestamp.digicert.com /td SHA256 ^
     "src-tauri\target\release\bundle\msi\mail-index_1.0.0_x64_en-US.msi"

   signtool sign /fd SHA256 /a /tr http://timestamp.digicert.com /td SHA256 ^
     "src-tauri\target\release\bundle\nsis\mail-index_1.0.0_x64-setup.exe"
   ```

   Tauri can also sign automatically if `bundle.windows.certificateThumbprint`
   (+ `digestAlgorithm`, `timestampUrl`) is set in `tauri.conf.json`.

## TODOs

- [ ] Generate icons: `pnpm tauri icon path/to/source-1024.png`.
- [ ] Obtain Apple Developer ID cert + Windows code-signing cert.
- [ ] Bundle the `mail-index` CLI binary into `resources/bin/` (or as a Tauri
      sidecar) so `mail_index_program()` resolves it; confirm the
      `capabilities/default.json` shell scope permits the resolved absolute path
      (Tauri matches on `cmd`; absolute-path sidecars may need a sidecar entry).
- [ ] Wire the `bws` secret-injection step into CI before `tauri build`.
- [ ] Confirm final CLI flag names (`--email`, `--adapter`, `--json`) against the
      shipping `mail-index` engine.
