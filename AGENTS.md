# image-gateway (the ImageGen Mac studio)

The repo name is historical: the VPS gateway service it once held is retired (2026-10-30). Generation now lives in agent-workflows (agw); this repo is only **ImageGen**, the Tauri v2 macOS studio (`app/`) that is a client of agw's image door, plus the zod contract it builds against (`shared/`). Agents on the mini never need it: they generate with `agw image` / `agw image-icon` (via `imgcli`, the `/img` skill). The rename stays undone on purpose — it would churn basalt-ui `consumers.json`, herdr groups and paths for an app that is rarely opened.

**Start here:** `README.md` (state, MacBook install) → `docs/concept.md` (the studio's mental model and IA) → `DESIGN.md` (UI deltas on basalt-ui). `PRD.md` and `docs/research/` are history: the gateway parts are retired, and the probe tables (`endpoint-verification.md`) are dated snapshots of the upstream, re-verify before relying on them.

## Repo layout

| Path | What |
|-|-|
| `app/` | Tauri v2 macOS app. React + Mantine v9 + basalt-ui (basalt-ui is Mantine-based as of its 2026-07 zinc redesign — **no Tailwind**; wire via `BasaltProvider` + layered CSS imports, reference: argo dashboard). Owns the library at `~/Pictures/ImageGen/` — the owner's real state, never regenerated or touched by agents. The app deliberately keeps its `ImageGen` / `com.jkrumm.image-gen` identity (bundle id, productName, Cargo crate, library + `.imagegen/` paths, log dir) — changing it would orphan the WebKit localStorage partition, the logs path and the on-disk library. |
| `shared/` | `@image-gateway/shared` — the zod contract (request/response schemas, model ids, size rules, sidecar schema, playbook) the app imports. The wire contract is the one the door speaks, so the app's `gateway` settings key and request code (`app/src/lib/gateway.ts`) keep their names. |
| `scripts/` | `configure.sh` (seeds the door URL + token), `codesum.ts` (the app fingerprint). |
| `docs/` | `concept.md` is current; `prompting-playbook.md` and `research/` are dated background. |

## Local dev

- **The studio runs on the MacBook** (Xcode CLT + Rust ≥ 1.85 + bun; README → *MacBook install*). No agent runs there, so anything touching the Tauri runtime is verified by a human driving `make app-run`; say so in reports instead of implying green tests cover it.
- **`make up` / `make app` is how you use the app**: builds the release bundle, installs it to `/Applications/ImageGen.app`, and *proves* it was built from the current working tree via a `scripts/codesum.ts` fingerprint at `Contents/Resources/.codesum`, re-checked on every `make app-run` / `make app-status`. A stale `.app` is indistinguishable from a current one by eye; the assertion is what makes "rebuild later" safe. The fingerprint is a stronger guarantee than a cacheless rebuild (`--no-cache` proves only that the build was fresh, and cannot tell a stale cache from a real bug — "assert, don't nuke"); `CLEAN=1` rules out the toolchain deliberately (~10 min versus ~70 s). `make dev` (`tauri dev`, Vite on :1420) is for *writing* code. Root `bun run dev` runs only the app's `dev:stack`; the app's own `dev` script must stay plain `vite` — Tauri's `beforeDevCommand` invokes it.
- **`make configure`** seeds `~/Pictures/ImageGen/.imagegen/settings.json` (`scripts/configure.sh`) so the app never prompts for the door token. Settings v2 is `{ gateway: { baseUrl, token } }`: base URL `https://agw-image.<dev-domain>/door/image` (`DEV_DOMAIN` from the mini's `~/.config/caddy-tailnet.conf`, filtered on the mini, never sourced) and the `studio` line of the mini's `~/.agent-workflows/data/door-tokens`, both read over `ssh mini`; `AGW_DOOR_URL` / `AGW_DOOR_TOKEN` override either. It MERGES into an existing file (other keys kept, only `gateway.baseUrl`/`gateway.token` replaced, mode 600) and fails with the command to run when a value cannot be read; the token is never printed. `app/src/lib/settings.ts`'s `migrateSettingsShape()` upgrades a v1 flat `{ baseUrl, token }` file in place at read time (never rewrites it on disk, same lazy-upgrade pattern as the sidecar's schema migration); unknown keys — e.g. the retired `imageShare` connection — are ignored, never an error. **WebKit partitions localStorage per executable**: `tauri dev` stores under `~/Library/WebKit/image-gen`, the bundled app under `~/Library/WebKit/com.jkrumm.image-gen`; settings entered in one are invisible to the other. The file is the store of record; localStorage is a cache hydrated from it on boot.
- **Logs:** `~/Library/Logs/com.jkrumm.image-gen/imagegen.log` (`tauri-plugin-log`, stdout + LogDir targets; `make app-logs` tails it).
- **Secrets on the mini:** never plain `op` (blocks forever on a biometric prompt with no human present) — `secrets-run`. Nothing in this repo reads a secret any more; `configure.sh` reads over `ssh mini`.
- **Capability edits need a forced rebuild:** cargo's `rerun-if-changed` misses content edits to `src-tauri/capabilities/*.json` — `touch src-tauri/build.rs` before `cargo build`/`tauri dev`, then verify the generated `target/debug/build/image-gen-*/out/capabilities.json` (newest by mtime) contains the change.
- `http:default` scope patterns are URLPattern constructor strings — an omitted port means *default port only*, so wildcards must be `http://*:*`, never `http://**`.
- **No GUI automation for the app.** It once existed on the mini through cmux's Accessibility + Screen Recording grants; cmux was deleted 2026-09-04 and the app moved to the MacBook, where no agent runs. (If it ever comes back: the webview exposes no AXButton tree, so clicks are coordinate-based off a 1:1 screenshot, and the window must be `AXRaise`d before every capture.)

## Conventions

- **Public repo.** Never commit secrets, internal hostnames, or endpoint URLs. Placeholders only in docs (`<dev-domain>`).
- Direct-to-master, no ticket prefixes, conventional commits.
- Bun everywhere (`bun install --frozen-lockfile`); TypeScript strict; pin direct deps exact.
- basalt-ui changes stay in the basalt-ui repo with their own separate commits — never vendored or committed from here.
- **`snapSizeForModel(model, size)` in `shared/src/rules.ts` is the replay chokepoint.** Every path that re-runs a generation (Re-run, Promote, Tweak) routes its size through this function — it's the single place that turns a stored/derived size into a value the target model will actually accept. Changing replay behavior means changing it here, not in each caller.
- **Migrate before parse.** Sidecar `schema: 2` has no default and `migrateGenerationMetadata()` never rewrites the file on disk — so any code path that reads a sidecar and then re-parses or re-validates it must call `migrateGenerationMetadata()` first. Skipping this shipped a real bug once (`derived.ts`); treat it as a hard rule for every new read-then-write sidecar path.

## Model and API facts the studio encodes

Probed live against the upstream (2026-07-16 for gpt-image-2/1.5/1-mini, 2026-09-23 for the 2.5 pair); full tables: `docs/research/endpoint-verification.md`. Public write-ups get several of these wrong.

**New generations run on `gpt-image-2.5-flare` (speed, drafts) or `gpt-image-2.5-sunburst` (quality, edits, finals).** `gpt-image-2`, `gpt-image-1.5` and `gpt-image-1-mini` are retired from the generate path (2026-09-23) and supported forever on the read path. Two enums encode exactly this:

| Enum | Path | Contents | May shrink? |
|-|-|-|-|
| `IMAGE_MODELS` | generate | `['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']` | yes |
| `KNOWN_IMAGE_MODELS` | read (sidecar parsing) | all five, type `KnownImageModel` | **never** |

`MODEL_CAPABILITIES` is keyed by `KnownImageModel` and holds all five — it describes what each model *is*, which is how old sidecars stay interpretable (single source of truth, `shared/src/contract.ts`).

> **Retiring a model is never a subtractive enum edit.** `listGenerations()` silently skips sidecars that fail to parse, so removing a model id from the schema makes existing library entries vanish with only a log warning. Split the enums instead.

- **Routing for `model: 'auto'`** (`resolveModel`/`routingReason`, `shared/src/rules.ts`): an edit always routes to `sunburst`; a generate at `quality: high|xhigh|max` routes to `sunburst`; `low|medium|auto` routes to `flare`. An explicit model is always honoured. `xhigh` and `max` are gated by `MODEL_CAPABILITIES.extendedQuality` (`validateQualityForModel`); older models 400 on them.
- **Transparency** works on both generatable models (`background: "transparent"` + png/webp returns real RGBA). `validateTransparentOutputFormat()` rejects jpeg (no alpha). Never propose chroma-key / "generate on a flat colour and key it out" (`docs/research/transparency-and-vector.md`: colour leakage, 1px halos).
- **Painted checkerboard:** prompt text asking for "transparent background" while `background: "opaque"` is sent makes the model paint a fake checkerboard instead of erroring. Prompt wording must *match* the `background` parameter; check `hasAlpha`/PNG colortype on output, never trust the image visually.
- **Streaming partials are per-model:** `flare` emits ZERO partial frames regardless of `partial_images` (only `completed`); `sunburst` emits partials. Never build UI that assumes at least one arrives. Streaming is n=1 only. **SSE event names are per-endpoint:** generations emit `image_generation.*`, edits emit `image_edit.*` — matching only the first silently breaks every streamed edit.
- Neither 2.5 model accepts **`input_fidelity`** (hard 400) — never send it. It and `background: 'transparent'` stay valid *schema* values so historical sidecars parse; valid to parse is not valid to send.
- The upstream vendor proxy wraps 400-class validation errors in an **HTTP 503** (two body shapes); a "503" is usually a 400 telling you what you got wrong — never retry it.
- Cost per image (identical for flare/sunburst): low ≈ $0.006, medium ≈ $0.013, high ≈ $0.053 (~9× low), xhigh ≈ $0.094, max ≈ $0.211 (~35.8× low) — why quality stays adjustable and previews default on. Don't reuse these for gpt-image-1.5 (~2.2× more expensive).

## Validate

`make check` (no side effects; exits non-zero on failure) runs `bun run pre` then `bun test` — what `.github/workflows/check.yml` runs. The Tauri/Rust build is not part of it.

- **`bun run pre`** = `format:check && lint && check:theme && check:sync && typecheck`, plus `bun test` (~300 tests across `shared` and `app`). `check:theme` (`basalt-ui check-theme`, the palette + doctrine guard) and `check:sync` (`basalt-ui sync --check`, the managed-file drift gate) run through the LOCAL bin so a basalt upgrade's guard promotions are reported locally, not first in CI; check-theme reads `basalt.roots` from the root `package.json` (`app/src`). Every `theme-allow` must name its rule id — `theme-allow <rule-id> — <reason>`; a bare one warns and waives nothing. A comment-ONLY line directly above the finding is honoured.
- **oxlint + oxfmt**, matching the basalt-ui/argo ecosystem (never Biome/ESLint/Prettier). Root `.oxlintrc.json` extends the shipped basalt preset (`./node_modules/basalt-ui/configs/oxlint.json` — oxlint rejects bare specifiers). Style: single quotes, no semicolons, printWidth 100.
- `basalt-ui` is **pinned to the published npm version** in both root `package.json` (purely so lint can resolve that preset) and `app/package.json`. Keep the two in lockstep — never a `file:` link (`docs/concept.md` §9 has the incident). Upgrade via `/upgrade-deps`, then `./node_modules/.bin/basalt-ui sync` + `bun run pre` — the local bin, never `bunx`, which serves a cached copy.
- **Tests cover pure logic** (lib functions, stores, replay/lineage/roles, the contract); there is no component/integration harness. Anything touching the Tauri runtime (fs capabilities, `plugin-http`, canvas pointer math, the webview) is unverified until someone runs the app on the MacBook — a dot-glob fs-scope bug (below) shipped invisible to all of them and was fatal at first boot.
- Root `bun run typecheck` covers all workspaces — don't run it while another agent is mid-flight in a package you don't own; scope it: `cd app && bunx tsc --noEmit -p tsconfig.app.json`.

## Gotchas

- **Two different `capabilities.json` files.** `src-tauri/gen/schemas/capabilities.json` is the *schema of every possible permission* — grepping it proves nothing. The **granted** set is `src-tauri/target/debug/build/image-gen-*/out/capabilities.json` (newest by mtime). Verify there.
- **zod v4 keeps `.shape` through `.superRefine()`** — object schemas with refinements still expose `.shape.field`, so `metadata.ts`'s "reuse the contract's field schemas" pattern survives.
- **`tauri-plugin-fs` defaults to `require_literal_leading_dot: true` on unix** (`tauri-plugin-fs-2.5.1/src/commands.rs:1559`). A glob like `$PICTURE/ImageGen/**` **cannot match** anything under `.imagegen/...`. Every dot-prefixed directory needs its own explicit scope entries — both `$PICTURE/ImageGen/.imagegen` *and* `$PICTURE/ImageGen/.imagegen/**` — on every fs permission that touches it. This shipped broken once: the whole `.imagegen/` state dir (drafts, projects, styles) threw `forbidden path` on first boot until `app/src-tauri/capabilities/default.json` was fixed.

## Design system

Read `DESIGN.md` before any UI work — it records this app's deltas on top of basalt-ui. The basalt-ui managed block (stack, precedence, restraint and chart-doctrine overrides) sits at the end of this file, written by `basalt-ui sync`; the shipped `.claude/rules/basalt-*.md` complete it.

<!-- basalt:begin 1.41.0 -->

## basalt-ui (managed — do not hand-edit)

Placed by `bunx basalt-ui init`, refreshed by `basalt-ui sync` (`sync --check` gates drift in CI).
Framework-owned: edit `DESIGN.md` or your own files — this block is overwritten on the next sync.

**Stack:** React 19 + Mantine v9 themed by `basalt-ui` (`BasaltProvider` + `createBasaltTheme`), Bun,
oxlint + oxfmt (no ESLint/Biome/Prettier), no Tailwind. Color is the three-tier `--vx-*` token system —
`VX.*` or a series token, never a raw hex. Charts are visx via `basalt-ui/charts`; `check-theme` + the
`basalt/*` oxlint rules are the teeth.

**Precedence — the only statement of it.** Highest wins; a lower layer fills gaps and never
overrides a higher one:

> consumer `DESIGN.md` (app deltas) > the six shipped `basalt-*` rules > the `basalt-*` skills

**All six rules are law** — `basalt-{tokens,mantine,charts,state,controls,batteries}` in
`.claude/rules/`, each with a generated `<!-- basalt:coverage -->` header naming what enforces it and
what is only advisory. The skills (`/basalt-app`, `/basalt-design`, `/basalt-charts`) are METHOD, never law.

**Run the LOCAL bin, not `bunx`** — `./node_modules/.bin/basalt-ui`, or a `package.json` script.
`bunx` does not re-resolve a cached package, so it can answer for a version you upgraded away from;
`init` is the one legitimate `bunx` invocation, because nothing is installed yet.

**Before guessing an import, read the installed package's `llms.txt` and `AGENTS.md`** — at the
install directory (in a workspace, under the depending package; `basalt-ui doctor` prints where).

@./DESIGN.md

**Restraint override (supersedes `/frontend-design`).** This app is a calm, data-dense professional
surface, not a showcase. Ignore the push toward a "BOLD aesthetic direction", gradient meshes,
noise/grain and dramatic motion. Here: the shipped three-font system, depth from a whisper shadow
with a 1px ring, neutral-by-default with the single accent spent only when earned — trend, signal,
or genuine categorical separation. Restraint **is** the identity.

**Chart-doctrine override.** A global `visx-charts` rule auto-loading on `**/charts/**` is generic
non-basalt discipline; here `basalt-charts` supersedes it — compose `CartesianChart`.

<!-- basalt:end -->
