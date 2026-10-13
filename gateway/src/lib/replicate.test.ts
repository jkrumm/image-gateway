import sharp from 'sharp'
import { afterEach, describe, expect, test } from 'bun:test'

// replicate.ts -> env.ts parses process.env at module load (shared across test files).
process.env['API_SECRET'] ??= 'test-secret'
process.env['OPENAI_BASE_URL'] ??= 'http://localhost:1'
process.env['OPENAI_API_KEY'] ??= 'test-key'

const { env } = await import('../env.js')
const { isReplicateDeliveryUrl, removeBackground, ReplicateError, resolveReplicateBase } =
  await import('./replicate.js')

// Whichever test file loaded env.ts first wins, so pin the override on the parsed object.
env.REPLICATE_BASE_URL = 'http://replicate.test/replicate/v1'

const MODEL = 'recraft-ai/recraft-remove-background'
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
const INPUT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9])
const DELIVERY = 'https://replicate.delivery/pbxt/out.png'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface Call {
  url: string
  method: string
  headers: Headers
  body: unknown
}

const original = global.fetch
afterEach(() => {
  global.fetch = original
})

function mockFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  global.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof fetch
  return calls
}

describe('resolveReplicateBase', () => {
  test('swaps the trailing /openai/v1 for /replicate/v1', () => {
    expect(resolveReplicateBase('https://proxy.example.com/openai/v1')).toBe(
      'https://proxy.example.com/replicate/v1',
    )
    expect(resolveReplicateBase('https://proxy.example.com/openai/v1/')).toBe(
      'https://proxy.example.com/replicate/v1',
    )
  })

  test('an explicit override wins, trailing slash trimmed', () => {
    expect(resolveReplicateBase('http://localhost:1', 'https://r.example.com/v1/')).toBe(
      'https://r.example.com/v1',
    )
  })

  test('refuses to guess when there is no /openai/v1 suffix', () => {
    expect(() => resolveReplicateBase('http://localhost:1')).toThrow(ReplicateError)
  })
})

describe('isReplicateDeliveryUrl', () => {
  test('accepts replicate.delivery over https only', () => {
    expect(isReplicateDeliveryUrl(DELIVERY)).toBe(true)
    expect(isReplicateDeliveryUrl('https://pbxt.replicate.delivery/a.png')).toBe(true)
    expect(isReplicateDeliveryUrl('http://replicate.delivery/a.png')).toBe(false)
    expect(isReplicateDeliveryUrl('https://evilreplicate.delivery/a.png')).toBe(false)
    expect(isReplicateDeliveryUrl('https://replicate.delivery.evil.com/a.png')).toBe(false)
    expect(isReplicateDeliveryUrl('not a url')).toBe(false)
  })
})

describe('removeBackground', () => {
  test('wait path: create succeeds immediately, delivery is fetched', async () => {
    const calls = mockFetch((call) => {
      if (call.url === DELIVERY) return new Response(PNG_BYTES)
      return json({ id: 'p1', status: 'succeeded', output: DELIVERY })
    })

    const out = await removeBackground(MODEL, INPUT)

    expect(new Uint8Array(out)).toEqual(PNG_BYTES)
    expect(calls).toHaveLength(2)
    const create = calls[0] as Call
    expect(create.url).toBe(`http://replicate.test/replicate/v1/models/${MODEL}/predictions`)
    expect(create.method).toBe('POST')
    expect(create.headers.get('authorization')).toBe(`Bearer ${env.OPENAI_API_KEY}`)
    expect(create.headers.get('prefer')).toBe('wait')
    expect((create.body as { input: { image: string } }).input.image).toStartWith(
      'data:image/png;base64,',
    )
    expect(calls[1]?.headers.get('authorization')).toBeNull()
  })

  test('poll path: flat /predictions/{id} until it succeeds', async () => {
    let polls = 0
    const calls = mockFetch((call) => {
      if (call.url === DELIVERY) return new Response(PNG_BYTES)
      if (call.method === 'POST') return json({ id: 'p2', status: 'starting' })
      polls++
      return json(
        polls < 2
          ? { id: 'p2', status: 'processing' }
          : { id: 'p2', status: 'succeeded', output: [DELIVERY] },
      )
    })

    const out = await removeBackground(MODEL, INPUT, { pollIntervalMs: 1 })

    expect(new Uint8Array(out)).toEqual(PNG_BYTES)
    const pollUrls = calls.filter((c) => c.method === 'GET' && c.url !== DELIVERY).map((c) => c.url)
    expect(pollUrls).toEqual([
      'http://replicate.test/replicate/v1/predictions/p2',
      'http://replicate.test/replicate/v1/predictions/p2',
    ])
  })

  test('a failed prediction surfaces as ReplicateError with the upstream message', async () => {
    mockFetch(() => json({ id: 'p3', status: 'failed', error: 'model exploded' }))
    const err = await removeBackground(MODEL, INPUT).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ReplicateError)
    expect((err as Error).message).toContain('model exploded')
  })

  test('an output URL outside replicate.delivery is refused and never fetched', async () => {
    const calls = mockFetch(() =>
      json({ id: 'p4', status: 'succeeded', output: 'https://evil.example.com/out.png' }),
    )
    const err = await removeBackground(MODEL, INPUT).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ReplicateError)
    expect(calls).toHaveLength(1)
  })

  // Regression: recraft delivers RGBA WebP, not PNG (live 2026-10-13). A PNG-only check passed
  // every mocked test and failed the first real call.
  test('a WebP delivery is normalized to PNG', async () => {
    const webp = await sharp({
      create: { width: 4, height: 4, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
    })
      .webp({ lossless: true })
      .toBuffer()
    mockFetch((call) =>
      call.url === DELIVERY
        ? new Response(webp)
        : json({ id: 'p6', status: 'succeeded', output: DELIVERY }),
    )
    const out = await removeBackground(MODEL, INPUT)
    expect([...out.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    const meta = await sharp(out).metadata()
    expect(meta.format).toBe('png')
    expect(meta.hasAlpha).toBe(true)
  })

  test('a delivery that is neither PNG nor WebP is rejected', async () => {
    mockFetch((call) =>
      call.url === DELIVERY
        ? new Response(new Uint8Array([1, 2, 3, 4]))
        : json({ id: 'p5', status: 'succeeded', output: DELIVERY }),
    )
    await expect(removeBackground(MODEL, INPUT)).rejects.toThrow(ReplicateError)
  })

  test('a non-retryable create error becomes ReplicateError', async () => {
    mockFetch(() => json({ detail: 'nope' }, 422))
    await expect(removeBackground(MODEL, INPUT)).rejects.toThrow(ReplicateError)
  })
})
