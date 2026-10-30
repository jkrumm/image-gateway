# image-gateway — the ImageGen Mac studio

**ImageGen** is a personal macOS studio (Tauri v2, React + Mantine/basalt-ui) for interactive image work: a Plan-driven Create surface, a local-first library with projects, roles, lineage and style guides — every generation lands as a Finder-browsable folder with a JSON metadata sidecar.

The repo name is historical. It once also held a stateless VPS gateway service; that service is retired (2026-10-30) and generation now lives in agent-workflows (agw). The studio is a client of agw's image door; a small `shared/` workspace package holds the zod contract and the prompting playbook it builds against.

## Status

- **Studio: supported on the MacBook** (its UI machine — see *MacBook install*). It calls the agw image door, `https://agw-image.<dev-domain>/door/image/{generate,edit,enhance}`, over the tailnet with a per-caller bearer (caller `studio`, from the mini's `~/.agent-workflows/data/door-tokens`).
- **Agents on the mini never need it.** They generate with `agw image` / `agw image-icon` (via `imgcli`, the `/img` skill).
- The wire contract is the one the gateway had, so the app's `gateway` settings key and request code are unchanged.

Mental model and IA: [`docs/concept.md`](docs/concept.md). Scope history (the gateway parts are retired): [`PRD.md`](PRD.md).

## MacBook install

Prerequisites: Xcode Command Line Tools (`xcode-select --install`), a Rust toolchain ≥ 1.85 (`rustup`), and `bun`. Tailscale connected and `ssh mini` working — `make configure` reads the door URL and token from the mini.

```bash
cd ~/SourceRoot && git clone git@github.com:jkrumm/image-gateway.git && cd image-gateway
bun install --frozen-lockfile
make app          # release build (~70 s warm, ~10 min cold) → /Applications/ImageGen.app, fingerprinted
make configure    # ssh mini: seeds the image door URL + studio token, never asks in-app
make app-run      # refuses to launch an app that is not built from this working tree
```

`make configure` reads the base URL and token from the mini over `ssh mini` and merges them into `~/Pictures/ImageGen/.imagegen/settings.json` (other keys kept, mode 600, token never printed); `AGW_DOOR_URL` / `AGW_DOOR_TOKEN` override either value.

The library lives at `~/Pictures/ImageGen/` — one folder per generation with its sidecar, plus `.imagegen/` for settings, drafts, projects and style guides. The in-memory index is rebuilt from the sidecars on every start; `.imagegen/` itself is state (tokens, projects, style guides with their reference files, the Create draft) — it lives with the library, is the owner's real data, and is never regenerated. `make app-status` says whether the installed app matches the checkout.

## Local dev

```bash
bun install
bun run dev        # tauri dev with HMR (the app's dev:stack)
make check         # format:check + lint + theme/sync guards + typecheck, then bun test
```

Root `typecheck`/`test` fan out across the workspaces (`shared`, `app`). The Rust/Tauri runtime is only verified by running the app on the MacBook.

## Logs

App (dev + packaged `.app`): `~/Library/Logs/com.jkrumm.image-gen/imagegen.log` via `tauri-plugin-log` (also mirrored to stdout in dev; `make app-logs` tails it). Captures generation failures, library warnings, and uncaught webview errors.

Personal software — public for reference, not built for reuse.
