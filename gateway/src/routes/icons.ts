import { Elysia } from 'elysia'
import {
  ICONS_LIMITS,
  INPUT_IMAGE_MIME_TYPES,
  errorResponseSchema,
  iconsRequestSchema,
  iconsResponseSchema,
  type Cost,
  type IconStep,
} from '@image-gateway/shared'
import { InputError } from '../lib/cutout.js'
import { generateIcons, iconsHtml, ICONS_MANIFEST, StepFailure } from '../lib/icons.js'
import { log } from '../lib/log.js'
import { removeBackground, upscale, vectorize } from '../lib/replicate.js'
import { EMPTY_USAGE } from '../lib/response.js'
import { reportUsage, reportUsageError } from '../lib/usage.js'

const IMAGE_FIELD = 'image'

const RUNNERS = { removeBackground, upscale, vectorize }

function reportSteps(requestId: string, steps: IconStep[]): void {
  for (const step of steps) {
    void reportUsage({
      requestId,
      sourceId: `${requestId}:${step.step}`,
      model: step.model,
      subTool: 'icons',
      usage: EMPTY_USAGE,
      cost: { usd: step.cost_usd, source: 'computed' },
      durationMs: step.latency_ms,
    })
  }
}

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
      result = await generateIcons(new Uint8Array(await image.arrayBuffer()), fields, RUNNERS)
    } catch (err) {
      if (err instanceof InputError) {
        return status(400, { error: { message: err.message, type: 'invalid_request_error' } })
      }
      if (!(err instanceof StepFailure)) throw err
      const { failed, completed } = err
      log('icons.upstream_error', { step: failed.step, model: failed.model, error: err.message })
      // One argo record per Replicate step: those that ran (their spend is real), then the failure.
      reportSteps(requestId, completed)
      void reportUsageError({
        requestId,
        sourceId: `${requestId}:${failed.step}`,
        model: failed.model,
        subTool: 'icons',
        durationMs: failed.latency_ms,
      })
      return status(502, { error: { message: err.message, type: 'upstream_error' } })
    }
    const latencyMs = Math.round(performance.now() - t0)

    const cost: Cost = {
      usd: result.steps.reduce((sum, step) => sum + step.cost_usd, 0),
      source: 'computed',
    }

    if (result.steps.length > 0) {
      reportSteps(requestId, result.steps)
    } else {
      void reportUsage({
        requestId,
        model: 'none',
        subTool: 'icons',
        usage: EMPTY_USAGE,
        cost,
        durationMs: latencyMs,
      })
    }

    return {
      id: requestId,
      files: result.files.map((file) => ({
        name: file.name,
        mime: file.mime,
        width: file.width,
        height: file.height,
        b64: file.bytes.toString('base64'),
      })),
      html: iconsHtml(result.files.some((file) => file.name === 'favicon.svg')),
      manifest: ICONS_MANIFEST,
      steps: result.steps,
      ...(result.svgSkippedReason ? { svg_skipped_reason: result.svgSkippedReason } : {}),
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
        'Turns one master artwork (multipart `image`, png/jpeg/webp) into favicon.ico (16/32/48), favicon.svg, icon-192/512 (transparent), icon-mask (maskable, opaque), apple-touch-icon (180, opaque), icon-1024 (opaque) and AppIcon.icns (macOS, all 10 iconset sizes), plus `<link>` tags and a manifest `icons` array. `background` (#rrggbb, default #ffffff) fills only the opaque targets. Replicate steps, in order: `upscale` (real-esrgan, $0.002; `auto` runs when the long edge is under 512 px, 4x or 8x under 128 px; `always` accepts at most 1440 px; `never`), `cutout` (`auto` removes the background only when the master has no real transparency; `always`; `never`; needs sides >= 256 px, hence the upscale first), and `svg` (`auto`, recraft-vectorize, $0.01, or `never`). favicon.svg is omitted, with `svg_skipped_reason` set, when the optimized SVG exceeds 64 KB (gradient or photographic art). `steps` lists only the steps that ran; `cost` is their total. No shadow or squircle is baked into the icns; macOS applies its own masking.',
      security: [{ BearerAuth: [] }],
    },
  },
)
