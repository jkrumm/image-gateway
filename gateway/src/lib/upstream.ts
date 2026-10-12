import { z } from 'zod'
import { env } from '../env.js'
import type { EditRequest, GenerateRequest, ImageModel, Usage } from '@image-gateway/shared'

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const RETRY_ATTEMPTS = 3
const REQUEST_TIMEOUT_MS = 180_000

/** Moderation-block shape passed through from the upstream 503-wrapped error (Round 3 probe). */
export interface ModerationDetails {
  moderation_stage: string
  categories: string[]
}

/** Response schema for a moderation-augmented error body — a superset of `errorResponseSchema`. */
export const moderationErrorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    code: z.string(),
    moderation_details: z.object({
      moderation_stage: z.string(),
      categories: z.array(z.string()),
    }),
  }),
})

/**
 * Thrown for a vendor-wrapped 400-class user error (the 503 with `user_error`
 * in the body). Carries the extracted `code` and, when the error is a
 * moderation block, `moderationDetails` — so callers can surface
 * `moderation_stage`/`categories` without re-parsing the raw body.
 */
export class UpstreamUserError extends Error {
  readonly code: string | undefined
  readonly moderationDetails: ModerationDetails | undefined

  constructor(params: { message: string; code?: string; moderationDetails?: ModerationDetails }) {
    super(params.message)
    this.name = 'UpstreamUserError'
    this.code = params.code
    this.moderationDetails = params.moderationDetails
  }
}

/**
 * True for either shape the vendor proxy uses to wrap a 400-class validation
 * error inside a 503: the historical `user_error` substring (e.g.
 * `image_generation_user_error`, `moderation_blocked`), and the
 * `gpt-image-2.5-flare/sunburst`-era shape probed 2026-09-23 — a body
 * prefixed `[OpenAI Vendor Group Key StatusCode: BadRequest]` whose embedded
 * JSON carries `"type":"invalid_request_error"` with NO `user_error`
 * substring at all. Both must never be retried — retrying a request that will
 * always fail the same way just burns three attempts and ~3.5s before
 * reporting the same error anyway.
 */
export function isWrappedUserErrorBody(text: string): boolean {
  if (text.includes('user_error')) return true
  return text.includes('StatusCode: BadRequest') && text.includes('"invalid_request_error"')
}

/**
 * Extract the JSON object embedded in the vendor proxy's 503-wrapped
 * 400-class error body. The body is a STRING with a
 * `[OpenAI Vendor Group Key StatusCode: BadRequest] ` prefix before the JSON
 * (docs/research/endpoint-verification.md Round 3) — slice from the first
 * `{` rather than parsing the body directly. Falls back to a generic
 * `UpstreamUserError` (no code/moderationDetails) when the body doesn't
 * contain a parseable embedded object.
 */
export function parseWrappedUserError(text: string): UpstreamUserError {
  const fallback = new UpstreamUserError({
    message: `Upstream request failed: ${text.slice(0, 300)}`,
  })

  const jsonStart = text.indexOf('{')
  if (jsonStart === -1) return fallback

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(jsonStart))
  } catch {
    return fallback
  }

  const error = (parsed as { error?: Record<string, unknown> } | null)?.error
  if (!error || typeof error !== 'object') return fallback

  const code = typeof error['code'] === 'string' ? error['code'] : undefined
  const message = typeof error['message'] === 'string' ? error['message'] : fallback.message

  const rawDetails = error['moderation_details']
  let moderationDetails: ModerationDetails | undefined
  if (rawDetails && typeof rawDetails === 'object') {
    const stage = (rawDetails as Record<string, unknown>)['moderation_stage']
    const categories = (rawDetails as Record<string, unknown>)['categories']
    if (typeof stage === 'string' && Array.isArray(categories)) {
      moderationDetails = {
        moderation_stage: stage,
        categories: categories.filter(
          (category): category is string => typeof category === 'string',
        ),
      }
    }
  }

  return new UpstreamUserError({
    message,
    ...(code !== undefined ? { code } : {}),
    ...(moderationDetails !== undefined ? { moderationDetails } : {}),
  })
}

export interface UpstreamImage {
  b64_json: string
}

export interface UpstreamResponse {
  created?: number
  data: UpstreamImage[]
  usage?: Usage
  size?: string
  quality?: string
  background?: string
}

export interface GenerateImagesParams {
  model: ImageModel
  prompt: string
  n: number
  size: string
  quality: GenerateRequest['quality']
  background?: GenerateRequest['background']
  output_format?: GenerateRequest['output_format']
  output_compression?: number | undefined
  moderation?: GenerateRequest['moderation']
}

export interface EditImagesParams {
  model: ImageModel
  prompt: string
  n: number
  size: string
  quality: EditRequest['quality']
  background?: EditRequest['background']
  output_format?: EditRequest['output_format']
  output_compression?: number | undefined
  moderation?: EditRequest['moderation']
  input_fidelity?: EditRequest['input_fidelity']
  images: File[]
  mask?: File | undefined
}

/** Decode base64 header bytes only and check the magic bytes for the requested format. */
export function magicBytesValid(bytes: Uint8Array, format: string): boolean {
  switch (format) {
    case 'png':
      return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    case 'jpeg':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    case 'webp':
      return (
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 && // "RIFF"
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50 // "WEBP"
      )
    default:
      return false
  }
}

function validateImages(images: UpstreamImage[], format: string): void {
  for (const image of images) {
    const bytes = Buffer.from(image.b64_json, 'base64')
    if (!magicBytesValid(bytes, format)) {
      throw new Error(`Generated image is not a valid ${format} (bad magic bytes).`)
    }
  }
}

/**
 * POST to an upstream image endpoint with retry. Retries on 429/5xx and
 * network errors (3 attempts, backoff 0.5s * 3^i); a 410 (deprecated model)
 * fails fast with no retry. The upstream vendor proxy wraps some 400-class
 * validation failures in a 503 — either the historical shape (e.g.
 * "Transparent background is not supported", `moderation_blocked`, with
 * `"type": "..._user_error"` in the body) or the `gpt-image-2.5` shape (a
 * `StatusCode: BadRequest`-prefixed body with `"type":"invalid_request_error"`
 * and no `user_error` substring at all) — see `isWrappedUserErrorBody`. Both
 * are never retried, and throw `UpstreamUserError` (carrying
 * `code`/`moderationDetails` when present) instead of a plain `Error`.
 * Returns the raw (ok) `Response` un-consumed so callers can either
 * `.json()` it or stream its body. Exported for reuse by other upstream
 * callers on the same vendor proxy (e.g. `lib/enhance.ts`'s
 * `/chat/completions` call) so retry/503-user_error handling isn't
 * duplicated.
 *
 * `timeoutMs` defaults to the image-endpoint guard (`REQUEST_TIMEOUT_MS`);
 * callers on a slower upstream (e.g. `lib/enhance.ts`'s reasoning-heavy
 * `/chat/completions` call) pass a longer one explicitly rather than this
 * function's default changing under every caller at once.
 */
export async function requestWithRetry(
  url: string,
  init: RequestInit,
  options: { timeoutMs?: number } = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  let lastErr: Error | undefined

  for (let i = 0; i < RETRY_ATTEMPTS; i++) {
    let res: Response
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      if (i < RETRY_ATTEMPTS - 1) {
        await Bun.sleep(500 * 3 ** i)
        continue
      }
      throw lastErr
    }

    if (res.ok) return res

    const text = await res.text().catch(() => '')
    if (res.status === 410) {
      throw new Error(
        `Model deprecated (410). Use a current model (gpt-image-{1,1-mini,1.5,2}). Detail: ${text.slice(0, 200)}`,
      )
    }
    const isWrappedUserError = isWrappedUserErrorBody(text)
    if (RETRYABLE_STATUS.has(res.status) && !isWrappedUserError && i < RETRY_ATTEMPTS - 1) {
      lastErr = new Error(`Upstream ${res.status}: ${text.slice(0, 200)}`)
      await Bun.sleep(500 * 3 ** i)
      continue
    }
    if (isWrappedUserError) throw parseWrappedUserError(text)
    throw new Error(`Upstream request failed (${res.status}): ${text.slice(0, 300)}`)
  }

  throw lastErr ?? new Error('Upstream request failed after retries')
}

function buildGenerateBody(
  params: GenerateImagesParams,
  extra?: { stream: true; partial_images: number },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    prompt: params.prompt,
    n: params.n,
    size: params.size,
    quality: params.quality,
  }
  if (params.background !== undefined) body['background'] = params.background
  if (params.output_format !== undefined) body['output_format'] = params.output_format
  if (params.output_compression !== undefined)
    body['output_compression'] = params.output_compression
  if (params.moderation !== undefined) body['moderation'] = params.moderation
  if (extra) {
    body['stream'] = extra.stream
    body['partial_images'] = extra.partial_images
  }
  return body
}

function generateUrl(): string {
  const base = env.OPENAI_BASE_URL.replace(/\/$/, '')
  return `${base}/images/generations`
}

/** Call the upstream `/images/generations` endpoint. Every returned image is magic-byte checked against the requested output format. */
export async function generateImages(params: GenerateImagesParams): Promise<UpstreamResponse> {
  const res = await requestWithRetry(generateUrl(), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildGenerateBody(params)),
  })
  const data = (await res.json()) as UpstreamResponse
  validateImages(data.data ?? [], params.output_format ?? 'png')
  return data
}

/**
 * Open a streaming `/images/generations` request (`stream: true` +
 * `partial_images`). Returns the raw upstream `Response`; the caller reads
 * its SSE body (see `lib/sse.ts` / `lib/streaming.ts`).
 */
export async function openGenerateStream(
  params: GenerateImagesParams,
  partialImages: number,
): Promise<Response> {
  return requestWithRetry(generateUrl(), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(
      buildGenerateBody(params, { stream: true, partial_images: partialImages }),
    ),
  })
}

function editUrl(): string {
  const base = env.OPENAI_BASE_URL.replace(/\/$/, '')
  return `${base}/images/edits`
}

/**
 * Build the multipart form for `/images/edits`. Multiple reference images use
 * the repeated `image[]` field (verified working with 2 refs); exactly one
 * image uses the plain `image` field.
 */
function buildEditForm(
  params: EditImagesParams,
  extra?: { stream: true; partial_images: number },
): FormData {
  const form = new FormData()
  form.append('model', params.model)
  form.append('prompt', params.prompt)
  form.append('n', String(params.n))
  form.append('size', params.size)
  form.append('quality', params.quality)
  if (params.background !== undefined) form.append('background', params.background)
  if (params.output_format !== undefined) form.append('output_format', params.output_format)
  if (params.output_compression !== undefined) {
    form.append('output_compression', String(params.output_compression))
  }
  if (params.moderation !== undefined) form.append('moderation', params.moderation)
  if (params.input_fidelity !== undefined) form.append('input_fidelity', params.input_fidelity)

  const imageField = params.images.length > 1 ? 'image[]' : 'image'
  for (const image of params.images) form.append(imageField, image)
  if (params.mask !== undefined) form.append('mask', params.mask)

  if (extra) {
    form.append('stream', String(extra.stream))
    form.append('partial_images', String(extra.partial_images))
  }
  return form
}

/**
 * Call the upstream `/images/edits` endpoint (multipart). No `content-type`
 * header is set — the runtime derives the multipart boundary from the
 * `FormData` body. Every returned image is magic-byte checked against the
 * requested output format.
 */
export async function editImages(params: EditImagesParams): Promise<UpstreamResponse> {
  const res = await requestWithRetry(editUrl(), {
    method: 'POST',
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: buildEditForm(params),
  })
  const data = (await res.json()) as UpstreamResponse
  validateImages(data.data ?? [], params.output_format ?? 'png')
  return data
}

/**
 * Open a streaming `/images/edits` request. Returns the raw upstream
 * `Response`; the caller reads its SSE body.
 */
export async function openEditStream(
  params: EditImagesParams,
  partialImages: number,
): Promise<Response> {
  return requestWithRetry(editUrl(), {
    method: 'POST',
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: buildEditForm(params, { stream: true, partial_images: partialImages }),
  })
}
