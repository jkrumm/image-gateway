import { afterEach, describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { multipartRequest } from './test-multipart.js'

// cutout.ts -> replicate.ts -> env.ts parses process.env at module load (shared across files).
process.env['API_SECRET'] ??= 'test-secret'
process.env['OPENAI_BASE_URL'] ??= 'http://localhost:1'
process.env['OPENAI_API_KEY'] ??= 'test-key'

const { env } = await import('../env.js')
const { cutoutRoutes } = await import('./cutout.js')
const { cutoutResponseSchema, errorResponseSchema } = await import('@image-gateway/shared')

env.REPLICATE_BASE_URL = 'http://replicate.test/replicate/v1'

const DELIVERY = 'https://replicate.delivery/pbxt/out.png'
const original = global.fetch
afterEach(() => {
  global.fetch = original
})

const png = (size: number): Promise<Buffer> =>
  sharp({
    create: { width: size, height: size, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
  })
    .png()
    .toBuffer()

type Upload = { bytes: Uint8Array; type: string }

const post = (fields: Record<string, string>, file?: Upload): Promise<Response> =>
  cutoutRoutes.handle(multipartRequest('http://localhost/cutout', fields, file))

describe('POST /cutout', () => {
  test('400 when the image is missing', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
    errorResponseSchema.parse(await res.json())
  })

  test('400 for a disallowed mime type', async () => {
    const res = await post({}, { bytes: new Uint8Array([1, 2, 3]), type: 'image/gif' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      'image/png',
    )
  })

  test('400 for an unknown model', async () => {
    const res = await post({ model: 'nope/nope' }, { bytes: await png(300), type: 'image/png' })
    expect(res.status).toBe(400)
  })

  test('400 for an image under the minimum size', async () => {
    const res = await post({}, { bytes: await png(100), type: 'image/png' })
    expect(res.status).toBe(400)
  })

  test('400 for bytes that are not an image', async () => {
    const res = await post({}, { bytes: new Uint8Array([1, 2, 3]), type: 'image/png' })
    expect(res.status).toBe(400)
  })

  test('200 returns the cutout PNG with computed cost', async () => {
    const output = await png(300)
    global.fetch = (async (input: Parameters<typeof fetch>[0]) =>
      String(input) === DELIVERY
        ? new Response(output)
        : new Response(JSON.stringify({ id: 'p', status: 'succeeded', output: DELIVERY }), {
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch

    const res = await post(
      { model: 'bria/remove-background' },
      { bytes: await png(300), type: 'image/png' },
    )
    expect(res.status).toBe(200)
    const parsed = cutoutResponseSchema.parse(await res.json())
    expect(parsed.model).toBe('bria/remove-background')
    expect(parsed.cost).toEqual({ usd: 0.018, source: 'computed' })
    expect([parsed.width, parsed.height]).toEqual([300, 300])
    expect(Buffer.from(parsed.image.b64_json, 'base64').equals(output)).toBe(true)
  })

  test('502 when Replicate fails', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ id: 'p', status: 'failed', error: 'boom' }), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    const res = await post({}, { bytes: await png(300), type: 'image/png' })
    expect(res.status).toBe(502)
    expect(errorResponseSchema.parse(await res.json()).error.message).toContain('boom')
  })
})
