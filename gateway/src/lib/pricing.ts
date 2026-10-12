import type { Cost, KnownImageModel, Usage } from '@image-gateway/shared'

interface Rate {
  text_in: number
  image_in: number
  out: number
  /** USD per 1M cache-read tokens. Only text (chat-completions) models expose this; omitted means no cache discount. */
  cached_in?: number
}

/**
 * USD per 1M tokens (OpenAI direct pricing; gpt-image-2.5-flare/sunburst
 * measured live against our IU upstream 2026-09-23, the rest mid-2026 — re-verify
 * against the vendor page before trusting an older number here).
 *
 * Keyed by `KnownImageModel`, not `ImageModel`: pricing is applied to usage
 * *records*, which are historical. Generation runs on the 2.5 pair today, but
 * the library still holds sidecars produced on gpt-image-2 / -1.5 /
 * -1-mini, and `computeCost` is what puts a number next to them. Dropping a
 * retired model's rate here would silently turn every one of those into
 * `{ usd: null, source: 'none' }`. Never shrink this map.
 */
const RATES: Record<KnownImageModel, Rate> = {
  'gpt-image-2': { text_in: 5.0, image_in: 8.0, out: 30.0 },
  'gpt-image-1.5': { text_in: 5.0, image_in: 8.0, out: 32.0 },
  'gpt-image-1-mini': { text_in: 2.0, image_in: 2.5, out: 8.0 },
  // Identical pricing for flare and sunburst (probe-verified 2026-09-23) — the
  // two models trade latency, not token price. No cached image-input rate:
  // the image endpoints don't report cached tokens today, so text/image/out
  // is the whole shape.
  'gpt-image-2.5-flare': { text_in: 5.0, image_in: 8.0, out: 30.0 },
  'gpt-image-2.5-sunburst': { text_in: 5.0, image_in: 8.0, out: 30.0 },
}

/**
 * USD per 1M tokens for the *text* models this gateway calls — today only the
 * `/enhance` planner (`ENHANCE_MODEL`). Separate from `RATES` because these are
 * not image models: they never emit `input_tokens_details`, and they must never
 * leak into `IMAGE_MODELS`.
 *
 * Without an entry here `computeCost` returned `{ usd: null }` for every plan,
 * which argo renders as $0 — that silently hid ~76% of this service's token
 * volume until 2026-07-24.
 *
 * `gpt-5.6` is an **alias**, not a model: `/v1/models` on our endpoint lists only
 * `-sol`/`-terra`/`-luna`, and a live probe (2026-07-24) showed a request for
 * `gpt-5.6` comes back with `"model": "gpt-5.6-sol"` — so it is priced at sol's
 * rate. Vendor docs claim no bare `gpt-5.6` exists at all; the endpoint disagrees.
 * If the planner's cost ever looks off by an integer factor, re-probe first — the
 * alias could be re-pointed at another tier without notice.
 *
 * Rates below are measured 2026-09-13 against the IU unified endpoint's own
 * `usage.cost`, USD per 1M tokens, superseding the earlier vendor-page-derived
 * figures (`gpt-5.6-luna` was wrongly $1/$6; `deepseek-v4.1-flash` was wrongly
 * $0.30/$1.20 with no cached rate) — see
 * modelpick/docs/decisions/model-configs.md. `glm-5.3-flash` is not
 * `ENHANCE_MODEL` today but priced here so a future switch (or a historical
 * row) doesn't silently report `usd: null`.
 *
 * `gpt-6-luna` is priced from the OpenAI official pricing page (short-context
 * tier), not a live probe against our own endpoint — added 2026-09-23
 * alongside the image-model migration, kept separate from (and not replacing)
 * the still-measured `gpt-5.6-luna` row above; re-verify against a live probe
 * before trusting it the way the rows above are trusted.
 */
const TEXT_RATES: Record<string, Rate> = {
  'gpt-5.6': { text_in: 5.0, image_in: 5.0, out: 30.0 },
  'gpt-5.6-sol': { text_in: 5.0, image_in: 5.0, out: 30.0 },
  'gpt-5.6-terra': { text_in: 2.5, image_in: 2.5, out: 15.0 },
  'gpt-5.6-luna': { text_in: 0.2, image_in: 0.2, out: 1.2, cached_in: 0.02 },
  'gpt-6-luna': { text_in: 0.1, image_in: 0.1, out: 0.5, cached_in: 0.01 },
  'deepseek-v4.1-flash': { text_in: 0.5, image_in: 0.5, out: 1.5, cached_in: 0.05 },
  'glm-5.3-flash': { text_in: 0.15, image_in: 0.15, out: 0.5, cached_in: 0.03 },
}

/**
 * Price one generation's usage. Uses `input_tokens_details` (text/image split)
 * when present; otherwise treats the whole input as text tokens. Cache-read
 * tokens (`input_tokens_details.cached_tokens`) are a *subset* of the text
 * tokens already counted in `input_tokens`/`text_tokens` — they're split out
 * and priced at `rate.cached_in`, falling back to the full text rate for a
 * model with no cached rate. Unknown models return `{ usd: null, source: 'none' }`.
 */
export function computeCost(model: string, usage: Usage): Cost {
  const rate = (RATES as Record<string, Rate | undefined>)[model] ?? TEXT_RATES[model]
  if (!rate) return { usd: null, source: 'none' }

  const details = usage.input_tokens_details
  const textTokens = details?.text_tokens ?? usage.input_tokens
  const imageTokens = details?.image_tokens ?? 0
  const cachedTokens = Math.min(details?.cached_tokens ?? 0, textTokens)
  const uncachedTextTokens = textTokens - cachedTokens

  const inputCost =
    (uncachedTextTokens / 1_000_000) * rate.text_in +
    (cachedTokens / 1_000_000) * (rate.cached_in ?? rate.text_in) +
    (imageTokens / 1_000_000) * rate.image_in
  const outputCost = (usage.output_tokens / 1_000_000) * rate.out

  return { usd: inputCost + outputCost, source: 'computed' }
}
