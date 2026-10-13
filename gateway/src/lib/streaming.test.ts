import { describe, expect, test } from 'bun:test'

// streaming.ts -> upstream.ts -> env.ts parses process.env at module load.
process.env['API_SECRET'] ??= 'test-secret'
process.env['OPENAI_BASE_URL'] ??= 'http://localhost:1'
process.env['OPENAI_API_KEY'] ??= 'test-key'

const { streamImageResponse } = await import('./streaming.js')
const { magicBytesValid } = await import('./upstream.js')

// 1x1 PNG, base64-encoded, so magic-byte validation passes.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function sseResponse(frames: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames))
      controller.close()
    },
  })
  return new Response(body)
}

const baseContext = {
  id: 'req-1',
  model: 'gpt-image-2.5-flare' as const,
  subTool: 'generate' as const,
  requestedModel: 'auto' as const,
  routed: false,
  size: '1024x1024',
  quality: 'high',
  background: 'opaque',
  outputFormat: 'png' as const,
  startedAt: performance.now(),
}

describe('streamImageResponse', () => {
  test('sanity: the fixture PNG passes magicBytesValid', () => {
    const bytes = Buffer.from(PNG_B64, 'base64')
    expect(magicBytesValid(bytes, 'png')).toBe(true)
  })

  // Regression: `/images/edits` namespaces its SSE events `image_edit.*`, not
  // `image_generation.*` (verified by live probe 2026-07-16). Matching only the
  // generations names made every streamed edit end in "no completed event".
  test("handles the edits endpoint's image_edit.* event names", async () => {
    const partial =
      'event: image_edit.partial_image\ndata: {"b64_json":"AAA=","partial_image_index":0,"output_format":"png"}'
    const completed = `event: image_edit.completed\ndata: {"b64_json":"${PNG_B64}","output_format":"png","size":"1024x1024","quality":"high","background":"opaque","created_at":1700000000,"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}`
    const res = sseResponse(`${partial}\n\n${completed}\n\n`)

    const events = []
    for await (const event of streamImageResponse(() => Promise.resolve(res), baseContext)) {
      events.push(event)
    }

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'partial_image', partial_image_index: 0 })
    expect(events[1]).toMatchObject({ type: 'completed' })
  })

  test('emits partial_image frames then one completed frame', async () => {
    const partial =
      'event: image_generation.partial_image\ndata: {"b64_json":"AAA=","partial_image_index":0,"output_format":"png"}'
    const completed = `event: image_generation.completed\ndata: {"b64_json":"${PNG_B64}","output_format":"png","size":"1024x1024","quality":"high","background":"opaque","created_at":1700000000,"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}`
    const res = sseResponse(`${partial}\n\n${completed}\n\n`)

    const events = []
    for await (const event of streamImageResponse(() => Promise.resolve(res), baseContext)) {
      events.push(event)
    }

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'partial_image', partial_image_index: 0 })
    expect(events[1]?.type).toBe('completed')
    if (events[1]?.type === 'completed') {
      expect(events[1].response.id).toBe('req-1')
      expect(events[1].response.usage.total_tokens).toBe(3)
      expect(events[1].response.images).toHaveLength(1)
    }
  })

  test('emits an error frame when the upstream connection fails', async () => {
    const events = []
    for await (const event of streamImageResponse(
      () => Promise.reject(new Error('boom')),
      baseContext,
    )) {
      events.push(event)
    }
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error' })
  })

  test('emits an error frame when the stream ends without a completed event', async () => {
    const partial =
      'event: image_generation.partial_image\ndata: {"b64_json":"AAA=","partial_image_index":0,"output_format":"png"}'
    const res = sseResponse(`${partial}\n\n`)

    const events = []
    for await (const event of streamImageResponse(() => Promise.resolve(res), baseContext)) {
      events.push(event)
    }
    expect(events.at(-1)).toMatchObject({ type: 'error' })
  })

  test('emits an error frame when the final image fails the magic-byte check', async () => {
    const completed =
      'event: image_generation.completed\ndata: {"b64_json":"bm90LWEtcG5n","output_format":"png","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}'
    const res = sseResponse(`${completed}\n\n`)

    const events = []
    for await (const event of streamImageResponse(() => Promise.resolve(res), baseContext)) {
      events.push(event)
    }
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error' })
  })
})

describe('streamImageResponse — upstream error frames', () => {
  test("surfaces an upstream `error` frame's message instead of the generic no-completed error", async () => {
    const partial =
      'event: image_generation.partial_image\ndata: {"b64_json":"AAA=","partial_image_index":0,"output_format":"png"}'
    const error =
      'event: error\ndata: {"type":"error","error":{"message":"Your request was rejected by the safety system.","code":"moderation_blocked"}}'
    const res = sseResponse(`${partial}\n\n${error}\n\n`)

    const events = []
    for await (const event of streamImageResponse(() => Promise.resolve(res), baseContext)) {
      events.push(event)
    }

    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({
      type: 'error',
      error: { message: 'Your request was rejected by the safety system.', type: 'upstream_error' },
    })
  })
})
