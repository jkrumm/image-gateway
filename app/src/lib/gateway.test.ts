/**
 * Covers `gateway.ts`'s pure, Tauri-free response-handling logic: SSE frame parsing
 * (`handleFrame`), incremental stream consumption (`consumeSseStream`, including the
 * abort-mid-read path `queue.ts`'s `cancel()` relies on), and JSON envelope parsing
 * (`parseJsonEnvelope`) against the real `PlanResponse`/`GenerateResponse` shapes. None
 * of this touches `@tauri-apps/plugin-http` — these tests prove the parsing/dispatch
 * logic, NOT that a real stream arriving over `plugin-http` in the WKWebView behaves the
 * same way. `generate`/`edit`/`plan`/`generateStream`/`editStream` themselves call the
 * Tauri `fetch` directly and are unverified here; driving the real app is the only way to
 * confirm those.
 */
import { describe, expect, test } from 'bun:test'
import { planResponseSchema, type GenerateResponse } from '@image-gateway/shared'
import { consumeSseStream, handleFrame, parseJsonEnvelope, type StreamHandlers } from './gateway'

const GENERATE_RESPONSE: GenerateResponse = {
  id: 'gen_123',
  created: 1_700_000_000,
  model: 'gpt-image-2.5-flare',
  requested_model: 'auto',
  routed: false,
  images: [{ b64_json: 'ZmFrZQ==', format: 'png' }],
  size: '1024x1024',
  quality: 'high',
  background: 'opaque',
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  cost: { usd: 0.01, source: 'computed' },
  latency_ms: 1200,
}

/** The verified `/enhance` v2 response shape from the G4a brief (live-probed 2026-07-19), with
 * `settings.model` updated for the current generatable models (`gpt-image-2.5-flare`/`sunburst`,
 * both with a real alpha channel — `background` is no longer forced to opaque). */
const PLAN_RESPONSE_FIXTURE = {
  intent: { detected: 'icon', confidence: 0.93 },
  prompt: 'a flat-design webhook delivery icon, strong silhouette',
  additions: [{ slot: 'lighting', text: 'soft diffuse light' }],
  verbatim_check: { ok: true, missing: [] },
  assumptions: ['flat design'],
  settings: {
    endpoint: 'generate',
    model: 'gpt-image-2.5-flare',
    size: '1024x1024',
    quality: 'low',
    background: 'opaque',
    n: 4,
    moderation: 'auto',
    partial_images: 1,
  },
  estimated_cost: { per_image_usd: 0.008736, total_usd: 0.034944 },
  warnings: [],
  mode_applied: 'full',
  playbook_version: '3',
  enhance_model: 'gpt-5.6',
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function streamResponseFromChunks(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status })
}

describe('handleFrame', () => {
  test('dispatches a partial_image frame to onPartial and returns undefined', () => {
    const partials: { b64_json: string; format: string; partial_image_index: number }[] = []
    const handlers: StreamHandlers = { onPartial: (frame) => partials.push(frame) }

    const result = handleFrame(
      sseFrame({
        type: 'partial_image',
        partial_image_index: 0,
        b64_json: 'ZmFrZQ==',
        format: 'png',
      }),
      handlers,
    )

    expect(result).toBeUndefined()
    expect(partials).toHaveLength(1)
    expect(partials[0]?.partial_image_index).toBe(0)
  })

  test('returns the response on a completed frame', () => {
    const handlers: StreamHandlers = { onPartial: () => {} }
    const result = handleFrame(
      sseFrame({ type: 'completed', response: GENERATE_RESPONSE }),
      handlers,
    )
    expect(result).toEqual(GENERATE_RESPONSE)
  })

  test('throws the upstream message on an error frame', () => {
    const handlers: StreamHandlers = { onPartial: () => {} }
    expect(() =>
      handleFrame(
        sseFrame({ type: 'error', error: { message: 'moderation_blocked', type: 'user_error' } }),
        handlers,
      ),
    ).toThrow('moderation_blocked')
  })

  test('rejoins a data field split across multiple `data:` lines with a real newline', () => {
    // Per SSE spec, multiple `data:` lines within one frame represent one logical value
    // joined by `\n` — model that directly rather than splitting a single-line JSON
    // string mid-token (which would just corrupt the JSON).
    const handlers: StreamHandlers = { onPartial: () => {} }
    const rawFrame = `data: {"type":"completed",\ndata: "response":${JSON.stringify(GENERATE_RESPONSE)}}`

    const result = handleFrame(rawFrame, handlers)
    expect(result).toEqual(GENERATE_RESPONSE)
  })

  test('an empty frame (no data: lines) is ignored', () => {
    const handlers: StreamHandlers = { onPartial: () => {} }
    expect(handleFrame(':heartbeat', handlers)).toBeUndefined()
  })
})

describe('consumeSseStream', () => {
  test('dispatches partials and resolves with the completed frame, across multiple chunks', async () => {
    const partials: number[] = []
    const chunks = [
      sseFrame({ type: 'partial_image', partial_image_index: 0, b64_json: 'AA==', format: 'png' }),
      sseFrame({ type: 'completed', response: GENERATE_RESPONSE }),
    ]
    const response = streamResponseFromChunks(chunks)

    const result = await consumeSseStream(response, {
      onPartial: (frame) => partials.push(frame.partial_image_index),
    })

    expect(partials).toEqual([0])
    expect(result).toEqual(GENERATE_RESPONSE)
  })

  test('reassembles a single frame split across chunk boundaries', async () => {
    const full = sseFrame({ type: 'completed', response: GENERATE_RESPONSE })
    const mid = Math.floor(full.length / 2)
    const response = streamResponseFromChunks([full.slice(0, mid), full.slice(mid)])

    const result = await consumeSseStream(response, { onPartial: () => {} })
    expect(result).toEqual(GENERATE_RESPONSE)
  })

  test('never waits for a fixed partial count — a completed frame with zero partials still resolves', async () => {
    const response = streamResponseFromChunks([
      sseFrame({ type: 'completed', response: GENERATE_RESPONSE }),
    ])
    const result = await consumeSseStream(response, { onPartial: () => {} })
    expect(result).toEqual(GENERATE_RESPONSE)
  })

  test('throws the gateway error message on a non-ok response', async () => {
    const response = new Response(
      JSON.stringify({ error: { message: 'upstream call failed', type: 'upstream_error' } }),
      { status: 502 },
    )
    await expect(consumeSseStream(response, { onPartial: () => {} })).rejects.toThrow(
      'upstream call failed',
    )
  })

  test('falls back to a status-based message when the body is JSON but not the error envelope', async () => {
    const response = new Response(JSON.stringify({ unexpected: 'shape' }), { status: 500 })
    await expect(consumeSseStream(response, { onPartial: () => {} })).rejects.toThrow(
      'Gateway request failed with status 500',
    )
  })

  test('throws when the response has no body', async () => {
    const response = new Response(null, { status: 200 })
    await expect(consumeSseStream(response, { onPartial: () => {} })).rejects.toThrow(
      'streaming response had no body',
    )
  })

  test('throws when the stream ends without a completed or error frame', async () => {
    const response = streamResponseFromChunks([
      sseFrame({ type: 'partial_image', partial_image_index: 0, b64_json: 'AA==', format: 'png' }),
    ])
    await expect(consumeSseStream(response, { onPartial: () => {} })).rejects.toThrow(
      'Gateway stream ended without a completed or error frame',
    )
  })

  test('a mid-stream error frame rejects with its message, not a stuck pending promise', async () => {
    const response = streamResponseFromChunks([
      sseFrame({ type: 'error', error: { message: 'moderation_blocked', type: 'user_error' } }),
    ])
    await expect(consumeSseStream(response, { onPartial: () => {} })).rejects.toThrow(
      'moderation_blocked',
    )
  })

  test('aborting mid-read cancels the underlying reader and rejects immediately', async () => {
    let cancelled = false
    const controller = new AbortController()
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        // Simulates a stalled network read — never resolves on its own.
        return new Promise(() => {})
      },
      cancel() {
        cancelled = true
      },
    })
    const response = new Response(stream, { status: 200 })

    const resultPromise = consumeSseStream(response, {
      onPartial: () => {},
      signal: controller.signal,
    })
    controller.abort()

    await expect(resultPromise).rejects.toThrow('Gateway stream aborted')
    expect(cancelled).toBe(true)
  })

  test('an already-aborted signal cancels immediately without issuing a read', async () => {
    const controller = new AbortController()
    controller.abort()
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const response = new Response(stream, { status: 200 })

    await expect(
      consumeSseStream(response, { onPartial: () => {}, signal: controller.signal }),
    ).rejects.toThrow('Gateway stream aborted')
    expect(cancelled).toBe(true)
  })
})

describe('parseJsonEnvelope', () => {
  test('parses a successful response through the given schema', async () => {
    const response = new Response(JSON.stringify(GENERATE_RESPONSE), { status: 200 })
    const parsed = await parseJsonEnvelope(response, {
      parse: (data) => data as GenerateResponse,
    })
    expect(parsed).toEqual(GENERATE_RESPONSE)
  })

  test('throws the gateway error message on a non-ok response', async () => {
    const response = new Response(
      JSON.stringify({ error: { message: 'invalid_request', type: 'invalid_request_error' } }),
      { status: 422 },
    )
    await expect(parseJsonEnvelope(response, { parse: (data) => data as unknown })).rejects.toThrow(
      'invalid_request',
    )
  })

  test('the real /enhance v2 fixture parses through planResponseSchema unmodified', () => {
    // Guards against contract drift between the gateway and the app: this is the exact
    // shape live-probed against the running gateway for this brief. A schema change on
    // either side that breaks this must fail loudly here, not silently in the UI.
    const parsed = planResponseSchema.parse(PLAN_RESPONSE_FIXTURE)
    expect(parsed.settings.model).toBe('gpt-image-2.5-flare')
    expect(parsed.estimated_cost.total_usd).toBeCloseTo(0.034944)
    expect(parsed.mode_applied).toBe('full')
  })

  test('a plan naming a retired model is rejected rather than driving an unservable request', () => {
    // gpt-image-1.5 can still appear in a historical sidecar, but never in a plan for a NEW
    // generation — the studio has no way to serve it.
    expect(() =>
      planResponseSchema.parse({
        ...PLAN_RESPONSE_FIXTURE,
        settings: { ...PLAN_RESPONSE_FIXTURE.settings, model: 'gpt-image-1.5' },
      }),
    ).toThrow()
  })
})
