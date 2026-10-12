import { describe, expect, test } from 'bun:test'

// enhance.ts -> upstream.ts -> env.ts parses process.env at module load.
process.env['API_SECRET'] ??= 'test-secret'
process.env['OPENAI_BASE_URL'] ??= 'http://localhost:1'
process.env['OPENAI_API_KEY'] ??= 'test-key'
// Pinned explicitly so the assertion below tests the echo-back behaviour rather
// than a second copy of env.ts's default — which is what let this test silently
// encode 'gpt-5.6' and break when the default moved to a concrete model id.
process.env['ENHANCE_MODEL'] ??= 'gpt-6-luna'

const { enhanceRoutes } = await import('./enhance.js')
const { planResponseSchema, estimateCost } = await import('@image-gateway/shared')

function withMockedFetch(
  impl: (...args: Parameters<typeof fetch>) => Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const original = global.fetch
  global.fetch = impl as unknown as typeof fetch
  return run().finally(() => {
    global.fetch = original
  })
}

function chatCompletion(
  content: unknown,
  usage?: Record<string, unknown>,
  finishReason = 'stop',
): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { content: typeof content === 'string' ? content : JSON.stringify(content) },
          finish_reason: finishReason,
        },
      ],
      usage: usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

const VALID_LLM_PLAN = {
  intent: { detected: 'hero', confidence: 0.92 },
  prompt: 'a wide oil painting of a lighthouse at dusk, dramatic amber lighting',
  additions: [{ slot: 'lighting', text: 'dramatic amber lighting' }],
  assumptions: ['assumed dusk mood'],
  warnings: [],
  proposed_settings: {
    model: 'gpt-image-2.5-flare',
    size: 'auto',
    quality: 'medium',
    background: 'opaque',
    n: 1,
    moderation: 'auto',
    partial_images: 1,
  },
}

function postEnhance(body: Record<string, unknown>): Promise<Response> {
  return enhanceRoutes.handle(
    new Request('http://localhost/enhance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

describe('POST /enhance', () => {
  test('returns a response that validates against planResponseSchema', async () =>
    withMockedFetch(
      async () => chatCompletion(VALID_LLM_PLAN),
      async () => {
        const res = await postEnhance({ brief: 'a lighthouse at dusk' })
        expect(res.status).toBe(200)
        const parsed = planResponseSchema.safeParse(await res.json())
        expect(parsed.success).toBe(true)
      },
    ))

  test('enhance_model echoes env.ENHANCE_MODEL', async () =>
    withMockedFetch(
      async () => chatCompletion(VALID_LLM_PLAN),
      async () => {
        const res = await postEnhance({ brief: 'a lighthouse at dusk' })
        const parsed = planResponseSchema.parse(await res.json())
        expect(parsed.enhance_model).toBe(process.env['ENHANCE_MODEL']!)
      },
    ))

  test('never calls the image endpoints, only /chat/completions', async () =>
    withMockedFetch(
      async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        expect(url).toContain('/chat/completions')
        expect(url).not.toContain('/images/')
        return chatCompletion(VALID_LLM_PLAN)
      },
      async () => {
        const res = await postEnhance({ brief: 'a lighthouse at dusk' })
        expect(res.status).toBe(200)
      },
    ))

  test('requests response_format: json_object on the first attempt', async () =>
    withMockedFetch(
      async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { response_format?: { type: string } }
        expect(body.response_format).toEqual({ type: 'json_object' })
        return chatCompletion(VALID_LLM_PLAN)
      },
      async () => {
        const res = await postEnhance({ brief: 'a lighthouse at dusk' })
        expect(res.status).toBe(200)
      },
    ))

  test('falls back to prompt-instructed JSON when upstream rejects response_format', async () => {
    let callCount = 0
    await withMockedFetch(
      async (_input, init) => {
        callCount++
        const body = JSON.parse(String(init?.body)) as { response_format?: unknown }
        if (body.response_format) {
          return new Response(
            '[OpenAI Vendor Group Key StatusCode: BadRequest] ' +
              JSON.stringify({
                error: {
                  type: 'invalid_request_user_error',
                  message: "Unknown parameter: 'response_format'.",
                },
              }),
            { status: 503 },
          )
        }
        return chatCompletion(VALID_LLM_PLAN)
      },
      async () => {
        const res = await postEnhance({ brief: 'a lighthouse at dusk' })
        expect(res.status).toBe(200)
        expect(callCount).toBe(2)
      },
    )
  })

  test('overrides are echoed verbatim into settings, taking precedence over the plan proposal', async () =>
    withMockedFetch(
      async () => chatCompletion(VALID_LLM_PLAN),
      async () => {
        const res = await postEnhance({
          brief: 'a lighthouse at dusk',
          overrides: { quality: 'high', n: 3 },
        })
        expect(res.status).toBe(200)
        const parsed = planResponseSchema.parse(await res.json())
        expect(parsed.settings.quality).toBe('high')
        expect(parsed.settings.n).toBe(3)
      },
    ))

  test('a transparent-background proposal is passed through, not corrected — both models have an alpha channel', async () =>
    withMockedFetch(
      async () =>
        chatCompletion({
          ...VALID_LLM_PLAN,
          proposed_settings: { ...VALID_LLM_PLAN.proposed_settings, background: 'transparent' },
        }),
      async () => {
        const res = await postEnhance({ brief: 'an app icon' })
        const parsed = planResponseSchema.parse(await res.json())
        expect(parsed.settings.model).toBe('gpt-image-2.5-flare')
        expect(parsed.settings.background).toBe('transparent')
        expect(parsed.assumptions.some((note) => note.includes('alpha channel'))).toBe(false)
      },
    ))

  /**
   * The enhance model has the retired models in its training data and the
   * playbook is edited independently of the gateway, so a stale proposal is a
   * live failure mode — not a hypothetical. It must degrade to the default
   * model rather than failing the plan, and the settings it returns must be
   * runnable as-is.
   */
  test('a retired model proposal degrades to the generatable model instead of failing', async () =>
    withMockedFetch(
      async () =>
        chatCompletion({
          ...VALID_LLM_PLAN,
          proposed_settings: { ...VALID_LLM_PLAN.proposed_settings, model: 'gpt-image-2' },
        }),
      async () => {
        const res = await postEnhance({ brief: 'an app icon' })
        expect(res.status).toBe(200)
        const parsed = planResponseSchema.parse(await res.json())
        expect(parsed.settings.model).toBe('gpt-image-2.5-flare')
      },
    ))

  test('an xhigh/max quality proposal is honoured on both generatable models', async () =>
    withMockedFetch(
      async () =>
        chatCompletion({
          ...VALID_LLM_PLAN,
          proposed_settings: { ...VALID_LLM_PLAN.proposed_settings, quality: 'xhigh' },
        }),
      async () => {
        const res = await postEnhance({ brief: 'a print-ready poster' })
        const parsed = planResponseSchema.parse(await res.json())
        expect(parsed.settings.quality).toBe('xhigh')
      },
    ))

  test('estimated_cost matches the shared estimateCost anchors for the resolved settings', async () =>
    withMockedFetch(
      async () =>
        chatCompletion({
          ...VALID_LLM_PLAN,
          proposed_settings: { ...VALID_LLM_PLAN.proposed_settings, quality: 'high', n: 2 },
        }),
      async () => {
        const res = await postEnhance({ brief: 'a lighthouse at dusk' })
        const parsed = planResponseSchema.parse(await res.json())
        const expected = estimateCost({
          model: parsed.settings.model,
          quality: parsed.settings.quality,
          size: parsed.settings.size,
          streaming: parsed.settings.partial_images > 0,
          n: parsed.settings.n,
        })
        expect(parsed.estimated_cost).toEqual(expected)
      },
    ))

  test('a long brief (>100 words) applies passthrough mode: prompt is the raw brief', async () => {
    const longBrief = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ')
    await withMockedFetch(
      async () =>
        chatCompletion({
          ...VALID_LLM_PLAN,
          prompt: 'the LLM would rewrite this, but passthrough must discard it',
          constraint_block: 'Preserve exact wording.',
        }),
      async () => {
        const res = await postEnhance({ brief: longBrief })
        const parsed = planResponseSchema.parse(await res.json())
        expect(parsed.mode_applied).toBe('off')
        expect(parsed.prompt).toBe(`${longBrief}\n\nPreserve exact wording.`)
        expect(parsed.additions).toEqual([])
      },
    )
  })

  test('retries once on an invalid LLM JSON reply, then succeeds', async () => {
    let callCount = 0
    await withMockedFetch(
      async () => {
        callCount++
        if (callCount === 1) return chatCompletion('not valid json at all')
        return chatCompletion(VALID_LLM_PLAN)
      },
      async () => {
        const res = await postEnhance({ brief: 'a lighthouse at dusk' })
        expect(res.status).toBe(200)
        expect(callCount).toBe(2)
      },
    )
  })

  test('502s after the LLM output fails validation twice', async () =>
    withMockedFetch(
      async () => chatCompletion('still not valid json'),
      async () => {
        const res = await postEnhance({ brief: 'a lighthouse at dusk' })
        expect(res.status).toBe(502)
      },
    ))

  test('maps upstream connectivity failure to 502', async () =>
    withMockedFetch(
      async () => new Response('{"error":{"type":"invalid_request_user_error"}}', { status: 503 }),
      async () => {
        const res = await postEnhance({ brief: 'a lighthouse' })
        expect(res.status).toBe(502)
      },
    ))

  describe('truncated / empty replies (finish_reason: length)', () => {
    test('retries with double max_completion_tokens on a truncated reply, then succeeds', async () => {
      const budgets: number[] = []
      let callCount = 0
      await withMockedFetch(
        async (_input, init) => {
          callCount++
          const body = JSON.parse(String(init?.body)) as { max_completion_tokens: number }
          budgets.push(body.max_completion_tokens)
          if (callCount === 1) return chatCompletion('', undefined, 'length')
          return chatCompletion(VALID_LLM_PLAN)
        },
        async () => {
          const res = await postEnhance({ brief: 'a lighthouse at dusk' })
          expect(res.status).toBe(200)
          expect(callCount).toBe(2)
          expect(budgets).toEqual([16000, 32000])
        },
      )
    })

    test('retries on empty content even when finish_reason is not reported as length', async () => {
      let callCount = 0
      await withMockedFetch(
        async () => {
          callCount++
          if (callCount === 1) return chatCompletion('   ')
          return chatCompletion(VALID_LLM_PLAN)
        },
        async () => {
          const res = await postEnhance({ brief: 'a lighthouse at dusk' })
          expect(res.status).toBe(200)
          expect(callCount).toBe(2)
        },
      )
    })

    test('502s when the reply is still truncated after doubling the budget', async () =>
      withMockedFetch(
        async () => chatCompletion('', undefined, 'length'),
        async () => {
          const res = await postEnhance({ brief: 'a lighthouse at dusk' })
          expect(res.status).toBe(502)
        },
      ))
  })
})
