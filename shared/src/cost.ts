import type { KnownImageModel } from './contract.js'

/**
 * USD per 1M output tokens per model (OpenAI-direct pricing). This module estimates a cost
 * *before* a run exists, from the measured anchors below; the live cost of a finished run
 * comes back in the door's response.
 *
 * Keyed by `KnownImageModel`, not `ImageModel`: historical generations on a
 * retired model still need a cost estimate/display in the library.
 */
const OUTPUT_RATE_PER_MILLION_TOKENS: Record<KnownImageModel, number> = {
  'gpt-image-2': 30.0,
  'gpt-image-1.5': 32.0,
  'gpt-image-1-mini': 8.0,
  'gpt-image-2.5-flare': 30.0,
  'gpt-image-2.5-sunburst': 30.0,
}

const BASE_PIXELS = 1024 * 1024

/**
 * Output-token anchors measured at 1024x1024, per model — token output is
 * per-model, not a shared constant, so each model gets its own anchor set.
 *
 * gpt-image-2.5-flare/sunburst: all five anchors measured directly 2026-09-23
 * (see docs/research/endpoint-verification.md) — `low`/`medium`/`high`
 * measured on flare and confirmed matching on sunburst; `xhigh`/`max`
 * measured on flare and assumed to match (same token-identical pricing and
 * measured low/medium/high parity).
 *
 * gpt-image-2 (retired from generate, kept for historical sidecars): `low`
 * and `high` measured directly, `medium` measured directly at 1756 (2026-09-23
 * probe — supersedes an earlier interpolated 1173 that this file used before
 * the measurement existed). No `xhigh`/`max` anchors exist for it — it never
 * accepted those values, so callers requesting them fall back to `high`.
 *
 * gpt-image-1.5: `low` (429) is measured — 4 images, 1717 total output
 * tokens at 1024x1024. `medium`/`high` are EXTRAPOLATED by scaling the
 * gpt-image-2 anchors by the measured low-ratio (429/196 ≈ 2.19); no direct
 * measurement exists for either, and it has no `xhigh`/`max` anchors either.
 *
 * gpt-image-1-mini: no measurements exist at all. Reuses the gpt-image-2
 * anchors as unmeasured placeholders.
 */
const GPT_IMAGE_2_5_ANCHORS = {
  low: 196,
  medium: 439,
  high: 1756,
  xhigh: 3122,
  max: 7024,
}

const GPT_IMAGE_2_ANCHORS = {
  low: 196,
  medium: 1756,
  high: 7024,
  // gpt-image-2 never accepted xhigh/max — estimateCost falls back to `high` for it (see below).
  xhigh: 7024,
  max: 7024,
}

const GPT_IMAGE_1_5_LOW_RATIO = 429 / 196

const OUTPUT_TOKENS_AT_BASE_SIZE: Record<
  KnownImageModel,
  Record<'low' | 'medium' | 'high' | 'xhigh' | 'max', number>
> = {
  'gpt-image-2': GPT_IMAGE_2_ANCHORS,
  'gpt-image-1.5': {
    low: 429,
    medium: Math.round(GPT_IMAGE_2_ANCHORS.medium * GPT_IMAGE_1_5_LOW_RATIO),
    high: Math.round(GPT_IMAGE_2_ANCHORS.high * GPT_IMAGE_1_5_LOW_RATIO),
    xhigh: Math.round(GPT_IMAGE_2_ANCHORS.high * GPT_IMAGE_1_5_LOW_RATIO),
    max: Math.round(GPT_IMAGE_2_ANCHORS.high * GPT_IMAGE_1_5_LOW_RATIO),
  },
  'gpt-image-1-mini': GPT_IMAGE_2_ANCHORS,
  'gpt-image-2.5-flare': GPT_IMAGE_2_5_ANCHORS,
  'gpt-image-2.5-sunburst': GPT_IMAGE_2_5_ANCHORS,
}

/**
 * Streaming-preview overhead (measured 2026-09-23), independent of
 * size/quality/n but very much per-model this time: flare emits ZERO partial
 * frames regardless of `partial_images` (measured — only the `completed`
 * event arrives), so its overhead is 0. sunburst and the legacy models emit
 * partials and pay ~77 output tokens each; `estimateCost` treats this as a
 * flat per-request add rather than per-partial (matching the flat-overhead
 * fact this file's callers have always assumed) — the true per-partial
 * relationship is `docs/research/endpoint-verification.md`'s concern, not a
 * pre-run estimator's.
 */
const STREAMING_OVERHEAD_TOKENS: Record<KnownImageModel, number> = {
  'gpt-image-2': 77,
  'gpt-image-1.5': 77,
  'gpt-image-1-mini': 77,
  'gpt-image-2.5-flare': 0,
  'gpt-image-2.5-sunburst': 77,
}

/**
 * Parses a `WxH` size string into a pixel count. `auto` and unparsable sizes
 * fall back to the 1024x1024 base the anchors were measured at.
 */
export function sizeToPixels(size: string): number {
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(size)
  if (!match) return BASE_PIXELS
  return Number(match[1]) * Number(match[2])
}

export interface EstimateCostInput {
  model: KnownImageModel
  /** `auto` is treated as `high` — estimate the expensive case rather than under-quote. */
  quality: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto'
  size: string
  streaming: boolean
  n: number
}

export interface EstimatedCost {
  per_image_usd: number
  total_usd: number
}

/**
 * Estimates image-generation cost before a run, from the per-model anchors
 * above — see `shared/playbook/settings.md`'s quality ladder. Scales output
 * tokens linearly with pixel count relative to the 1024x1024 anchor.
 * Linear-in-pixels is an approximation, not an exact law (a measured
 * gpt-image-1.5 data point at 1.5x base pixels came in above the linear
 * prediction) — good enough for a pre-run estimate, not a guarantee.
 */
export function estimateCost(input: EstimateCostInput): EstimatedCost {
  const quality = input.quality === 'auto' ? 'high' : input.quality
  const pixelScale = sizeToPixels(input.size) / BASE_PIXELS
  const outputTokens =
    OUTPUT_TOKENS_AT_BASE_SIZE[input.model][quality] * pixelScale +
    (input.streaming ? STREAMING_OVERHEAD_TOKENS[input.model] : 0)
  const perImageUsd = (outputTokens / 1_000_000) * OUTPUT_RATE_PER_MILLION_TOKENS[input.model]
  return { per_image_usd: perImageUsd, total_usd: perImageUsd * input.n }
}
