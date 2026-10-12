# ImageGen (app)

Tauri v2 macOS app — the optional interactive studio for the image-gateway. Owns the entire generation
library on local disk; the gateway holds no state.

## Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) ≥ 1.85 (required by `tauri-plugin-macos-fps`)
- [Bun](https://bun.sh)
- Xcode Command Line Tools (`xcode-select --install`)

Install JS dependencies from the repo root (this app is part of the Bun workspace):

```bash
bun install
```

## Development

```bash
bun run tauri dev
```

Starts the Vite dev server on `http://localhost:1420` and launches the native window.

## Build

```bash
bun run tauri build --bundles dmg
```

Produces a `.app` bundle and a `.dmg` under `src-tauri/target/release/bundle/`. The bundle is
ad-hoc signed (`signingIdentity: "-"` in `tauri.conf.json`) — fine for local/personal use, not
notarized for distribution outside this machine.

## First run

Open **Settings** (gear icon, top right) and enter:

- **Gateway URL** — the image-gateway's Tailscale address (the gateway is tailnet-only;
  make sure Tailscale is connected)
- **Bearer token** — the gateway's auth token

Both are stored in `localStorage`, nowhere else.

## Library location

Every generation is saved to `~/Pictures/ImageGen/<generation-id>/`:

- `image-1.<ext>` … `image-N.<ext>` — the generated image(s)
- `metadata.json` — prompt, resolved model/params, usage, cost, latency, and lineage
  (`parent_id` when the generation came from a re-run/tweak)

The folder is plain Finder-browsable; the app rebuilds its Library view entirely by reading
these folders back — nothing else is persisted.

## Regenerating the app icon

The icon set in `src-tauri/icons/` was generated once via:

```bash
bun run tauri icon path/to/source.png
```

Re-run this (with `-o src-tauri/icons`) against a new 1024×1024 source PNG to replace it. Only
the macOS/desktop icon set is kept (`32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png`,
`icon.icns`, `icon.png`) — `tauri icon` also generates Windows/iOS/Android assets by default,
which are pruned since this app targets macOS only.
