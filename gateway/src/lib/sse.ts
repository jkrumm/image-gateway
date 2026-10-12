import type { StreamEvent, Usage } from '@image-gateway/shared'

/**
 * Upstream SSE event shapes, live-probed against our own endpoint
 * (2026-07-16). Streaming is only supported with n=1, so there's no image
 * index — and upstream may send fewer partials than requested if generation
 * finishes fast.
 */
export interface UpstreamPartialImageData {
  b64_json: string
  partial_image_index: number
  output_format?: string
}

export interface UpstreamCompletedData {
  b64_json: string
  output_format?: string
  size?: string
  quality?: string
  background?: string
  created_at?: number
  usage?: Usage
}

export interface UpstreamSSEFrame {
  event: string
  data: unknown
}

/**
 * Parse one raw SSE frame (`event: <name>\ndata: <json>`, one or more lines
 * each) into `{ event, data }`. Returns `null` for a frame missing an event
 * name, a data payload, or with unparseable JSON — callers should skip those
 * rather than fail the whole stream.
 */
export function parseSSEFrame(frameText: string): UpstreamSSEFrame | null {
  let eventName: string | undefined
  const dataLines: string[] = []

  for (const line of frameText.split('\n')) {
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim())
    }
  }

  if (!eventName || dataLines.length === 0) return null

  try {
    return { event: eventName, data: JSON.parse(dataLines.join('\n')) }
  } catch {
    return null
  }
}

/**
 * Split a raw SSE byte stream into frame texts (blocks separated by a blank
 * line). Pure I/O boundary — parsing itself lives in `parseSSEFrame`.
 */
export async function* readSSEFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let separatorIndex: number
      while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)
        if (frame.trim()) yield frame
      }
    }
    if (buffer.trim()) yield buffer
  } finally {
    reader.releaseLock()
  }
}

/**
 * Map an upstream partial-image event (`image_generation.partial_image` from
 * `/images/generations`, `image_edit.partial_image` from `/images/edits` — same
 * payload, different namespace) into our wire `partial_image` frame. Pure — the
 * only mapper that doesn't need request context (unlike `completed`, which also
 * needs routing/usage/cost).
 */
export function mapPartialImageFrame(
  data: UpstreamPartialImageData,
  fallbackFormat: 'png' | 'webp' | 'jpeg',
): StreamEvent {
  return {
    type: 'partial_image',
    partial_image_index: data.partial_image_index,
    b64_json: data.b64_json,
    format: (data.output_format as 'png' | 'webp' | 'jpeg' | undefined) ?? fallbackFormat,
  }
}
