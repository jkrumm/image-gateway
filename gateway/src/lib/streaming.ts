import type { GenerateResponse, ImageModel, StreamEvent } from '@image-gateway/shared'
import { magicBytesValid } from './upstream.js'
import { readSSEFrames, parseSSEFrame, mapPartialImageFrame } from './sse.js'
import type { UpstreamCompletedData, UpstreamPartialImageData } from './sse.js'
import { buildResponseEnvelope, EMPTY_USAGE } from './response.js'
import { reportUsage, reportUsageError, type UsageSubTool } from './usage.js'
import { log } from './log.js'

export interface StreamRequestContext {
  id: string
  model: ImageModel
  /** Route that opened the stream — carried through so usage keeps its grouping. */
  subTool: UsageSubTool
  requestedModel: GenerateResponse['requested_model']
  routed: boolean
  routingReason?: string | undefined
  size: string
  quality: string
  background: string
  outputFormat: 'png' | 'webp' | 'jpeg'
  startedAt: number
}

function errorFrame(err: unknown): StreamEvent {
  const message = err instanceof Error ? err.message : String(err)
  return { type: 'error', error: { message, type: 'upstream_error' } }
}

/**
 * Upstream namespaces its SSE events per endpoint — `/images/generations` emits
 * `image_generation.*` while `/images/edits` emits `image_edit.*` (both verified by
 * live probe 2026-07-16). The payloads are otherwise identical, so match on the
 * suffix rather than maintaining two parallel branches.
 */
function isUpstreamEvent(
  event: string | undefined,
  suffix: 'partial_image' | 'completed',
): boolean {
  return event === `image_generation.${suffix}` || event === `image_edit.${suffix}`
}

function upstreamErrorMessage(data: unknown): string {
  const error = (data as { error?: { message?: unknown } } | null)?.error
  if (typeof error?.message === 'string') return error.message
  return `upstream stream error: ${JSON.stringify(data).slice(0, 300)}`
}

/**
 * Drive one streaming upstream request (`stream: true` + `partial_images`) to
 * completion, re-emitting our own wire `StreamEvent`s. Always ends with
 * exactly one `completed` or `error` frame — including when upstream never
 * sends a `completed` event at all, or when the final image fails the
 * magic-byte check.
 */
export async function* streamImageResponse(
  openUpstreamStream: () => Promise<Response>,
  context: StreamRequestContext,
): AsyncGenerator<StreamEvent> {
  // Every exit that isn't a `completed` frame is a failure, and each one must
  // still reach argo — otherwise `outcome` is permanently 'ok' and the error-rate
  // view shows a service that has never failed rather than one nobody measures.
  const fail = (err: unknown): StreamEvent => {
    void reportUsageError({
      requestId: context.id,
      model: context.model,
      subTool: context.subTool,
      durationMs: Math.round(performance.now() - context.startedAt),
    })
    return errorFrame(err)
  }

  let res: Response
  try {
    res = await openUpstreamStream()
  } catch (err) {
    log('stream.upstream_connect_error', {
      error: err instanceof Error ? err.message : String(err),
    })
    yield fail(err)
    return
  }

  if (!res.body) {
    yield fail(new Error('upstream returned no stream body'))
    return
  }

  try {
    for await (const frameText of readSSEFrames(res.body)) {
      const frame = parseSSEFrame(frameText)
      if (!frame) continue

      if (isUpstreamEvent(frame.event, 'partial_image')) {
        yield mapPartialImageFrame(frame.data as UpstreamPartialImageData, context.outputFormat)
        continue
      }

      // A mid-stream failure (e.g. an output-stage moderation block) arrives as
      // an `error` frame. Surface its message rather than letting the loop run
      // dry into the generic "ended without a completed event".
      if (frame.event === 'error' || frame.event.endsWith('.error')) {
        log('stream.upstream_error_frame', { event: frame.event })
        yield fail(new Error(upstreamErrorMessage(frame.data)))
        return
      }

      if (isUpstreamEvent(frame.event, 'completed')) {
        const data = frame.data as UpstreamCompletedData
        const format =
          (data.output_format as typeof context.outputFormat | undefined) ?? context.outputFormat
        const bytes = Buffer.from(data.b64_json, 'base64')
        if (!magicBytesValid(bytes, format)) {
          yield fail(new Error(`Generated image is not a valid ${format} (bad magic bytes).`))
          return
        }

        const usage = data.usage ?? EMPTY_USAGE
        const latencyMs = Math.round(performance.now() - context.startedAt)
        const response = buildResponseEnvelope({
          id: context.id,
          model: context.model,
          requestedModel: context.requestedModel,
          routed: context.routed,
          routingReason: context.routingReason,
          created: data.created_at,
          images: [{ b64_json: data.b64_json, format }],
          size: data.size ?? context.size,
          quality: data.quality ?? context.quality,
          background: data.background ?? context.background,
          usage,
          latencyMs,
        })

        void reportUsage({
          requestId: context.id,
          model: context.model,
          subTool: context.subTool,
          usage,
          cost: response.cost,
          durationMs: latencyMs,
        })

        yield { type: 'completed', response }
        return
      }
    }

    yield fail(new Error('upstream stream ended without a completed event'))
  } catch (err) {
    log('stream.error', { error: err instanceof Error ? err.message : String(err) })
    yield fail(err)
  }
}
