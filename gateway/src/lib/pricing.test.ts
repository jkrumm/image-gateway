import { describe, expect, test } from 'bun:test'
import { computeCost } from './pricing.js'
import type { Usage } from '@image-gateway/shared'

describe('computeCost', () => {
  test('uses input_tokens_details text/image split when present', () => {
    const usage: Usage = {
      input_tokens: 1000,
      output_tokens: 2000,
      total_tokens: 3000,
      input_tokens_details: { text_tokens: 600, image_tokens: 400 },
    }
    const cost = computeCost('gpt-image-2', usage)
    // (600/1e6 * 5.00) + (400/1e6 * 8.00) + (2000/1e6 * 30.00)
    const expected = (600 / 1_000_000) * 5.0 + (400 / 1_000_000) * 8.0 + (2000 / 1_000_000) * 30.0
    expect(cost.source).toBe('computed')
    expect(cost.usd).toBeCloseTo(expected, 10)
  })

  test('falls back to treating all input as text when details are missing', () => {
    const usage: Usage = { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 }
    const cost = computeCost('gpt-image-1-mini', usage)
    const expected = (1000 / 1_000_000) * 2.0 + (500 / 1_000_000) * 8.0
    expect(cost.source).toBe('computed')
    expect(cost.usd).toBeCloseTo(expected, 10)
  })

  test('gpt-image-1.5 uses its own output rate', () => {
    const usage: Usage = { input_tokens: 0, output_tokens: 1_000_000, total_tokens: 1_000_000 }
    const cost = computeCost('gpt-image-1.5', usage)
    expect(cost.usd).toBeCloseTo(32.0, 10)
  })

  /**
   * Regression guard for the read/generate split: gpt-image-1.5 and
   * gpt-image-1-mini are no longer generatable, but the library is full of
   * sidecars recorded against them. If `RATES` is ever narrowed from
   * `KnownImageModel` to `ImageModel`, those all silently lose their price
   * (`source: 'none'`) instead of failing loudly — so assert every retired
   * model still prices.
   */
  test('retired models still price — usage records are historical', () => {
    const usage: Usage = { input_tokens: 1000, output_tokens: 2000, total_tokens: 3000 }
    for (const model of ['gpt-image-1.5', 'gpt-image-1-mini'] as const) {
      const cost = computeCost(model, usage)
      expect(cost.source).toBe('computed')
      expect(cost.usd).toBeGreaterThan(0)
    }
  })

  // The `/enhance` planner is a text model. Before it had a rate, every plan
  // reported `cost_usd: null` to argo, which renders as $0 — hiding most of this
  // service's token volume behind a number that looked like "free".
  test('the enhance planner prices from TEXT_RATES', () => {
    const usage: Usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, total_tokens: 2e6 }
    // `gpt-5.6` is an alias that resolves to `gpt-5.6-sol` upstream, so they must
    // price identically — $5/M in + $30/M out.
    expect(computeCost('gpt-5.6', usage)).toEqual({ usd: 35, source: 'computed' })
    expect(computeCost('gpt-5.6-sol', usage)).toEqual(computeCost('gpt-5.6', usage))
  })

  test('gpt-image-2.5-flare and gpt-image-2.5-sunburst price identically (same token rate)', () => {
    const usage: Usage = {
      input_tokens: 1000,
      output_tokens: 2000,
      total_tokens: 3000,
      input_tokens_details: { text_tokens: 600, image_tokens: 400 },
    }
    expect(computeCost('gpt-image-2.5-flare', usage)).toEqual(
      computeCost('gpt-image-2.5-sunburst', usage),
    )
    const expected = (600 / 1_000_000) * 5.0 + (400 / 1_000_000) * 8.0 + (2000 / 1_000_000) * 30.0
    expect(computeCost('gpt-image-2.5-flare', usage).usd).toBeCloseTo(expected, 10)
  })

  // gpt-6-luna is priced from the OpenAI pricing page (not a live probe against
  // our own endpoint) — see the TEXT_RATES comment. `gpt-5.6-luna` must survive
  // unchanged alongside it.
  test('gpt-6-luna prices from TEXT_RATES, and gpt-5.6-luna keeps its own separate rate', () => {
    const usage: Usage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      total_tokens: 2_000_000,
    }
    expect(computeCost('gpt-6-luna', usage)).toEqual({ usd: 0.6, source: 'computed' })
    expect(computeCost('gpt-5.6-luna', usage)).toEqual({ usd: 1.4, source: 'computed' })
  })

  test('unknown model returns no cost', () => {
    const usage: Usage = { input_tokens: 100, output_tokens: 100, total_tokens: 200 }
    expect(computeCost('not-a-real-model', usage)).toEqual({ usd: null, source: 'none' })
  })

  describe('cached tokens', () => {
    test('deepseek-v4.1-flash prices cached tokens at the cached rate, the rest at the full rate', () => {
      const usage: Usage = {
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
        input_tokens_details: { cached_tokens: 400 },
      }
      const cost = computeCost('deepseek-v4.1-flash', usage)
      // (600 uncached / 1e6 * 0.50) + (400 cached / 1e6 * 0.05) + (500 / 1e6 * 1.50)
      const expected = (600 / 1_000_000) * 0.5 + (400 / 1_000_000) * 0.05 + (500 / 1_000_000) * 1.5
      expect(cost.source).toBe('computed')
      expect(cost.usd).toBeCloseTo(expected, 10)
    })

    test('a model with no cached_in rate falls back to the full text rate for cached tokens', () => {
      const usage: Usage = {
        input_tokens: 1000,
        output_tokens: 0,
        total_tokens: 1000,
        input_tokens_details: { cached_tokens: 500 },
      }
      const cost = computeCost('gpt-5.6-terra', usage)
      expect(cost.usd).toBeCloseTo((1000 / 1_000_000) * 2.5, 10)
    })

    test('cached_tokens is clamped to input_tokens (never a negative uncached remainder)', () => {
      const usage: Usage = {
        input_tokens: 100,
        output_tokens: 0,
        total_tokens: 100,
        input_tokens_details: { cached_tokens: 999 },
      }
      const cost = computeCost('deepseek-v4.1-flash', usage)
      expect(cost.usd).toBeCloseTo((100 / 1_000_000) * 0.05, 10)
    })
  })
})
