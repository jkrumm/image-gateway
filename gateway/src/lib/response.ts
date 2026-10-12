import type { Cost, GenerateResponse, ImageModel, Usage } from '@image-gateway/shared'
import { computeCost } from './pricing.js'
import type { UpstreamResponse } from './upstream.js'

export const EMPTY_USAGE: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 }

/**
 * Assemble the response envelope shared by `/generate` and `/edit`, for both
 * their non-streaming path and the final `completed` SSE frame. `model` is
 * the routed model (used for cost lookup); `requestedModel` is what the
 * caller originally asked for.
 */
export function buildResponseEnvelope(args: {
  id: string
  model: ImageModel
  requestedModel: GenerateResponse['requested_model']
  routed: boolean
  routingReason?: string | undefined
  created?: number | undefined
  images: GenerateResponse['images']
  size: string
  quality: string
  background: string
  usage: Usage
  latencyMs: number
}): GenerateResponse {
  const cost: Cost = computeCost(args.model, args.usage)

  return {
    id: args.id,
    created: args.created ?? Math.floor(Date.now() / 1000),
    model: args.model,
    requested_model: args.requestedModel,
    routed: args.routed,
    routing_reason: args.routingReason,
    images: args.images,
    size: args.size,
    quality: args.quality,
    background: args.background,
    usage: args.usage,
    cost,
    latency_ms: args.latencyMs,
  }
}

/** Build the shared envelope from an upstream non-streaming JSON response. */
export function buildResponseFromUpstream(args: {
  id: string
  model: ImageModel
  requestedModel: GenerateResponse['requested_model']
  routed: boolean
  routingReason?: string | undefined
  upstream: UpstreamResponse
  outputFormat: 'png' | 'webp' | 'jpeg'
  size: string
  quality: string
  background: string
  latencyMs: number
}): GenerateResponse {
  return buildResponseEnvelope({
    id: args.id,
    model: args.model,
    requestedModel: args.requestedModel,
    routed: args.routed,
    routingReason: args.routingReason,
    created: args.upstream.created,
    images: args.upstream.data.map((image) => ({
      b64_json: image.b64_json,
      format: args.outputFormat,
    })),
    size: args.upstream.size ?? args.size,
    quality: args.upstream.quality ?? args.quality,
    background: args.upstream.background ?? args.background,
    usage: args.upstream.usage ?? EMPTY_USAGE,
    latencyMs: args.latencyMs,
  })
}
