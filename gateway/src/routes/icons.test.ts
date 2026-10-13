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

const OUT = (name: string): string => `https://replicate.delivery/pbxt/${name}`
const ARGO = 'http://argo.test/api/usage'

const png = (alpha: number): Promise<Buffer> =>
  sharp({
    create: {
      width: 600,
      height: 600,
      channels: 4,
      background: { r: 200, g: 20, b: 20, alpha },
    },
  })
    .png()
    .toBuffer()

// The 400 px opaque square: auto upscales it, auto cuts it out, auto vectorizes it.
const opaque400 = (): Promise<Buffer> =>
  sharp({ create: { width: 400, height: 400, channels: 3, background: '#c81414' } })
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

  test('400 for an unknown upscale or svg mode', async () => {
    const bytes = await transparentSquare()
    for (const fields of [{ upscale: 'sometimes' }, { svg: 'always' }]) {
      const res = await post(fields, { bytes, type: 'image/png' })
      expect(res.status).toBe(400)
    }
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
      { background: '#112233', upscale: 'never', svg: 'never' },
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
    expect(parsed.steps).toEqual([])
    expect(parsed.svg_skipped_reason).toBeUndefined()
    expect(parsed.html).not.toContain('favicon.svg')
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
      { cutout: 'always', upscale: 'never', svg: 'never' },
      { bytes: await transparentSquare(), type: 'image/png' },
    )
    expect(res.status).toBe(502)
    expect(errorResponseSchema.parse(await res.json()).error.message).toContain('boom')
  })

  describe('Replicate steps and telemetry', () => {
    interface ArgoRecord {
      source_id: string
      model: string
      outcome: string
      cost_usd: number | null
      sub_tool: string
    }

    /** Fake Replicate + argo: each model's prediction succeeds and delivers its own file. */
    async function mockStack(opts: { failModel?: string } = {}): Promise<ArgoRecord[]> {
      const records: ArgoRecord[] = []
      const upscaled = await png(1)
      const cutOut = await sharp({
        create: {
          width: 600,
          height: 600,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .composite([
          {
            input: {
              create: { width: 300, height: 300, channels: 4, background: '#c81414' },
            },
          },
        ])
        .png()
        .toBuffer()
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048 2048" width="1" height="1"><path transform="translate(0,0)" d="M0 0h10v10z"/></svg>'
      const files: Record<string, Uint8Array | string> = {
        [OUT('up.png')]: upscaled,
        [OUT('cut.png')]: cutOut,
        [OUT('vec.svg')]: svg,
      }
      const outputs: Record<string, string> = {
        'nightmareai/real-esrgan': OUT('up.png'),
        'recraft-ai/recraft-remove-background': OUT('cut.png'),
        'recraft-ai/recraft-vectorize': OUT('vec.svg'),
      }
      env.ARGO_USAGE_URL = ARGO
      env.ARGO_API_SECRET = 'argo-secret'
      global.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input)
        if (url === ARGO) {
          records.push(...(JSON.parse(String(init?.body)) as { records: ArgoRecord[] }).records)
          return new Response('{}')
        }
        if (url in files) return new Response(files[url] as Uint8Array | string)
        const model = url.split('/models/')[1]?.replace('/predictions', '') ?? ''
        if (model === opts.failModel) {
          return Response.json({ id: 'p', status: 'failed', error: 'step exploded' })
        }
        return Response.json({ id: 'p', status: 'succeeded', output: outputs[model] })
      }) as unknown as typeof fetch
      return records
    }

    afterEach(() => {
      delete env.ARGO_USAGE_URL
      delete env.ARGO_API_SECRET
    })

    test('a full run reports every step, sums the cost and writes one unique argo record per step', async () => {
      const records = await mockStack()
      const res = await post({}, { bytes: await opaque400(), type: 'image/png' })
      expect(res.status).toBe(200)
      const parsed = iconsResponseSchema.parse(await res.json())

      expect(parsed.steps.map((s) => [s.step, s.model, s.cost_usd])).toEqual([
        ['upscale', 'nightmareai/real-esrgan', 0.002],
        ['cutout', 'recraft-ai/recraft-remove-background', 0.01],
        ['vectorize', 'recraft-ai/recraft-vectorize', 0.01],
      ])
      expect(parsed.cost.usd).toBeCloseTo(0.022, 6)
      expect(parsed.files.map((f) => f.name)).toContain('favicon.svg')
      expect(parsed.html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">')

      await Bun.sleep(50)
      expect(records.map((r) => r.model).toSorted()).toEqual([
        'nightmareai/real-esrgan',
        'recraft-ai/recraft-remove-background',
        'recraft-ai/recraft-vectorize',
      ])
      expect(records.every((r) => r.sub_tool === 'icons' && r.outcome === 'ok')).toBe(true)
      expect(records.map((r) => r.source_id).toSorted()).toEqual([
        `${parsed.id}:cutout`,
        `${parsed.id}:upscale`,
        `${parsed.id}:vectorize`,
      ])
    })

    test('a request with no Replicate step still writes one zero-cost request record', async () => {
      const records = await mockStack()
      const res = await post(
        { upscale: 'never', svg: 'never' },
        { bytes: await transparentSquare(), type: 'image/png' },
      )
      const parsed = iconsResponseSchema.parse(await res.json())
      await Bun.sleep(50)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ source_id: parsed.id, model: 'none', cost_usd: 0 })
    })

    test("a failing step is a 502 reported under that step's model, after the completed steps", async () => {
      const records = await mockStack({ failModel: 'recraft-ai/recraft-vectorize' })
      const res = await post({}, { bytes: await opaque400(), type: 'image/png' })
      expect(res.status).toBe(502)
      expect(errorResponseSchema.parse(await res.json()).error.message).toContain('step exploded')

      await Bun.sleep(50)
      const failed = records.find((r) => r.outcome === 'error')
      expect(failed?.model).toBe('recraft-ai/recraft-vectorize')
      expect(
        records
          .filter((r) => r.outcome === 'ok')
          .map((r) => r.model)
          .toSorted(),
      ).toEqual(['nightmareai/real-esrgan', 'recraft-ai/recraft-remove-background'])
      expect(new Set(records.map((r) => r.source_id)).size).toBe(records.length)
    })
  })
})
