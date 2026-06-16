# Icons (TODO)

Tauri needs these icon files referenced in `tauri.conf.json > bundle.icon`:

- `32x32.png`
- `128x128.png`
- `128x128@2x.png`
- `icon.icns` (macOS)
- `icon.ico` (Windows)

Generate them all from a single 1024x1024 source PNG:

```sh
pnpm tauri icon path/to/source-1024.png
```

This command writes every required size/format into this directory.
Until then, builds will fail at the bundling step for lack of icons.
