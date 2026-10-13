import { Elysia } from 'elysia'
import sharp from 'sharp'
import {
  CUTOUT_LIMITS,
  CUTOUT_PRICE_USD,
  INPUT_IMAGE_MIME_TYPES,
  cutoutRequestSchema,
  cutoutResponseSchema,
  errorResponseSchema,
} from '@image-gateway/shared'
import { InputError, prepareCutoutInput } from '../lib/cutout.js'
import { log } from '../lib/log.js'
import { removeBackground, ReplicateError } from '../lib/replicate.js'
import { EMPTY_USAGE } from '../lib/response.js'
import { reportUsage, reportUsageError } from '../lib/usage.js'

const IMAGE_FIELD = 'image'

export const cutoutRoutes = new Elysia().post(
  '/cutout',
  async ({ body, status }) => {
    const raw = body as Record<string, unknown>
    const image = raw[IMAGE_FIELD]

    if (!(image instanceof File)) {
      return status(400, {
        error: { message: 'an `image` file is required', type: 'invalid_request_error' },
      })
    }
    if (!(INPUT_IMAGE_MIME_TYPES as readonly string[]).includes(image.type)) {
      return status(400, {
        error: {
          message: `image must be one of: ${INPUT_IMAGE_MIME_TYPES.join(', ')}`,
          type: 'invalid_request_error',
        },
      })
    }
    if (image.size > CUTOUT_LIMITS.maxImageBytes) {
      return status(400, {
        error: {
          message: `image must be at most ${CUTOUT_LIMITS.maxImageBytes} bytes`,
          type: 'invalid_request_error',
        },
      })
    }

    const fieldsResult = cutoutRequestSchema.safeParse(raw)
    if (!fieldsResult.success) {
      const message = fieldsResult.error.issues.map((issue) => issue.message).join('; ')
      return status(400, { error: { message, type: 'invalid_request_error' } })
    }
    const { model } = fieldsResult.data

    let input: Buffer
    try {
      input = await prepareCutoutInput(new Uint8Array(await image.arrayBuffer()))
    } catch (err) {
      if (!(err instanceof InputError)) throw err
      return status(400, { error: { message: err.message, type: 'invalid_request_error' } })
    }

    const requestId = crypto.randomUUID()
    const t0 = performance.now()

    let output: Buffer
    try {
      output = await removeBackground(model, input)
    } catch (err) {
      if (!(err instanceof ReplicateError)) throw err
      log('cutout.upstream_error', { model, error: err.message })
      void reportUsageError({
        requestId,
        model,
        subTool: 'cutout',
        durationMs: Math.round(performance.now() - t0),
      })
      return status(502, { error: { message: err.message, type: 'upstream_error' } })
    }
    const latencyMs = Math.round(performance.now() - t0)

    const { width, height } = await sharp(output).metadata()
    const cost = { usd: CUTOUT_PRICE_USD[model], source: 'computed' as const }

    void reportUsage({
      requestId,
      model,
      subTool: 'cutout',
      usage: EMPTY_USAGE,
      cost,
      durationMs: latencyMs,
    })

    return {
      id: requestId,
      model,
      image: { b64_json: output.toString('base64'), format: 'png' as const },
      width,
      height,
      cost,
      latency_ms: latencyMs,
    }
  },
  {
    type: 'multipart/form-data',
    response: {
      200: cutoutResponseSchema,
      400: errorResponseSchema,
      502: errorResponseSchema,
    },
    detail: {
      tags: ['Assets'],
      summary: 'Remove an image background',
      description:
        'Removes the background of one image (multipart `image`, png/jpeg/webp, 5 MB max, sides 256-4096 px, 16 MP max) via a Replicate model on the IU proxy. `model` is `recraft-ai/recraft-remove-background` (default: $0.01, keeps resolution) or `bria/remove-background` ($0.018, may downscale to 1024px). Returns an RGBA PNG with a near-binary matte; the recraft model can leave the "transparent" background at alpha=1 rather than 0, so threshold alpha before relying on it.',
      security: [{ BearerAuth: [] }],
    },
  },
)
