import { describe, expect, test } from 'bun:test'

// generate.ts -> upstream.ts -> env.ts parses process.env at module load.
process.env['API_SECRET'] ??= 'test-secret'
process.env['OPENAI_BASE_URL'] ??= 'http://localhost:1'
process.env['OPENAI_API_KEY'] ??= 'test-key'

const { generateRoutes } = await import('./generate.js')
const { generateResponseSchema } = await import('@image-gateway/shared')

// 1x1 PNG, base64-encoded, so magic-byte validation passes.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

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

describe('POST /generate', () => {
  test('non-streaming path returns a response validated against generateResponseSchema', async () =>
    withMockedFetch(
      async () =>
        new Response(
          JSON.stringify({
            created: 1700000000,
            data: [{ b64_json: PNG_B64 }],
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      async () => {
        const res = await generateRoutes.handle(
          new Request('http://localhost/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: 'a cat wearing a hat' }),
          }),
        )
        expect(res.status).toBe(200)
        const parsed = generateResponseSchema.safeParse(await res.json())
        expect(parsed.success).toBe(true)
        expect(parsed.data?.images).toHaveLength(1)
        expect(parsed.data?.images[0]?.b64_json).toBe(PNG_B64)
      },
    ))

  test('streaming path (partial_images > 0) responds as SSE, not the JSON envelope', async () =>
    withMockedFetch(
      async () => {
        const completed = `event: image_generation.completed\ndata: ${JSON.stringify({
          b64_json: PNG_B64,
          output_format: 'png',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        })}\n\n`
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(completed))
            controller.close()
          },
        })
        return new Response(body)
      },
      async () => {
        const res = await generateRoutes.handle(
          new Request('http://localhost/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: 'a cat wearing a hat', partial_images: 1 }),
          }),
        )
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('text/event-stream')
        const text = await res.text()
        expect(text).toContain('"type":"completed"')
      },
    ))

  test('a moderation-blocked upstream response surfaces code + moderation_details on the 502', async () =>
    withMockedFetch(
      async () =>
        new Response(
          '[OpenAI Vendor Group Key StatusCode: BadRequest] ' +
            JSON.stringify({
              error: {
                code: 'moderation_blocked',
                type: 'image_generation_user_error',
                message: 'Your request was blocked by our moderation system.',
                moderation_details: { moderation_stage: 'input', categories: ['other'] },
              },
            }),
          { status: 503 },
        ),
      async () => {
        const res = await generateRoutes.handle(
          new Request('http://localhost/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: 'a restricted subject' }),
          }),
        )
        expect(res.status).toBe(502)
        const body = (await res.json()) as {
          error: {
            code?: string
            moderation_details?: { moderation_stage: string; categories: string[] }
          }
        }
        expect(body.error.code).toBe('moderation_blocked')
        expect(body.error.moderation_details).toEqual({
          moderation_stage: 'input',
          categories: ['other'],
        })
      },
    ))

  /**
   * `background: "transparent"` is accepted on both generatable models
   * (real alpha channel, live-probed 2026-09-23) — it reaches upstream rather
   * than being refused.
   */
  test('a transparent-background request with png output reaches upstream and succeeds', async () => {
    let upstreamCalled = false
    await withMockedFetch(
      async () => {
        upstreamCalled = true
        return new Response(
          JSON.stringify({
            created: 1700000000,
            data: [{ b64_json: PNG_B64 }],
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
      async () => {
        const res = await generateRoutes.handle(
          new Request('http://localhost/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: 'a sticker of a cat', background: 'transparent' }),
          }),
        )
        expect(res.status).toBe(200)
        expect(upstreamCalled).toBe(true)
      },
    )
  })

  /**
   * `background: "transparent"` needs an alpha channel in the output format —
   * jpeg has none, so this business-rule 400 fires before upstream is ever
   * called, rather than downgrading transparency or letting upstream 400.
   */
  test('a transparent-background + jpeg request is refused with a 400 naming the missing alpha channel', async () => {
    let upstreamCalled = false
    await withMockedFetch(
      async () => {
        upstreamCalled = true
        return new Response('{}', { status: 200 })
      },
      async () => {
        const res = await generateRoutes.handle(
          new Request('http://localhost/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              prompt: 'a sticker of a cat',
              background: 'transparent',
              output_format: 'jpeg',
            }),
          }),
        )
        expect(res.status).toBe(400)
        const body = (await res.json()) as { error: { message: string; type: string } }
        expect(body.error.type).toBe('invalid_request_error')
        expect(body.error.message).toMatch(/alpha channel/)
        expect(upstreamCalled).toBe(false)
      },
    )
  })

  test('an xhigh/max quality request is accepted (extended quality tiers)', async () =>
    withMockedFetch(
      async () =>
        new Response(
          JSON.stringify({
            created: 1700000000,
            data: [{ b64_json: PNG_B64 }],
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      async () => {
        const res = await generateRoutes.handle(
          new Request('http://localhost/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: 'a sticker of a cat', quality: 'max' }),
          }),
        )
        expect(res.status).toBe(200)
      },
    ))

  test('an opaque background is accepted (the 400 is specific to transparency)', async () =>
    withMockedFetch(
      async () =>
        new Response(
          JSON.stringify({
            created: 1700000000,
            data: [{ b64_json: PNG_B64 }],
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      async () => {
        const res = await generateRoutes.handle(
          new Request('http://localhost/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: 'a sticker of a cat', background: 'opaque' }),
          }),
        )
        expect(res.status).toBe(200)
      },
    ))

  /**
   * Deploy-compat shim: the app build installed before 2026-09-23 sends `model: "gpt-image-2"`
   * explicitly (its era's `DEFAULT_MODEL`). Without `LEGACY_REQUEST_MODELS`, this 422s until the
   * app is rebuilt. It must still validate, still reach upstream, and route exactly like `auto`.
   */
  test('a legacy model: "gpt-image-2" request is accepted (200) and routed to flare at quality low', async () => {
    let sentModel: unknown
    await withMockedFetch(
      async (_url, init) => {
        sentModel = (JSON.parse(String(init?.body)) as { model: unknown }).model
        return new Response(
          JSON.stringify({
            created: 1700000000,
            data: [{ b64_json: PNG_B64 }],
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
      async () => {
        const res = await generateRoutes.handle(
          new Request('http://localhost/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              prompt: 'a sticker of a cat',
              model: 'gpt-image-2',
              quality: 'low',
            }),
          }),
        )
        expect(res.status).toBe(200)
        const parsed = generateResponseSchema.parse(await res.json())
        expect(parsed.model).toBe('gpt-image-2.5-flare')
        expect(parsed.requested_model).toBe('gpt-image-2')
        expect(parsed.routed).toBe(true)
        expect(parsed.routing_reason).toContain('gpt-image-2 is retired')
        expect(sentModel).toBe('gpt-image-2.5-flare')
      },
    )
  })

  test('a legacy model: "gpt-image-2" request at quality high routes to sunburst', async () =>
    withMockedFetch(
      async () =>
        new Response(
          JSON.stringify({
            created: 1700000000,
            data: [{ b64_json: PNG_B64 }],
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      async () => {
        const res = await generateRoutes.handle(
          new Request('http://localhost/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              prompt: 'a sticker of a cat',
              model: 'gpt-image-2',
              quality: 'high',
            }),
          }),
        )
        const parsed = generateResponseSchema.parse(await res.json())
        expect(parsed.model).toBe('gpt-image-2.5-sunburst')
      },
    ))
})
