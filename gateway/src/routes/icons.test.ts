import { afterEach, describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { multipartRequest } from './test-multipart.js'

// icons.ts -> replicate.ts -> env.ts parses process.env at module load (shared across files).
process.env['API_SECRET'] ??= 'test-secret'
process.env['OPENAI_BASE_URL'] ??= 'http://localhost:1'
process.env['OPENAI_API_KEY'] ??= 'test-key'

const { env } = await import('../env.js')
const { iconsRoutes } = await import('./icons.js')
const { errorResponseSchema, iconsResponseSchema } = await import('@image-gateway/shared')

env.REPLICATE_BASE_URL = 'http://replicate.test/replicate/v1'

const original = global.fetch
afterEach(() => {
  global.fetch = original
})

/** Transparent canvas with an opaque square: real transparency, so `auto` skips the cutout. */
const transparentSquare = (): Promise<Buffer> =>
  sharp({
    create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: {
          create: {
            width: 200,
            height: 200,
            channels: 4,
            background: { r: 200, g: 20, b: 20, alpha: 1 },
          },
        },
      },
    ])
    .png()
    .toBuffer()

type Upload = { bytes: Uint8Array; type: string }

const post = (fields: Record<string, string>, file?: Upload): Promise<Response> =>
  iconsRoutes.handle(multipartRequest('http://localhost/icons', fields, file))

describe('POST /icons', () => {
  test('400 when the image is missing', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
    errorResponseSchema.parse(await res.json())
  })

  test('400 for a disallowed mime type', async () => {
    const res = await post({}, { bytes: new Uint8Array([1, 2, 3]), type: 'image/gif' })
    expect(res.status).toBe(400)
  })

  test('400 for a malformed background color', async () => {
    const res = await post(
      { background: 'white' },
      { bytes: await transparentSquare(), type: 'image/png' },
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      '#rrggbb',
    )
  })

  test('400 for an unknown cutout mode', async () => {
    const res = await post(
      { cutout: 'sometimes' },
      { bytes: await transparentSquare(), type: 'image/png' },
    )
    expect(res.status).toBe(400)
  })

  test('400 for bytes that are not an image', async () => {
    const res = await post({}, { bytes: new Uint8Array([1, 2, 3]), type: 'image/png' })
    expect(res.status).toBe(400)
  })

  test('200 with the full file set, zero cost, and no network when the cutout is skipped', async () => {
    global.fetch = (async () => {
      throw new Error('no network expected')
    }) as unknown as typeof fetch

    const res = await post(
      { background: '#112233' },
      { bytes: await transparentSquare(), type: 'image/png' },
    )
    expect(res.status).toBe(200)
    const parsed = iconsResponseSchema.parse(await res.json())
    expect(parsed.files.map((f) => f.name)).toEqual([
      'favicon.ico',
      'icon-192.png',
      'icon-512.png',
      'icon-mask.png',
      'apple-touch-icon.png',
      'icon-1024.png',
      'AppIcon.icns',
    ])
    expect(parsed.cutout).toBeNull()
    expect(parsed.cost).toEqual({ usd: 0, source: 'computed' })
    expect(parsed.manifest.icons).toHaveLength(3)
    expect(parsed.html).toContain('rel="manifest"')
  })

  test('502 when a forced cutout fails upstream', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ id: 'p', status: 'failed', error: 'boom' }), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    const res = await post(
      { cutout: 'always' },
      { bytes: await transparentSquare(), type: 'image/png' },
    )
    expect(res.status).toBe(502)
    expect(errorResponseSchema.parse(await res.json()).error.message).toContain('boom')
  })
})
