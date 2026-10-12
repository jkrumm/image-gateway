import { Elysia } from 'elysia'
import { z } from 'zod'
import {
  errorResponseSchema,
  generateRequestSchema,
  generateResponseSchema,
  streamEventSchema,
} from '@image-gateway/shared'
import {
  routeModel,
  validateBackground,
  validateQuality,
  validateSize,
  validateTransparentFormat,
} from '../lib/routing.js'
import {
  generateImages,
  openGenerateStream,
  moderationErrorResponseSchema,
  type GenerateImagesParams,
} from '../lib/upstream.js'
import { buildResponseFromUpstream } from '../lib/response.js'
import { reportUsage, reportUsageError } from '../lib/usage.js'
import { streamImageResponse, type StreamRequestContext } from '../lib/streaming.js'
import { log } from '../lib/log.js'
import { buildUpstreamErrorBody } from '../lib/moderation-error.js'

export const generateRoutes = new Elysia().post(
  '/generate',
  async ({ body, status, set }) => {
    const { model, routed, reason } = routeModel({
      model: body.model,
      endpoint: 'generate',
      quality: body.quality,
    })

    const sizeError = validateSize(model, body.size)
    if (sizeError) {
      return status(400, { error: { message: sizeError, type: 'invalid_request_error' } })
    }

    // Business rule the request schema can't express: `transparent` is a valid
    // *value* but a legacy/non-generatable model (reachable only via a bug
    // upstream of this route) may have no alpha channel. Refuse loudly rather
    // than downgrading to opaque behind the user's back or letting upstream
    // 400 surface as a 502.
    const backgroundError = validateBackground(model, body.background)
    if (backgroundError) {
      return status(400, { error: { message: backgroundError, type: 'invalid_request_error' } })
    }

    const transparentFormatError = validateTransparentFormat(body.background, body.output_format)
    if (transparentFormatError) {
      return status(400, {
        error: { message: transparentFormatError, type: 'invalid_request_error' },
      })
    }

    const qualityError = validateQuality(model, body.quality)
    if (qualityError) {
      return status(400, { error: { message: qualityError, type: 'invalid_request_error' } })
    }

    const upstreamParams: GenerateImagesParams = {
      model,
      prompt: body.prompt,
      n: body.n,
      size: body.size,
      quality: body.quality,
      background: body.background,
      output_format: body.output_format,
      output_compression: body.output_compression,
      moderation: body.moderation,
    }

    const requestId = crypto.randomUUID()
    const t0 = performance.now()

    if (body.partial_images > 0) {
      // Marks the response as SSE for Elysia's stream handler — see
      // lib/streaming.ts for the frame contract (`data: <json>\n\n`, always
      // ending in exactly one `completed` or `error` frame). Returning the
      // async-generator instance (rather than yielding from a generator
      // handler) is what lets Elysia validate the non-streaming JSON branch
      // below at runtime — see the `response` note.
      set.headers['content-type'] = 'text/event-stream'
      const context: StreamRequestContext = {
        id: requestId,
        model,
        subTool: 'generate',
        requestedModel: body.model,
        routed,
        routingReason: reason,
        size: body.size,
        quality: body.quality,
        background: body.background,
        outputFormat: body.output_format,
        startedAt: t0,
      }
      return streamImageResponse(
        () => openGenerateStream(upstreamParams, body.partial_images),
        context,
      )
    }

    let upstream
    try {
      upstream = await generateImages(upstreamParams)
    } catch (err) {
      const errorBody = buildUpstreamErrorBody(err)
      log('generate.upstream_error', { error: errorBody.error.message, code: errorBody.error.code })
      void reportUsageError({
        requestId,
        model,
        subTool: 'generate',
        durationMs: Math.round(performance.now() - t0),
      })
      return status(502, errorBody)
    }
    const latencyMs = Math.round(performance.now() - t0)

    const response = buildResponseFromUpstream({
      id: requestId,
      model,
      requestedModel: body.model,
      routed,
      routingReason: reason,
      upstream,
      outputFormat: body.output_format,
      size: body.size,
      quality: body.quality,
      background: body.background,
      latencyMs,
    })

    void reportUsage({
      requestId: response.id,
      model,
      subTool: 'generate',
      usage: response.usage,
      cost: response.cost,
      durationMs: latencyMs,
    })

    return response
  },
  {
    body: generateRequestSchema,
    response: {
      // The handler is a plain `async` function that either returns the
      // envelope object (`partial_images === 0`) or the `streamImageResponse`
      // async-generator instance (streaming). Elysia validates a *returned
      // value* against `response[200]` only when that value does NOT have a
      // `.next` method — true for the plain object, false for the generator
      // instance — so the non-streaming path IS validated at runtime again
      // (the regression this restores), even though the declared type below
      // is a union.
      //
      // The union itself is still required, not a leftover: Elysia's
      // `InlineHandlerNonMacro` type ties a generator-returning handler's
      // accepted shape directly to `AsyncGenerator<Route['response'][200]>` —
      // there is no separate hook slot for "the type streamed frames yield"
      // distinct from `response[200]`. Since `streamImageResponse` yields
      // `StreamEvent` (not `GenerateResponse` — only its `completed` frame
      // embeds one), `response[200]` must include `StreamEvent` for
      // `AsyncGenerator<StreamEvent>` to type-check against
      // `AsyncGenerator<Route['response'][200]>`. This doesn't loosen the
      // actual runtime contract: the JSON branch only ever constructs a
      // `GenerateResponse` shape.
      200: z.union([generateResponseSchema, streamEventSchema]),
      400: errorResponseSchema,
      502: z.union([moderationErrorResponseSchema, errorResponseSchema]),
    },
    detail: {
      tags: ['Images'],
      summary: 'Generate images',
      description:
        "Generates one or more images via the upstream gpt-image model family. Validates the requested size and background against the resolved model's capabilities (a transparent background is rejected with a 400 — no generatable model has an alpha channel), calls upstream, and returns base64 images with usage/cost telemetry. When `partial_images > 0`, responds with a `text/event-stream` of `StreamEvent` frames (`partial_image`* → exactly one `completed` or `error`) instead of the JSON envelope documented here.",
      security: [{ BearerAuth: [] }],
    },
  },
)
