# Verification: Upstream Endpoint Supports gpt-image-2 (2026-07-16)

Live probe of the unified OpenAI-compatible LLM endpoint (base URL and key resolve from 1Password: `op://common/anthropic/OPENAI_BASE_URL` + `op://common/anthropic/API_KEY`; the OpenAI transport lives under the `/openai/v1` path).

## Result: fully working

`POST /images/generations` with `{"model": "gpt-image-2", "prompt": "a red circle", "size": "1024x1024", "quality": "low", "n": 1}` returned **HTTP 200** with:

```
{ created, background: "opaque", data: [{ b64_json: <PNG> }],
  output_format: "png", quality: "low", size: "1024x1024",
  usage: { input_tokens: 9, output_tokens: 196, total_tokens: 205,
           input_tokens_details, output_tokens_details } }
```

`quality` and `size` accepted as-is; token-level usage detail is present, so per-generation cost telemetry is straightforward.

## Image-capable models in the catalog (287 total)

- OpenAI: `gpt-image-2`, `gpt-image-2-2026-04-21`, `gpt-image-1.5`, `gpt-image-1`, `gpt-image-1-mini`, `dall-e-3`
- Google: `gemini-3-pro-image(-preview)`, `gemini-3.1-flash-image(-preview)`, `gemini-3.1-flash-lite-image`, `gemini-2.5-flash-image`, `nano-banana`, `nano-banana-2`, `nano-banana-pro`

Transparency-capable fallback (`gpt-image-1.5`) and cheap tier (`gpt-image-1-mini`) are both available, as are Gemini image models as future alternates.

## Prior art to reuse

`sideclaw/server/lib/iu-openai.ts` already implements `generateImage()` against this endpoint: POSTs `/images/generations` (default model `gpt-image-2`), validates PNG magic bytes, normalizes usage, logs to the usage-tracker NDJSON sink, and fails fast on 410 (retired model) naming the current gpt-image lineup. Reuse these patterns (retry set, 410 handling, magic-byte check, usage sink) in the gateway.

## Round 2 — capability probe (2026-07-16)

Everything previously listed as "still unverified" is now settled by live probe, and **four claims from public documentation turned out to be false for this endpoint**. Probe results below are ground truth; prefer them over any vendor doc or blog.

| Probe | Result | Verdict |
|-|-|-|
| `gpt-image-2` + `background: transparent` | 503-wrapped 400 `"Transparent background is not supported for this model."` | Unsupported — permanent |
| `gpt-image-1.5` + `background: transparent` | 200, `background: "transparent"` | **Fallback works** — routing is load-bearing |
| `/images/edits` + `gpt-image-2` (multipart) | 200 | **openai-node#1844 is fixed** — no Responses API detour needed |
| `/images/edits` + `image[]` ×2 refs | 200 | Multi-image references work |
| `/images/edits` + `gpt-image-2` + `size: 1536x896` / `2560x1440` | 200, echoes the size | **Custom sizes work on edits** — docs claiming presets-only are wrong |
| `/images/edits` + `gpt-image-1.5` + `size: 1536x896` | 400 `"Supported sizes are 1024x1024, 1024x1536, 1536x1024, and auto"` | Size rule is per-**model**, not per-endpoint |
| `/images/edits` + `gpt-image-2` + `input_fidelity: high` | 400 `"The model 'gpt-image-2' does not support the 'input_fidelity' parameter."` | Must not be forwarded for gpt-image-2 |
| `/images/edits` + `gpt-image-1.5` + `input_fidelity: high` | 200 | Valid for 1.5 |
| `/images/generations` + `input_fidelity` (any model) | 400 `"Unknown parameter"` | Edits-only parameter |
| `n: 2` on gpt-image-2 / 1.5 / -mini | 200, 2 images each | **All three support n > 1** — "1.5 is effectively n=1" is wrong |
| `/responses` + `image_generation` tool | 200 | Proxied — available for multi-turn, not required for edits |
| `stream: true` + `partial_images: 2` | 200 `text/event-stream`; `image_generation.partial_image`, `image_generation.completed` | Streaming passes through |
| `stream: true` on `/images/edits` | 200 `text/event-stream`; **`image_edit.partial_image`, `image_edit.completed`** | Streaming works on edits too — but under a **different event namespace** |
| `stream: true` + `n: 2` | 400 `"Streaming is only supported with n=1."` | Streaming implies a single image |

### SSE event names are per-endpoint (the one thing that is NOT per-model)

`/images/generations` emits `image_generation.*`; `/images/edits` emits `image_edit.*`. **Payloads are identical** — only the namespace differs. This is the sole exception to the per-model rule, and it is easy to get wrong by generalizing from the generations probe: matching only `image_generation.*` makes every streamed edit terminate with "no completed event". `gateway/src/lib/streaming.ts` matches on the event suffix and has a regression test.

Frame shapes (b64 elided):

```
event: image_generation.partial_image
data: {"created_at":…,"type":"image_generation.partial_image","b64_json":"…","background":"opaque",
       "output_format":"png","partial_image_index":0,"quality":"low","sequence_number":0,"size":"1024x1024"}

event: image_generation.completed
data: {"created_at":…,"type":"image_generation.completed","b64_json":"…","background":"opaque",
       "output_format":"png","quality":"low","sequence_number":1,"size":"1024x1024","usage":{…}}
```

The **final image and `usage` arrive inside the `completed` frame** — a streamed request has no separate response body. There is no image-index field (streaming is n=1 only). Upstream may send **fewer partials than requested** when generation is fast — never block waiting for a fixed count.

### Corrections to the July 2026 desk research (`image-api.md`, since deleted — these are the surviving facts)

1. `/images/edits` is **not** broken for GPT Image models anymore.
2. Custom resolutions are **not** restricted to `/images/generations`; they work on `/images/edits` too, for gpt-image-2.
3. `n` is **not** effectively 1 for gpt-image-1.5 / gpt-image-1-mini.
4. `input_fidelity` is not merely "disabled" on gpt-image-2 — sending it is a hard 400.

### Error-shape note

The vendor proxy returns **HTTP 503** for upstream 400-class validation failures, with the real status in the body (`[OpenAI Vendor Group Key StatusCode: BadRequest]`) and `"type": "image_generation_user_error"`. Retrying these is pointless — `upstream.ts` detects `user_error` and fails fast.

## Round 3 — moderation probe (2026-07-17)

Wave-0 probes for the studio redesign (`PRD.md`). All against our own upstream, gpt-image-2 unless noted, quality low.

1. **`moderation=low` is accepted on `/images/edits`** by both gpt-image-2 and gpt-image-1.5 (200). The historical gpt-image-1 "unsupported on edits" limitation does not apply here.
2. **`moderation_details` exists and passes through.** A blocked request returns the usual 503-wrapped string; the embedded JSON contains `code: "moderation_blocked"`, `type: "image_generation_user_error"`, and `moderation_details: { moderation_stage: "input"|"output", categories: ["other"] }`. The 503 body is a **string with a `[OpenAI Vendor Group Key StatusCode: BadRequest] ` prefix before the JSON** — extract the JSON substring; do not parse the body directly. Categories observed so far are coarse (`"other"`).
3. **Our upstream is more permissive than the public OpenAI API reports suggest.** A photorealistic named-celebrity portrait generated fine (200) — public reports call this a reliable block. A living-artist style prompt blocked at **input** stage; a franchise character (Mickey Mouse) passed input, generated, and blocked at **output** stage. Calibration consequence: the enhancer pre-check is *advisory* — it predicts public-API behavior, our endpoint may allow more; warn, don't hard-refuse, except for genuine policy hard walls.
4. **Quirk: `/images/edits` with `size: "auto"` returned `1254x1254`** from a 1024×1024 input+mask (gpt-image-2) — a non-preset size that is not even a multiple of 16, and it does *not* match the input dimensions. Reproduced in a real app run 2026-07-19 (`~/Pictures/ImageGen/2026-07-19_13-45-43_vmow`): the Edit view defaults to `sizeChoice: 'auto'` and the gateway forwards `"auto"` verbatim — it does **not** inject a concrete size — so the odd size reaches disk. The inpaint still aligned correctly (upstream maps the mask onto its own chosen output), so this is cosmetic for the single edit but a hazard downstream (next point).
5. **`size` recorded from an `auto` edit is truthful but NOT replayable.** `gateway/src/lib/response.ts` records `upstream.size ?? requestedSize`, so the sidecar's `params.size` is the *actual* returned dimensions. Re-sending `1254x1254` as a request 400s: `503 [OpenAI Vendor Group Key StatusCode: BadRequest] "Invalid size '1254x1254'. Width and height must both be divisible by 16."` (probed 2026-07-19). **Consequence for Wave-1 G4:** Re-run (verbatim) / Promote must snap `params.size` through `rules.ts` (or fall back to `"auto"`) before replay — replaying a recorded auto-edit size verbatim will fail. The clean fix is for the app to derive a concrete divisible-by-16 size for edits instead of sending `"auto"`.

## Round 4 — per-model capability and cost tables (moved here from CLAUDE.md, now AGENTS.md, still 2026-07-16 measurements)

`MODEL_CAPABILITIES` in `shared/src/contract.ts` is the single source of truth these tables describe; `AGENTS.md` keeps only the operating gotchas, not the numbers.

- **Capabilities are per-model, not per-endpoint.** Each fact below holds identically on `/images/generations` and `/images/edits`.
- gpt-image-2 accepts **arbitrary `WxH`** (multiples of 16, ratio ≤ 3:1, 655,360–8,294,400 px, max edge < 3840) on **both** endpoints, including 2560×1440 — so custom sizes are always available in the studio. *(Historical: `gpt-image-1.5`/`-mini` are presets-only on both. `snapSizeForModel(model: KnownImageModel, size)` is the replay chokepoint and snaps legacy-model sizes into gpt-image-2's envelope.)*
- gpt-image-2 rejects **`input_fidelity`** outright ("does not support the parameter") — it is locked to high internally, so never send it. It is an *edits-only* parameter; `/images/generations` rejects it as unknown for every model. *(Historical: `gpt-image-1.5` accepts it — that's why old sidecars carry it.)*
- *Historical:* gpt-image-1.5 **does** support transparent backgrounds. This is why 6 of the 9 sidecars on disk carry `background: transparent`, and why the read path must keep accepting that value forever.
- `/v1/images/edits` **works** with gpt-image-2 (multipart, `image[]` for multiple refs). The old openai-node#1844 400 bug is fixed — the Responses API detour is no longer needed (it is proxied and works, but only earns its keep for multi-turn).
- Streaming passes through on **both** endpoints, and is **n=1 only** ("Streaming is only supported with n=1"). SSE event names are the one per-endpoint exception (see Round 2 above). The final image *and* `usage` arrive inside the `completed` frame; upstream may send fewer partials than requested.
- `n` up to 10 works on **all three** models (write-ups claiming 1.5/mini are limited to n=1 are wrong here).
- GPT Image models always return `b64_json`; usage tokens are in every response (surface cost per generation).

### The painted-checkerboard failure mode (live bug, both models)

If the prompt text asks for "isolated on a transparent background" but the request actually sends `background: "opaque"`, the model doesn't error — it **paints a fake transparency checkerboard into the opaque pixels**. Verified on both gpt-image-2 and gpt-image-1.5: output had `hasAlpha: no`, PNG colortype 2 (RGB), with a visible checkerboard baked in. Prompt text and the `background` parameter can silently disagree and produce garbage that *looks* transparent at a glance. This also means any future background-removal/matting step would inherit painted checkerboard pixels rather than real alpha — always check `hasAlpha`/colortype on output rather than trusting the image visually. Now that every request is `opaque`, the playbook rule "never write 'transparent background' into prompt text" is a flat prohibition and is load-bearing, not cosmetic — there is no longer any request shape in which those words are correct.

### Cost shape (measured 2026-07-16, gpt-image-2 @ 1024×1024)

Drives the UX defaults — don't re-litigate these from intuition. **These anchors are gpt-image-2-specific, not universal** — cost scales per model, not just per quality/size. Measured on gpt-image-1.5 at `low`/1024²: ~429 output tokens/image, ~2.2× the gpt-image-2 anchor below — applying the gpt-image-2 numbers to gpt-image-1.5 under-quotes by ~2.2×. (`shared/src/cost.ts` owns the anchor constants; treat any single cross-model anchor there as a bug.)

| | output tokens | ~USD | note |
|-|-|-|-|
| `quality: low` | 196 | $0.006 | drafting tier |
| `quality: high` | 7,024 | $0.211 | **35.8× low** — why quality stays adjustable |
| streaming overhead | **+77 flat** | +$0.002 | +39% on low, **+1% on high** — why previews default ON |

Streaming overhead is flat per request, not per partial: asking for 3 partials delivered **1** (upstream skips them when generation is fast). Never build UI that waits for a fixed partial count.

**Measured cross-model comparison** (same prompt, `low`, `n=4`, 1024×1024): gpt-image-2 opaque = **$0.02625**; gpt-image-1.5 transparent = **$0.057764**. gpt-image-2 is ~2.2× cheaper for the equivalent job — a real factor in the opaque-vs-transparent routing decision, not just a token-count curiosity.

## Round 5 — gpt-image-2.5-flare / gpt-image-2.5-sunburst migration (2026-09-23)

Live-probed against our IU upstream the day the generate path moved off `gpt-image-2`. `gpt-image-2` itself was also re-measured (its `medium` anchor). Both new models use the **undated alias ids** (`gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`), not the `-2026-09-08` dated snapshots.

| Fact | `gpt-image-2.5-flare` | `gpt-image-2.5-sunburst` |
|-|-|-|
| Positioning (OpenAI docs) | speed-optimized "fast high-quality everyday" model, up to ~50% lower latency than gpt-image-2 | quality-optimized, best for editing precision / reference preservation, slower |
| Measured latency @ 1024² | low 7–20s, high 20s | low 9–13s, high 32s |
| Pricing (USD/1M) | text_in 5.0, cached text_in 1.25, image_in 8.0, cached image_in 2.0, out 30.0 | identical |
| Output tokens @ 1024×1024 | low 196, medium 439, high 1756, xhigh 3122, max 7024 (all measured) | same at low/medium/high (measured); xhigh/max assumed to match given token-identical pricing |
| Quality values | `low\|medium\|high\|xhigh\|max\|auto` all accepted 200 — the upstream's own error text for an invalid value lists only low/medium/high/auto; that error text is **stale**, xhigh/max work | same |
| `background: "transparent"` + png | 200, real RGBA (colortype 6), ~35–43% alpha=0, clean cutout; subject alpha ~252–253, not a full 255 | same |
| `input_fidelity` | hard 400 `"Unknown parameter: 'input_fidelity'"` | same |
| Custom sizes | 1536×640 and 3072×1024 accepted (same envelope as gpt-image-2) | same |
| `output_format: webp` + `output_compression` | accepted | accepted |
| `n=2` | accepted | accepted |
| `moderation: low` | accepted | accepted |
| Streaming generations (`partial_images: 2`) | 200, but emits **only** `image_generation.completed` — zero partials, zero streaming-overhead tokens | emits `image_generation.partial_image` ×2 then `completed`; +153 output tokens for 2 partials (≈77/partial) |
| Streaming edits | `image_edit.completed` only | `image_edit.partial_image` + `image_edit.completed` |
| Edits (`/images/edits`, 1 ref image) | 200; input = 1024 image tokens + text | 200, same |
| Response shape | adds a per-image `data[].generation_id` field (harmless — ignored or tolerated) | same |
| Error shape (invalid params) | HTTP 503, body `[OpenAI Vendor Group Key StatusCode: BadRequest] {"error":{"type":"invalid_request_error",...}}` — **no** `user_error` substring anywhere | same |

Also measured: **`gpt-image-2` at `quality: medium` @ 1024² = 1756 output tokens** — `shared/src/cost.ts` previously interpolated this as the geometric mean of low/high (1173); the measured value replaces it.

**Consequences**, all landed the same day:

- `IMAGE_MODELS` (generate path) = `['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']`; `gpt-image-2` joins `gpt-image-1.5`/`-1-mini` as read-path-only in `KNOWN_IMAGE_MODELS`.
- `MODEL_CAPABILITIES` gains `extendedQuality` (true for both 2.5 models, false for every legacy model) — validated by `validateQualityForModel` alongside the existing background/size/fidelity checks.
- `resolveModel`/`routingReason` (`shared/src/rules.ts`) route `model: 'auto'` by endpoint + quality: an edit → sunburst; a generate at `high`/`xhigh`/`max` → sunburst; a generate at `low`/`medium`/`auto` → flare.
- `validateBackgroundForModel()` now **passes** for both generatable models; a new `validateTransparentOutputFormat()` rejects `transparent` + `jpeg` (no alpha channel there) instead.
- `gateway/src/lib/upstream.ts`'s non-retry check (`isWrappedUserErrorBody`) recognizes both 503-wrapping shapes — the historical `user_error`-substring one and this round's `StatusCode: BadRequest` / `invalid_request_error` one, which contains no `user_error` substring at all and would otherwise burn 3 retries before failing.
- `gpt-6-luna` text pricing (OpenAI's official pricing page, short-context tier — not a live probe against our own endpoint) was added to `gateway/src/lib/pricing.ts`'s `TEXT_RATES` alongside the still-measured `gpt-5.6-luna` row.

---

## 2026-10-13 — Replicate background removal (via IU /replicate/v1)

Live-probed through the same IU proxy and key as the OpenAI upstream. The Replicate route sits beside `/openai/v1`: the base is `OPENAI_BASE_URL` with the trailing `/openai/v1` swapped for `/replicate/v1`, authenticated with `Authorization: Bearer <OPENAI_API_KEY>`. Implemented in `gateway/src/lib/replicate.ts`; consumed by `POST /cutout` and `POST /icons`.

**Call shape.** Two OFFICIAL models, callable without a version hash: `POST {base}/models/{owner}/{name}/predictions` with body `{ "input": { "image": "data:image/png;base64,..." } }` and header `Prefer: wait`. Both returned inside the wait window (3.9-10s). If the status is still `starting`/`processing`, poll `GET {base}/predictions/{id}` — the flat path, not the public-host URL in `urls.get` — about once a second. On `succeeded`, `output` is a single URL string on `replicate.delivery`; any other host is refused. **The delivered format differs per model**: bria delivers PNG, recraft delivers **RGBA WebP** (found by the first live pipeline run — mocked tests had assumed PNG); `lib/replicate.ts` normalizes WebP to PNG.

| Fact | `recraft-ai/recraft-remove-background` | `bria/remove-background` |
|-|-|-|
| Input | `image` only | `image` (or `image_url`) plus `preserve_alpha` (default true) |
| Price | $0.01/run | $0.018/run |
| Resolution | preserves input resolution | quirk: downscaled a 1254px input to 1024px |
| Limits | <=5 MB, <=16 MP, sides 256-4096 px | not probed |
| Output | RGBA **WebP**, near-binary matte with a thin soft edge, no halo on illustrated content | RGBA PNG, same matte quality |
| Quirk | on one test the "transparent" background came back **alpha=1, not 0** | none observed |

Consequences: recraft is the default (cheaper, faster, keeps resolution, tuned for AI-generated content); `/icons` zeroes alpha < 8 before trimming so recraft's alpha=1 background cannot survive into the trim box.

**ICNS container** (verified by hexdumping a system .icns): 4-byte magic `icns` + big-endian u32 total file length, then chunks of 4-byte OSType + big-endian u32 chunk length (including the 8-byte chunk header) + raw PNG bytes. PNG OSTypes: `icp4`=16, `icp5`=32, `ic11`=32 (16@2x), `ic12`=64 (32@2x), `ic07`=128, `ic13`=256 (128@2x), `ic08`=256, `ic14`=512 (256@2x), `ic09`=512, `ic10`=1024 (512@2x). The higher codes (ic09-ic14) are from secondary sources; `icon-containers.test.ts` writes the file and round-trips it through `iconutil -c iconset` (macOS only), confirming all 10 iconset files at the expected pixel sizes.

**ICO with PNG frames**: little-endian ICONDIR (reserved u16=0, type u16=1, count u16), N x 16-byte ICONDIRENTRY (width u8, height u8 [0 means 256], colorCount u8=0, reserved u8=0, planes u16=1, bitCount u16=32, bytesInRes u32, imageOffset u32), then the PNG bytes verbatim. Frames 16, 32, 48.

### Upscale and vectorize for `/icons` (probed 2026-10-13, same proxy and key)

recraft's cutout and vectorize both reject inputs under 256 px, so small masters must be upscaled first. Same call shape as above (`POST {base}/models/{owner}/{name}/predictions`, `Prefer: wait`, official models, no version hash).

| Fact | `nightmareai/real-esrgan` | `recraft-ai/recraft-crisp-upscale` | `recraft-ai/recraft-vectorize` |
|-|-|-|-|
| Input | `image` (data URI), `scale` (0-10, default 4), `face_enhance: false` | `image` | `image` only |
| Price | $0.002/run | not costed (rejected) | $0.01/run |
| Latency | 2-10 s | - | ~8 s |
| Limits | max recommended input ~1440p | - | <=5 MB, <=16 MP, sides 256-4096 px (same as the recraft cutout) |
| Output | **RGBA PNG, alpha preserved** (128px RGBA in -> 512px RGBA out, transparent area intact) | **flattens transparency to white, returns RGB WebP** | one URL to an `.svg` on replicate.delivery |
| Verdict | used (`UPSCALE_MODEL`) | **rejected** - destroys the alpha channel | used (`VECTORIZE_MODEL`) |

**Vectorize output shape.** The root looks like `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" style="display: block;" viewBox="0 0 2048 2048" width="1254" height="1254" preserveAspectRatio="none">`, followed by `<path transform="translate(0,0)" fill="rgb(...)" d="..."/>` elements. There is **no background path** and transparency is kept. The fixed `width`/`height`/`style`/`preserveAspectRatio` and the no-op `translate(0,0)` are stripped before svgo (`viewBox` is kept so the icon scales).

**Size depends entirely on the art.** A flat leaf icon came back as 2 paths, 3.5 KB. A lighthouse with a soft light beam came back as 66 paths, 61 KB, with the beam turned into stepped bands. Hence the 64 KB `SVG_MAX_BYTES` cap in `/icons`: gradient or photographic art does not vectorize into a good favicon, and since browsers prefer an SVG icon over the raster ones, an oversized SVG is omitted rather than shipped.
