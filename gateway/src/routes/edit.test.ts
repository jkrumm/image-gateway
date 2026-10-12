import { describe, expect, test } from 'bun:test'

// edit.ts -> upstream.ts -> env.ts parses process.env at module load.
process.env['API_SECRET'] ??= 'test-secret'
process.env['OPENAI_BASE_URL'] ??= 'http://localhost:1'
process.env['OPENAI_API_KEY'] ??= 'test-key'

const { editRoutes } = await import('./edit.js')
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

function editForm(fields: Record<string, string>): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  form.append('image', new File([new Uint8Array([0, 1, 2, 3])], 'ref.png', { type: 'image/png' }))
  return form
}

function upstreamOk(): Response {
  return new Response(
    JSON.stringify({
      created: 1700000000,
      data: [{ b64_json: PNG_B64 }],
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('POST /edit', () => {
  test('an ordinary edit with an explicit model is accepted (200)', async () =>
    withMockedFetch(
      async () => upstreamOk(),
      async () => {
        const res = await editRoutes.handle(
          new Request('http://localhost/edit', {
            method: 'POST',
            body: editForm({
              prompt: 'a sticker of a cat',
              model: 'gpt-image-2.5-sunburst',
              quality: 'low',
            }),
          }),
        )
        expect(res.status).toBe(200)
        const parsed = generateResponseSchema.parse(await res.json())
        expect(parsed.model).toBe('gpt-image-2.5-sunburst')
        expect(parsed.routed).toBe(false)
      },
    ))

  /**
   * Deploy-compat shim: the app build installed before 2026-09-23 sends `model: "gpt-image-2"`
   * explicitly on edits too. It must still validate and route exactly like `auto` would on an
   * edit — always sunburst, regardless of quality.
   */
  test('a legacy model: "gpt-image-2" edit is accepted (200) and routed to sunburst', async () =>
    withMockedFetch(
      async () => upstreamOk(),
      async () => {
        const res = await editRoutes.handle(
          new Request('http://localhost/edit', {
            method: 'POST',
            body: editForm({
              prompt: 'a sticker of a cat',
              model: 'gpt-image-2',
              quality: 'low',
            }),
          }),
        )
        expect(res.status).toBe(200)
        const parsed = generateResponseSchema.parse(await res.json())
        expect(parsed.model).toBe('gpt-image-2.5-sunburst')
        expect(parsed.requested_model).toBe('gpt-image-2')
        expect(parsed.routed).toBe(true)
        expect(parsed.routing_reason).toContain('gpt-image-2 is retired')
      },
    ))
})
