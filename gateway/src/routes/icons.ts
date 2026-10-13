import { Elysia } from 'elysia'
import {
  CUTOUT_PRICE_USD,
  ICONS_LIMITS,
  INPUT_IMAGE_MIME_TYPES,
  errorResponseSchema,
  iconsRequestSchema,
  iconsResponseSchema,
  type Cost,
} from '@image-gateway/shared'
import { InputError } from '../lib/cutout.js'
import { generateIcons, ICONS_HTML, ICONS_MANIFEST } from '../lib/icons.js'
import { log } from '../lib/log.js'
import { removeBackground, ReplicateError } from '../lib/replicate.js'
import { EMPTY_USAGE } from '../lib/response.js'
import { reportUsage, reportUsageError } from '../lib/usage.js'

const IMAGE_FIELD = 'image'

export const iconsRoutes = new Elysia().post(
  '/icons',
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
    if (image.size > ICONS_LIMITS.maxImageBytes) {
      return status(400, {
        error: {
          message: `image must be at most ${ICONS_LIMITS.maxImageBytes} bytes`,
          type: 'invalid_request_error',
        },
      })
    }

    const fieldsResult = iconsRequestSchema.safeParse(raw)
    if (!fieldsResult.success) {
      const message = fieldsResult.error.issues.map((issue) => issue.message).join('; ')
      return status(400, { error: { message, type: 'invalid_request_error' } })
    }
    const fields = fieldsResult.data

    const requestId = crypto.randomUUID()
    const t0 = performance.now()

    let result
    try {
      result = await generateIcons(
        new Uint8Array(await image.arrayBuffer()),
        fields,
        removeBackground,
      )
    } catch (err) {
      if (err instanceof InputError) {
        return status(400, { error: { message: err.message, type: 'invalid_request_error' } })
      }
      if (!(err instanceof ReplicateError)) throw err
      log('icons.upstream_error', { model: fields.cutout_model, error: err.message })
      void reportUsageError({
        requestId,
        model: fields.cutout_model,
        subTool: 'icons',
        durationMs: Math.round(performance.now() - t0),
      })
      return status(502, { error: { message: err.message, type: 'upstream_error' } })
    }
    const latencyMs = Math.round(performance.now() - t0)

    const cost: Cost = result.cutoutModel
      ? { usd: CUTOUT_PRICE_USD[result.cutoutModel], source: 'computed' }
      : { usd: 0, source: 'computed' }

    void reportUsage({
      requestId,
      model: result.cutoutModel ?? 'none',
      subTool: 'icons',
      usage: EMPTY_USAGE,
      cost,
      durationMs: latencyMs,
    })

    return {
      id: requestId,
      files: result.files.map((file) => ({
        name: file.name,
        mime: file.mime,
        width: file.width,
        height: file.height,
        b64: file.bytes.toString('base64'),
      })),
      html: ICONS_HTML,
      manifest: ICONS_MANIFEST,
      cutout: result.cutoutModel ? { model: result.cutoutModel, cost } : null,
      cost,
      latency_ms: latencyMs,
    }
  },
  {
    type: 'multipart/form-data',
    response: {
      200: iconsResponseSchema,
      400: errorResponseSchema,
      502: errorResponseSchema,
    },
    detail: {
      tags: ['Assets'],
      summary: 'Build a full icon set from one master image',
      description:
        'Turns one master artwork (multipart `image`, ideally square and >= 512px) into favicon.ico (16/32/48), icon-192/512 (transparent), icon-mask (maskable, opaque), apple-touch-icon (180, opaque), icon-1024 (opaque) and AppIcon.icns (macOS, all 10 iconset sizes), plus `<link>` tags and a manifest `icons` array. `background` (#rrggbb, default #ffffff) fills only the opaque targets. `cutout` is `auto` (default: remove the background only when the master has no real transparency), `always` or `never`. No SVG is produced - there is no vector source. No shadow or squircle is baked into the icns; macOS applies its own masking.',
      security: [{ BearerAuth: [] }],
    },
  },
)
