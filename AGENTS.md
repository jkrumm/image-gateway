# image-gateway

Personal image-generation gateway: a stateless VPS gateway (`gateway/`) wrapping the gpt-image model family, reached by agents through `imgcli gen` (the dotfiles `/img` skill) — plus an optional interactive Tauri v2 macOS studio (`app/`) that owns all state on local disk.

**Start here:** `README.md` (current state, MacBook install) → `PRD.md` (scope, waves, success criteria) → `docs/concept.md` (the studio's mental model and IA) → `docs/research/endpoint-verification.md` (ground truth about the upstream). **The gateway and the agent lane are the primary surface; the studio app is secondary but supported** and runs on the MacBook (its UI machine) — agents on the mini reach the gateway through `imgcli gen` (dotfiles `/img` skill) and never need the app.

## Repo layout

| Path | What |
|-|-|
| `gateway/` | Elysia + Bun HTTP service. Stateless — no DB, no image storage. Docker on the VPS, Tailscale-only, bearer auth. |
| `app/` | Tauri v2 macOS app. React + Mantine v9 + basalt-ui (basalt-ui is Mantine-based as of its 2026-07 zinc redesign — **no Tailwind**; wire via `BasaltProvider` + layered CSS imports, reference: argo dashboard). Owns the library at `~/Pictures/ImageGen/`. The app deliberately keeps its `ImageGen` / `com.jkrumm.image-gen` identity (bundle id, productName, Cargo crate, library + `.imagegen/` paths, log dir) after the repo rename to `image-gateway` — changing it would orphan the WebKit localStorage partition, the logs path and the on-disk user library. |
| `shared/` | `@image-gateway/shared` — the zod contract (request/response schemas, model ids, size rules) consumed by both gateway and app. |
| `docs/research/` | Dated research findings. Treat as snapshots — re-verify time-sensitive claims (API bugs, versions) before relying on them. `endpoint-verification.md` is the live-probed record; the rest is background. |

## Local dev

- **`make up` is the entrypoint** — it brings both halves to your working tree (build+install the Mac app, deploy the gateway) and then *proves* each: the app by source fingerprint, the gateway by comparing the running image's git-SHA tag against `HEAD`. Both checks exist because "it's healthy" and "it's running your code" are different claims, and only the second one is worth anything after an edit.
- **`make configure`** seeds `~/Pictures/ImageGen/.imagegen/settings.json` from 1Password so the app never prompts for the gateway token. Settings v2 is `{ gateway: { baseUrl, token } }`, from `op://vps/image-gateway/{BASE_URL,API_SECRET}` (the target fails loudly if these are unreadable). `app/src/lib/settings.ts`'s `migrateSettingsShape()` upgrades a v1 flat `{ baseUrl, token }` file in place at read time (never rewrites it on disk, same lazy-upgrade pattern as the sidecar's schema migration); unknown keys — e.g. the retired `imageShare` connection — are ignored, never an error. This is needed because **WebKit partitions localStorage per executable**: `tauri dev` stores under `~/Library/WebKit/image-gen`, the bundled app under `~/Library/WebKit/com.jkrumm.image-gen`. Settings entered in one are invisible to the other. The file is the store of record; localStorage is a cache hydrated from it on boot.
- **Never let a Makefile target call `op` without a timeout.** On this machine `op` blocks forever on a biometric prompt nobody is present to approve, which turns "read a secret" into a hang rather than an error. The `op_read` helper at the top of the Makefile tries `secrets-run` (offline cache, fails fast) and falls back to `timeout 15 op`. A hung target is worse than a failed one: it gives you nothing to act on and burns the whole tool-call budget.
- **`op signin` does not persist into later tool calls** — it exports a session token into *that* shell only. What actually makes `op` work non-interactively is 1Password's desktop-app CLI integration, and even then the session lapses. Treat `secrets-run` + `headless.refs` as the only reliable path; both `op://vps/image-gateway/{API_SECRET,BASE_URL}` are allowlisted there.
- **`op` over ssh reads stdin as JSON.** `ssh vps 'op item create ...'` fails with `invalid JSON in piped input` because ssh hands it a non-tty stdin. Redirect it: `</dev/null`.
- **The VPS 1Password service account is read-only on the `vps` vault** — it can `read` but not `item create`/`item edit`. New gateway secrets must be created from a signed-in human machine or the 1Password GUI.
- **`bun run dev` is not how you use the app.** `make app` builds the release bundle, installs it to `/Applications/ImageGen.app`, and *proves* the installed app was built from the current working tree — it records a `scripts/codesum.ts` fingerprint at `Contents/Resources/.codesum` and re-checks it on every `make app-run` / `make app-status`. A stale `.app` in the dock is indistinguishable from a current one by eye, and the ~70s cargo release build makes "rebuild later" tempting; the assertion is what makes that safe. **The fingerprint is a stronger guarantee than a cacheless rebuild**, which is why it is the default: `--no-cache` proves only that the build was fresh, not that the artifact came from the tree in front of you, and it cannot tell a stale cache apart from a real bug — so pulling it skips a diagnosis rather than completing one (`dotfiles/rules/makefile-conventions.md`: "assert, don't nuke"). `CLEAN=1` exists for deliberately ruling out the toolchain, at ~10 min versus ~70s. `make dev` (the Vite/`tauri dev` pair) is for *writing* code.
- Root `bun run dev` runs both halves concurrently via `bun run --filter '*' dev:stack` (no `concurrently` dep): gateway on **:7716** (`bunx kill-port` first, secrets via `secrets-run` + `.env.local.tpl`) and `tauri dev` (Vite on :1420 is Tauri-internal). **The app half lives on the MacBook** — `make app`, `make app-run` and `tauri dev` run there (Xcode CLT + Rust ≥ 1.85 + bun; README → *MacBook install*). The Mac mini runs the gateway half only: probes, `bun test`, `make gateway-*`, and `imgcli gen`. Secrets backend on the mini is `cache`: always use `secrets-run`, never plain `op` (it hangs forever on the biometric prompt with no human present).
- `image-gateway.test` → localhost:7716 is registered in the dotfiles Caddyfile (port registry).
- The app's `dev` script must stay plain `vite` — Tauri's `beforeDevCommand` invokes it; the concurrent pair uses `dev:stack`.
- **Logs:** app → `~/Library/Logs/com.jkrumm.image-gen/imagegen.log` (`tauri-plugin-log`, stdout + LogDir targets); gateway → single-line JSON on stdout (`docker logs` on the VPS).
- **Capability edits need a forced rebuild:** cargo's `rerun-if-changed` misses content edits to `src-tauri/capabilities/*.json` — `touch src-tauri/build.rs` before `cargo build`/`tauri dev`, then verify the generated `target/debug/build/image-gen-*/out/capabilities.json` (newest by mtime) contains the change.
- `http:default` scope patterns are URLPattern constructor strings — an omitted port means *default port only*, so wildcards must be `http://*:*`, never `http://**`.
- **No GUI automation for the app.** It once existed on the mini through cmux's Accessibility + Screen Recording grants; cmux was deleted 2026-09-04 and the app moved to the MacBook, where no agent runs. Anything touching the Tauri runtime is verified by a human driving `make app-run` there — say so in reports instead of implying green tests cover it. (If it ever comes back: the webview exposes no AXButton tree, so clicks are coordinate-based off a 1:1 screenshot, and the window must be `AXRaise`d before every capture.)

## Conventions

- **Public repo.** Never commit secrets, internal hostnames, or endpoint URLs — the upstream LLM endpoint base URL and API key resolve from 1Password (`op://common/anthropic/OPENAI_BASE_URL`, `op://common/anthropic/API_KEY`) via `.env.tpl` templates. Placeholders only in docs.
- Direct-to-master, no ticket prefixes, conventional commits.
- Bun everywhere (`bun install --frozen-lockfile`); TypeScript strict; pin direct deps exact.
- Gateway follows the established personal-gateway pattern (typed contract, OpenAPI, bearer auth, Makefile-driven Docker deploy) — mirror `research-gateway`/`audio-gateway` structure where sensible, and reuse the `generateImage()` patterns from `agent-gateway/server/lib/iu-openai.ts` (retry set, 410 fail-fast, PNG magic-byte check, usage sink).
- basalt-ui changes stay in the basalt-ui repo with their own separate commits — never vendored or committed from here.
- **`snapSizeForModel(model, size)` in `shared/src/rules.ts` is the replay chokepoint.** Every path that re-runs a generation (Re-run, Promote, Tweak) routes its size through this function — it's the single place that turns a stored/derived size into a value the target model will actually accept. Changing replay behavior means changing it here, not in each caller.
- **Migrate before parse.** Sidecar `schema: 2` has no default and `migrateGenerationMetadata()` never rewrites the file on disk — so any code path that reads a sidecar and then re-parses or re-validates it must call `migrateGenerationMetadata()` first. Skipping this shipped a real bug once (`derived.ts`); treat it as a hard rule for every new read-then-write sidecar path.

## Probe the endpoint — do not trust docs about it

**The single most valuable habit in this repo.** In one session, live probes disproved **five** claims that vendor docs, blogs, and a fresh deep-research report all asserted (edits being broken, edits being presets-only, `n=1` on older models, `input_fidelity` being ignored rather than a hard 400, and SSE event names being uniform). Three would have shipped code that typechecked and then failed at runtime. Research is a *starting hypothesis*; the endpoint is the truth.

A probe costs ~$0.006 (`quality: "low"`) and ~20 seconds. That is always cheaper than an agent guessing wrong.

```bash
cd gateway && secrets-run run --env-file=.env.local.tpl -- bun /path/to/scratch/probe.ts
```

- `secrets-run` is a drop-in `op` shim — **required on the mini** (secrets backend there is `cache`), where plain `op`/`op run` hangs on the biometric prompt forever with no human present to approve it.
- Read `OPENAI_BASE_URL`/`OPENAI_API_KEY` from `process.env`; append paths (`/images/generations`) exactly like `upstream.ts` — never hardcode `/openai/v1`.
- Put throwaway probes in a scratch dir, **never in the repo**.
- Elide `b64_json` when printing or you will flood the terminal with megabytes of base64.
- Remember the 503-wrapping (below): a "503" in a probe is usually a **400 telling you exactly what you got wrong** — read the body.

**When a brief hands you a "verified fact", trust it. When it hands you a generalization ("X is per-model, so it must hold for Y"), probe Y.** That exact generalization is what produced this session's one real bug: SSE event names turned out to be per-*endpoint* (`image_edit.*`), and matching only `image_generation.*` silently broke every streamed edit.

## Load-bearing API facts (live-probed against our own endpoint — 2026-07-16 for gpt-image-2/1.5/1-mini, 2026-09-23 for the 2.5 pair — see docs/research/endpoint-verification.md)

These come from probing the upstream we actually call, not from vendor docs — public write-ups get several of them wrong. Re-probe before trusting any contradicting source.

### The studio generates on two models: gpt-image-2.5-flare / gpt-image-2.5-sunburst

**All new generations run on `gpt-image-2.5-flare` (speed-optimized, drafts) or `gpt-image-2.5-sunburst` (quality-optimized, editing precision/final renders).** `gpt-image-2`, `gpt-image-1.5` and `gpt-image-1-mini` are **retired from the generate path** (2026-09-23) and permanently supported on the **read path**. Two enums encode exactly this, and the distinction is load-bearing:

| Enum | Path | Contents | May shrink? |
|-|-|-|-|
| `IMAGE_MODELS` | generate | `['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']` | yes |
| `KNOWN_IMAGE_MODELS` | read (sidecar parsing) | all five, type `KnownImageModel` | **never** |

`MODEL_CAPABILITIES` is keyed by `KnownImageModel` and still holds all five — it describes what each model *is*, which is how old sidecars stay interpretable.

> **Retiring a model is never a subtractive enum edit.** `listGenerations()` silently skips sidecars that fail to parse, so removing a model id from the schema makes existing library entries vanish with only a log warning. Split the enums: `KNOWN_IMAGE_MODELS` (read path, never shrink) vs `IMAGE_MODELS` (generate path, safe to shrink).

**Transparency is AVAILABLE again** on both generatable models (probe-verified 2026-09-23: `background: "transparent"` + png/webp returns real RGBA, colortype 6 — subject alpha ~252–253, not a full 255, but a real alpha channel). This closes the gap the single-model gpt-image-2 era opened: `validateBackgroundForModel()` now passes for both 2.5 models, and `validateTransparentOutputFormat()` is the new guard — `transparent` needs `png`/`webp` output, `jpeg` has no alpha and is rejected. Apple Vision matting (`docs/research/transparency-and-vector.md`) was the interim restoration path while no generatable model had an alpha channel; it is documented there only as history now. **Still never** propose chroma-key / "generate on a flat colour and key it out" — that doc records it as a separate, permanent failure (colour leakage, non-uniform solids, 1px halos), unrelated to whether native alpha exists.

Routing for `model: 'auto'` (`resolveModel`/`routingReason` in `shared/src/rules.ts`): an edit always routes to `sunburst`; a generate at `quality: high|xhigh|max` routes to `sunburst`; a generate at `quality: low|medium|auto` routes to `flare`. An explicit model is always honoured. `quality` also gained two tiers, `xhigh` and `max`, gated by `MODEL_CAPABILITIES.extendedQuality` (`validateQualityForModel`) — the legacy models (and gpt-image-2) predate them and 400 on an unrecognized value.

### Gotchas that cost real debugging (full probe tables, cost numbers, per-model matrix: `docs/research/endpoint-verification.md`)

- **Capabilities are per-model, not per-endpoint** (`MODEL_CAPABILITIES` in `shared/src/contract.ts` is the single source of truth) — with one exception: **SSE event names are per-endpoint**: `/images/generations` emits `image_generation.*`, `/images/edits` emits `image_edit.*` — identical payloads, different namespace. Matching only `image_generation.*` silently breaks every streamed edit.
- **Streaming partials are per-model too, on the 2.5 pair**: `gpt-image-2.5-flare` emits ZERO partial frames regardless of `partial_images` (only the `completed` event arrives, no overhead tokens); `sunburst` emits partials as expected (~77 output tokens each). Never build UI that assumes at least one partial arrives.
- Neither 2.5 model accepts **`input_fidelity`** — hard 400 ("Unknown parameter: 'input_fidelity'"), locked to high internally — never send it. `background: 'transparent'` and `input_fidelity` remain valid **schema** values so historical sidecars still parse; valid to parse ≠ valid to send.
- Streaming is **n=1 only**; upstream may send fewer partials than requested, never block on a fixed count.
- The upstream vendor proxy wraps 400-class validation errors in an **HTTP 503** — two shapes: the historical one with `"type": "..._user_error"` in the body, and the gpt-image-2.5-era one (`StatusCode: BadRequest`-prefixed, `"type":"invalid_request_error"`, **no** `user_error` substring at all). Never retry either; `upstream.ts`'s `isWrappedUserErrorBody()` recognizes both.
- **The painted-checkerboard failure mode** (live bug, still true on the 2.5 models): if the prompt text asks for "transparent background" while the request sends `background: "opaque"`, the model doesn't error — it paints a fake checkerboard into the opaque pixels. Always check `hasAlpha`/PNG colortype on output, never trust the image visually. The playbook rule is no longer a flat prohibition: prompt text must simply *match* the `background` parameter sent (transparent wording is correct when `background: "transparent"`, wrong otherwise).
- Cost (per generatable model, identical pricing between flare/sunburst): low ≈ $0.006/image, medium ≈ $0.013, high ≈ $0.053 (**~9× low**), xhigh ≈ $0.094, max ≈ $0.211 (**~35.8× low**) — why quality stays adjustable and previews default on. gpt-image-2's own `medium` anchor is now measured at 1756 tokens (was interpolated to 1173) — don't reuse any of these numbers for gpt-image-1.5 (~2.2× more expensive at the same tier).

## Validate

`make check` (no side effects; exits non-zero on failure) runs `bun run pre` then `bun test` — the full local gate. What it does not cover is the Tauri runtime; the last bullet below says exactly which parts.

- **`bun run pre`** = `format:check && lint && check:theme && check:sync && typecheck` — run it before proposing a commit. Plus `bun test` (438 tests). `check:theme` (`basalt-ui check-theme`, the palette + doctrine guard) and `check:sync` (`basalt-ui sync --check`, the managed-file drift gate) run through the LOCAL bin and are chained into `pre` so a basalt upgrade's guard promotions are reported locally, not first in CI (`.github/workflows/check.yml` runs the same two plus `doctor`); check-theme reads `basalt.roots` from the root `package.json`, which points at `app/src`; since 1.20 `bunx basalt-ui doctor` hard-fails when that resolves to zero files, so the two can no longer disagree. Every `theme-allow` must name its rule id — `theme-allow <rule-id> — <reason>`; a bare one warns (`theme-allow-unscoped`) and a first word naming no rule waives nothing. A comment-ONLY line directly above the finding is honoured, so a JSX child no longer has to be hoisted to a const to be annotatable.
- **oxlint + oxfmt**, matching the basalt-ui/argo ecosystem (never Biome/ESLint/Prettier). Root `.oxlintrc.json` **extends the shipped basalt preset** (`./node_modules/basalt-ui/configs/oxlint.json` — oxlint rejects bare specifiers, so the relative path is required), which brings the `basalt/*` design-guard rules. Style is basalt's: single quotes, no semicolons, printWidth 100.
- `basalt-ui` is **pinned to the published npm version** in both `package.json` (root, purely so lint can resolve that preset — bun doesn't hoist `app/`'s copy to root; same trick argo uses) and `app/package.json`. Keep the two in lockstep — never a `file:` link (`docs/concept.md` §9 has the incident). Upgrade via `/upgrade-deps`, then `./node_modules/.bin/basalt-ui sync` + `bun run pre` — the local bin, never `bunx`, which serves a cached copy that can answer for a different version than the one installed.
- **App-side unit tests exist and are substantial** — 438 tests total (86 shared / 133 gateway / **219 app**). What's still missing is a *component/integration* harness: pure logic (lib functions, stores, replay/lineage/roles) is well covered; anything touching the actual Tauri runtime (fs capabilities, `plugin-http`, canvas pointer math, the webview) is not exercised by any test. Say that precisely — don't claim "no app-side tests" (wrong) or imply green tests cover runtime behavior (also wrong).
- Consequently: anything touching the Tauri runtime is **unverified until someone runs the app on the MacBook** (`make app-run`). Say so plainly in reports rather than implying green typecheck+tests means working — a dot-glob fs-scope bug (below) shipped invisible to all of them and was fatal at first boot.
- Root `bun run typecheck` covers all workspaces — but **don't run it while another agent is mid-flight in a package you don't own**; you'll see their in-flight errors and "fix" phantoms. Scope it: `cd app && bunx tsc --noEmit -p tsconfig.app.json`.
- Driving the real app needs Rust + a GUI + a present human: that is the MacBook. The mini validates the gateway half (`bun test`, `make gateway-smoke`, `imgcli gen`).

## Deploy

The default branch is `master`. A push to `master` touching `gateway/**` or `shared/**` triggers `.github/workflows/deploy.yml`, which calls RollHook (OIDC) for a zero-downtime rolling update; the running container's `rollhook.allowed_repos=jkrumm/image-gateway` label is what authorizes it. `make deploy` aliases `gateway-deploy`: it refuses when `gateway/`/`shared/` is dirty or unpushed, dispatches the deploy workflow via `gh workflow run`, and waits for the rollout to succeed. RollHook tags images by git SHA and never moves `:latest`, so it builds exactly the merged commit. On a health-check failure during rollout RollHook auto-rolls-back to the previous container; to undo a change deliberately, revert it on `master` and push. The Mac app is not shipped by this pipeline — `make app` builds, installs and fingerprints it locally (see `## Local dev`).

## Verify & Monitor

- **Health URL (full):** `https://image-gateway.<your-domain>/health` — returns `{"status":"ok"}`, or `503 {"status":"draining"}` while draining. It is Tailscale-only (a grey-cloud A record to the VPS tailnet address), so it is unreachable off-tailnet; the hostname is a placeholder because this repo is public.
- **Uptime Kuma monitor:** `none` — no Kuma monitor is registered for this service. VPS health is covered by the container's own Docker healthcheck (`GET /health` every 10s) and the `make verify` probe below.
- **OTel `service.name`:** `none` — the gateway is not OpenTelemetry-instrumented. It emits single-line JSON logs and posts usage to argo's sink (`ARGO_USAGE_URL`), not OTLP.

`make verify` aliases `gateway-status`: it compares the running image's git-SHA tag against `HEAD` and probes `/health`, exiting non-zero on a mismatch, an unreadable image tag, or an unhealthy response. `make logs` aliases `gateway-logs-bounded`: the last 200 log lines, then exits.

## Gotchas

Each of these cost real debugging; they are verified in `node_modules`, not from memory.

- **Elysia response validation is skipped for generator returns.** The compiled gate is `if (res instanceof Response === false && typeof res?.next !== 'function' && !(res instanceof ReadableStream))`. It checks the **returned value**, not the handler's declaration — so a plain `async` handler that *returns* an async-generator still streams, while returning a plain object still gets validated. Keep handlers plain `async` and return the generator only for streaming; making the handler itself `async function*` silently disables validation on the JSON path too. Pinned by `gateway/src/lib/elysia-generator-validation.test.ts`.
- **Elysia returns `422`, not `400`, for request-schema violations.** Hand-rolled `400`s in the routes are *business-rule* checks (size/fidelity/mime) that zod can't express — don't add dead `400` slots for things the schema already covers.
- **Elysia multipart needs no `body` schema** — `type: "multipart/form-data"` in route options is OpenAPI metadata only; parsing is triggered by content-type sniffing when the handler destructures `body`.
- **Two different `capabilities.json` files.** `src-tauri/gen/schemas/capabilities.json` is the *schema of every possible permission* — grepping it proves nothing. The **granted** set is `src-tauri/target/debug/build/image-gen-*/out/capabilities.json` (newest by mtime). Verify there.
- **zod v4 keeps `.shape` through `.superRefine()`** — object schemas with refinements still expose `.shape.field`, so `metadata.ts`'s "reuse the contract's field schemas" pattern survives.
- **`tauri-plugin-fs` defaults to `require_literal_leading_dot: true` on unix** — verified in `tauri-plugin-fs-2.5.1/src/commands.rs:1559` (`.unwrap_or(cfg!(unix))`). Consequence: a glob like `$PICTURE/ImageGen/**` **cannot match** anything under `.imagegen/...` — glob's leading-dot exclusion applies even mid-path. Every dot-prefixed directory needs its own explicit scope entries — both `$PICTURE/ImageGen/.imagegen` *and* `$PICTURE/ImageGen/.imagegen/**` — on every fs permission that touches it. This shipped broken once: the whole `.imagegen/` state dir (drafts, projects, styles) threw `forbidden path` on first boot, making draft persistence structurally impossible until `app/src-tauri/capabilities/default.json` was fixed.

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
