import sharp from 'sharp'
import { env } from '../env.js'
import type { CutoutModel } from '@image-gateway/shared'
import { log } from './log.js'
import { magicBytesValid, requestWithRetry } from './upstream.js'

/**
 * Replicate lane: background removal through the IU proxy's `/replicate/v1` route (same bearer as
 * the OpenAI upstream). The flow is "create prediction with `Prefer: wait`, poll only if it is
 * still running, fetch the `replicate.delivery` output". Mirrors audio-gateway's replicate-tts.ts.
 * This module owns ALL Replicate I/O.
 */

const CREATE_TIMEOUT_MS = 90_000
const POLL_INTERVAL_MS = 1_000
const POLL_DEADLINE_MS = 60_000
const DELIVERY_TIMEOUT_MS = 30_000

/** Any Replicate-side failure (create/poll/failed status/delivery) — routes map it to a 502. */
export class ReplicateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplicateError'
  }
}

/**
 * The Replicate base: an explicit override wins, otherwise the OpenAI base with its trailing
 * `/openai/v1` swapped for `/replicate/v1`. Refuses to guess when the base has no such suffix.
 */
export function resolveReplicateBase(openaiBaseUrl: string, override?: string): string {
  if (override) return override.replace(/\/+$/, '')
  const suffix = /\/openai\/v1\/?$/
  if (!suffix.test(openaiBaseUrl)) {
    throw new ReplicateError(
      'Cannot derive the Replicate base URL: OPENAI_BASE_URL does not end in /openai/v1 and REPLICATE_BASE_URL is unset',
    )
  }
  return openaiBaseUrl.replace(suffix, '/replicate/v1')
}

const replicateUrl = (path: string): string =>
  `${resolveReplicateBase(env.OPENAI_BASE_URL, env.REPLICATE_BASE_URL)}${path}`

const authHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  Authorization: `Bearer ${env.OPENAI_API_KEY}`,
  ...extra,
})

interface Prediction {
  id?: string
  status: string
  output?: string | string[] | null
  error?: string | null
}

const isRunning = (status: string): boolean => status === 'starting' || status === 'processing'

/** Replicate serves prediction output from its own CDN only; anything else is refused. */
export function isReplicateDeliveryUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'replicate.delivery' || url.hostname.endsWith('.replicate.delivery'))
    )
  } catch {
    return false
  }
}

async function createPrediction(
  model: string,
  input: Record<string, unknown>,
): Promise<Prediction> {
  let res: Response
  try {
    res = await requestWithRetry(
      replicateUrl(`/models/${model}/predictions`),
      {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json', Prefer: 'wait' }),
        body: JSON.stringify({ input }),
      },
      { timeoutMs: CREATE_TIMEOUT_MS },
    )
  } catch (err) {
    throw new ReplicateError(
      `Replicate create failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return (await res.json()) as Prediction
}

async function pollPrediction(id: string, pollIntervalMs: number): Promise<Prediction> {
  const deadline = Date.now() + POLL_DEADLINE_MS
  while (Date.now() < deadline) {
    await Bun.sleep(pollIntervalMs)
    // Flat path keyed by prediction id — deliberately NOT the `urls.get` the API returns, which
    // points at the public Replicate host rather than the proxy.
    const res = await fetch(replicateUrl(`/predictions/${id}`), {
      method: 'GET',
      headers: authHeaders(),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ReplicateError(`Replicate poll failed (${res.status}): ${text.slice(0, 300)}`)
    }
    const prediction = (await res.json()) as Prediction
    if (!isRunning(prediction.status)) return prediction
  }
  throw new ReplicateError(`Replicate prediction ${id} timed out after ${POLL_DEADLINE_MS}ms`)
}

async function fetchDelivery(prediction: Prediction): Promise<Buffer> {
  const url = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output
  if (!url) throw new ReplicateError('Replicate prediction succeeded with no output URL')
  if (!isReplicateDeliveryUrl(url)) {
    throw new ReplicateError('Replicate output URL is not a replicate.delivery URL')
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) })
  if (!res.ok) throw new ReplicateError(`Failed to fetch Replicate output (${res.status})`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (magicBytesValid(bytes, 'png')) return bytes
  // recraft delivers RGBA WebP, not PNG (live-probed 2026-10-13); bria delivers PNG. Normalize so
  // every caller gets the PNG this module promises.
  if (magicBytesValid(bytes, 'webp')) return sharp(bytes).png().toBuffer()
  throw new ReplicateError('Replicate output is neither PNG nor WebP (bad magic bytes)')
}

/**
 * Remove the background of a PNG with `model`; returns the RGBA PNG. Throws `ReplicateError` on
 * every upstream failure, never a bare `Error`.
 */
export async function removeBackground(
  model: CutoutModel,
  png: Uint8Array,
  options: { pollIntervalMs?: number } = {},
): Promise<Buffer> {
  const dataUri = `data:image/png;base64,${Buffer.from(png).toString('base64')}`
  let prediction = await createPrediction(model, { image: dataUri })

  if (isRunning(prediction.status)) {
    if (!prediction.id) throw new ReplicateError('Replicate prediction missing id for polling')
    log('replicate.poll', { model, predictionId: prediction.id })
    prediction = await pollPrediction(prediction.id, options.pollIntervalMs ?? POLL_INTERVAL_MS)
  }
  if (prediction.status !== 'succeeded') {
    throw new ReplicateError(
      `Replicate prediction ${prediction.status}: ${prediction.error ?? 'unknown error'}`,
    )
  }
  return fetchDelivery(prediction)
}
