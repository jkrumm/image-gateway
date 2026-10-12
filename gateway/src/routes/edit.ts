import { Elysia } from 'elysia'
import { z } from 'zod'
import {
  EDIT_LIMITS,
  INPUT_IMAGE_MIME_TYPES,
  editRequestSchema,
  editResponseSchema,
  errorResponseSchema,
  streamEventSchema,
} from '@image-gateway/shared'
import {
  routeModel,
  validateBackground,
  validateInputFidelity,
  validateQuality,
  validateSize,
  validateTransparentFormat,
} from '../lib/routing.js'
import {
  editImages,
  openEditStream,
  moderationErrorResponseSchema,
  type EditImagesParams,
} from '../lib/upstream.js'
import { buildResponseFromUpstream } from '../lib/response.js'
import { reportUsage, reportUsageError } from '../lib/usage.js'
import { streamImageResponse, type StreamRequestContext } from '../lib/streaming.js'
import { log } from '../lib/log.js'
import { buildUpstreamErrorBody } from '../lib/moderation-error.js'

/**
 * Multipart field names for reference images / mask. Mirrors the upstream
 * convention (`image[]`, `mask`) — see PRD.md Phase 2. A lone `image` part is
 * also accepted as a convenience for the single-image case.
 */
const IMAGE_FIELD = 'image[]'
const IMAGE_FIELD_SINGULAR = 'image'
const MASK_FIELD = 'mask'

function extractFiles(raw: Record<string, unknown>): File[] {
  const files: File[] = []
  for (const key of [IMAGE_FIELD, IMAGE_FIELD_SINGULAR]) {
    const value = raw[key]
    if (Array.isArray(value))
      files.push(...value.filter((entry): entry is File => entry instanceof File))
    else if (value instanceof File) files.push(value)
  }
  return files
}

function extractMask(raw: Record<string, unknown>): File | undefined {
  const value = raw[MASK_FIELD]
  return value instanceof File ? value : undefined
}

export const editRoutes = new Elysia().post(
  '/edit',
  async ({ body, status, set }) => {
    const raw = body as Record<string, unknown>
    const images = extractFiles(raw)
    const mask = extractMask(raw)

    if (images.length === 0) {
      return status(400, {
        error: {
          message: 'at least one reference image is required',
          type: 'invalid_request_error',
        },
      })
    }
    if (images.length > EDIT_LIMITS.maxImages) {
      return status(400, {
        error: {
          message: `at most ${EDIT_LIMITS.maxImages} reference images are allowed`,
          type: 'invalid_request_error',
        },
      })
    }
    for (const image of images) {
      if (image.size > EDIT_LIMITS.maxImageBytes) {
        return status(400, {
          error: {
            message: `each reference image must be at most ${EDIT_LIMITS.maxImageBytes} bytes`,
            type: 'invalid_request_error',
          },
        })
      }
      if (!(INPUT_IMAGE_MIME_TYPES as readonly string[]).includes(image.type)) {
        return status(400, {
          error: {
            message: `reference images must be one of: ${INPUT_IMAGE_MIME_TYPES.join(', ')}`,
            type: 'invalid_request_error',
          },
        })
      }
    }
    if (mask !== undefined) {
      if (mask.size > EDIT_LIMITS.maxMaskBytes) {
        return status(400, {
          error: {
            message: `mask must be at most ${EDIT_LIMITS.maxMaskBytes} bytes`,
            type: 'invalid_request_error',
          },
        })
      }
      if (mask.type !== 'image/png') {
        return status(400, {
          error: {
            message: 'mask must be image/png (needs an alpha channel)',
            type: 'invalid_request_error',
          },
        })
      }
    }

    const fieldsResult = editRequestSchema.safeParse(raw)
    if (!fieldsResult.success) {
      const message = fieldsResult.error.issues.map((issue) => issue.message).join('; ')
      return status(400, { error: { message, type: 'invalid_request_error' } })
    }
    const fields = fieldsResult.data

    const { model, routed, reason } = routeModel({
      model: fields.model,
      endpoint: 'edit',
      quality: fields.quality,
    })

    const sizeError = validateSize(model, fields.size)
    if (sizeError) {
      return status(400, { error: { message: sizeError, type: 'invalid_request_error' } })
    }

    // See generate.ts: `transparent` is a schema-valid value that a legacy
    // model may reject, so it is a business-rule 400, not a 422.
    const backgroundError = validateBackground(model, fields.background)
    if (backgroundError) {
      return status(400, { error: { message: backgroundError, type: 'invalid_request_error' } })
    }

    const transparentFormatError = validateTransparentFormat(
      fields.background,
      fields.output_format,
    )
    if (transparentFormatError) {
      return status(400, {
        error: { message: transparentFormatError, type: 'invalid_request_error' },
      })
    }

    const qualityError = validateQuality(model, fields.quality)
    if (qualityError) {
      return status(400, { error: { message: qualityError, type: 'invalid_request_error' } })
    }

    const fidelityError = validateInputFidelity(model, fields.input_fidelity)
    if (fidelityError) {
      return status(400, { error: { message: fidelityError, type: 'invalid_request_error' } })
    }

    const upstreamParams: EditImagesParams = {
      model,
      prompt: fields.prompt,
      n: fields.n,
      size: fields.size,
      quality: fields.quality,
      background: fields.background,
      output_format: fields.output_format,
      output_compression: fields.output_compression,
      moderation: fields.moderation,
      input_fidelity: fields.input_fidelity,
      images,
      mask,
    }

    const requestId = crypto.randomUUID()
    const t0 = performance.now()

    if (fields.partial_images > 0) {
      set.headers['content-type'] = 'text/event-stream'
      const context: StreamRequestContext = {
        id: requestId,
        model,
        subTool: 'edit',
        requestedModel: fields.model,
        routed,
        routingReason: reason,
        size: fields.size,
        quality: fields.quality,
        background: fields.background,
        outputFormat: fields.output_format,
        startedAt: t0,
      }
      return streamImageResponse(
        () => openEditStream(upstreamParams, fields.partial_images),
        context,
      )
    }

    let upstream
    try {
      upstream = await editImages(upstreamParams)
    } catch (err) {
      const errorBody = buildUpstreamErrorBody(err)
      log('edit.upstream_error', { error: errorBody.error.message, code: errorBody.error.code })
      void reportUsageError({
        requestId,
        model,
        subTool: 'edit',
        durationMs: Math.round(performance.now() - t0),
      })
      return status(502, errorBody)
    }
    const latencyMs = Math.round(performance.now() - t0)

    const response = buildResponseFromUpstream({
      id: requestId,
      model,
      requestedModel: fields.model,
      routed,
      routingReason: reason,
      upstream,
      outputFormat: fields.output_format,
      size: fields.size,
      quality: fields.quality,
      background: fields.background,
      latencyMs,
    })

    void reportUsage({
      requestId: response.id,
      model,
      subTool: 'edit',
      usage: response.usage,
      cost: response.cost,
      durationMs: latencyMs,
    })

    return response
  },
  {
    type: 'multipart/form-data',
    response: {
      // See generate.ts for why this is a union: it's required by Elysia's
      // `AsyncGenerator<Route['response'][200]>` handler typing, not chosen
      // for convenience. Runtime validation of the non-streaming JSON path is
      // still restored (Elysia only skips `response[200]` validation for
      // returned values with a `.next` method, i.e. the generator instance).
      200: z.union([editResponseSchema, streamEventSchema]),
      400: errorResponseSchema,
      502: z.union([moderationErrorResponseSchema, errorResponseSchema]),
    },
    detail: {
      tags: ['Images'],
      summary: 'Edit / inpaint images',
      description:
        "Edits or inpaints via the upstream gpt-image model family's `/images/edits` endpoint (multipart). Up to 16 reference images (`image[]`, or `image` for a single one) plus an optional alpha-PNG mask (`mask`), alongside the same fields as `/generate`. Validates image/mask count, size, and mime type, then the resolved model's size, `background`, and `input_fidelity` support, before calling upstream. Returns the same envelope as `/generate`. When `partial_images > 0`, responds with a `text/event-stream` instead.",
      security: [{ BearerAuth: [] }],
    },
  },
)
