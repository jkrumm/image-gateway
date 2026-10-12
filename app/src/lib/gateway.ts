import {
  editRequestSchema,
  editResponseSchema,
  errorResponseSchema,
  generateRequestSchema,
  generateResponseSchema,
  planRequestSchema,
  planResponseSchema,
  streamEventSchema,
  type EditRequestInput,
  type EditResponse,
  type GenerateRequestInput,
  type GenerateResponse,
  type PlanRequestInput,
  type PlanResponse,
} from '@image-gateway/shared'
import { fetch } from '@tauri-apps/plugin-http'
import type { ServiceConnection } from './settings'

/**
 * Calls the image-gateway's `POST /generate` and `POST /edit`. Uses
 * `@tauri-apps/plugin-http`'s `fetch` (routed through the Rust client) instead of the
 * webview's `fetch`, so the tailnet-only gateway host isn't subject to WKWebView CORS
 * restrictions. Verified against the installed plugin's source (2.5.9): the response
 * body is a genuine pull-based `ReadableStream` backed by chunked IPC reads
 * (`plugin:http|fetch_read_body` per `pull()`), not a buffered blob — so SSE streaming
 * below reads real incremental chunks, not one giant final read.
 */

/** Files attached to `POST /edit`; `images` becomes one or more `image`/`image[]` parts. */
export type EditFiles = { images: File[]; mask?: File }

async function gatewayFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (error) {
    // Tauri plugin invocations reject with plain strings (e.g. a capability-scope
    // denial), not Error objects — normalize so the UI always shows the real cause.
    throw new Error(
      `Gateway request failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    )
  }
}

/**
 * Parses a non-streaming JSON envelope, throwing the gateway's own error message on failure.
 * Exported (alongside `handleFrame`/`consumeSseStream` below) purely so `gateway.test.ts` can
 * drive the response-parsing logic directly against constructed `Response`/`ReadableStream`
 * objects — it does not touch `@tauri-apps/plugin-http`, so this is testable without a Tauri
 * runtime.
 */
export async function parseJsonEnvelope<T>(
  response: Response,
  schema: { parse: (data: unknown) => T },
): Promise<T> {
  const json: unknown = await response.json()

  if (!response.ok) {
    const parsedError = errorResponseSchema.safeParse(json)
    throw new Error(
      parsedError.success
        ? parsedError.data.error.message
        : `Gateway request failed with status ${response.status}`,
    )
  }

  return schema.parse(json)
}

function buildEditFormData(
  body: ReturnType<typeof editRequestSchema.parse>,
  files: EditFiles,
): FormData {
  const formData = new FormData()

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue
    formData.append(key, String(value))
  }

  if (files.images.length > 1) {
    for (const image of files.images) formData.append('image[]', image)
  } else {
    for (const image of files.images) formData.append('image', image)
  }

  if (files.mask) formData.append('mask', files.mask)

  return formData
}

export async function generate(
  connection: ServiceConnection,
  input: GenerateRequestInput,
  signal?: AbortSignal,
): Promise<GenerateResponse> {
  const body = generateRequestSchema.parse(input)
  const baseUrl = connection.baseUrl.replace(/\/+$/, '')

  const response = await gatewayFetch(`${baseUrl}/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.token}`,
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })

  return parseJsonEnvelope(response, generateResponseSchema)
}

export async function edit(
  connection: ServiceConnection,
  input: EditRequestInput,
  files: EditFiles,
  signal?: AbortSignal,
): Promise<EditResponse> {
  const body = editRequestSchema.parse(input)
  const baseUrl = connection.baseUrl.replace(/\/+$/, '')

  // No `Content-Type` here: the underlying `Request` constructor computes the
  // multipart boundary from the `FormData` body and plugin-http only copies headers
  // we haven't already set — setting our own would strip the boundary.
  const response = await gatewayFetch(`${baseUrl}/edit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${connection.token}` },
    body: buildEditFormData(body, files),
    ...(signal ? { signal } : {}),
  })

  return parseJsonEnvelope(response, editResponseSchema)
}

/**
 * Calls the `/enhance` v2 contract (`shared/src/plan.ts`) — turns a brief (or a
 * `current_prompt` + `delta` iteration) into a crafted prompt, derived settings, policy
 * warnings, and an estimated cost. Never generates an image; the caller reviews the plan,
 * then calls `generate()`/`edit()` (or their streaming counterparts) with the returned
 * settings. Parses the response through `planResponseSchema` rather than casting — the
 * gateway is a separate process and a contract drift must fail loudly here.
 */
export async function plan(
  connection: ServiceConnection,
  input: PlanRequestInput,
  signal?: AbortSignal,
): Promise<PlanResponse> {
  const body = planRequestSchema.parse(input)
  const baseUrl = connection.baseUrl.replace(/\/+$/, '')

  const response = await gatewayFetch(`${baseUrl}/enhance`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.token}`,
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })

  return parseJsonEnvelope(response, planResponseSchema)
}

export type StreamHandlers = {
  onPartial: (frame: {
    b64_json: string
    format: 'png' | 'webp' | 'jpeg'
    partial_image_index: number
  }) => void
  signal?: AbortSignal
}

/** Races a single `reader.read()` against the caller's abort signal, cancelling the reader on abort. */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read()

  if (signal.aborted) {
    await reader.cancel()
    throw new Error('Gateway stream aborted')
  }

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error('Gateway stream aborted'))
      void reader.cancel()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        return resolve(result)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        return reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * Handles one complete SSE frame (everything between two `\n\n` delimiters).
 * Returns the final `GenerateResponse` once a `completed` frame arrives, `undefined`
 * for a `partial_image` frame (already dispatched to `onPartial`), or throws on `error`.
 */
export function handleFrame(
  rawFrame: string,
  handlers: StreamHandlers,
): GenerateResponse | undefined {
  // SSE data fields may be split across multiple `data:` lines within one frame;
  // per spec these are rejoined with `\n`. The gateway emits single-line JSON, but
  // handle the general case rather than assuming that.
  const dataLines = rawFrame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).replace(/^ /, ''))

  if (dataLines.length === 0) return undefined

  const payload: unknown = JSON.parse(dataLines.join('\n'))
  const event = streamEventSchema.parse(payload)

  switch (event.type) {
    case 'partial_image':
      handlers.onPartial({
        b64_json: event.b64_json,
        format: event.format,
        partial_image_index: event.partial_image_index,
      })
      return undefined
    case 'completed':
      return event.response
    case 'error':
      throw new Error(event.error.message)
  }
}

/**
 * Reads an SSE response body incrementally and resolves with the `completed` frame's
 * response. Buffers raw bytes across chunk boundaries — a chunk may contain zero, one,
 * or many complete frames, and a frame may itself be split across chunks.
 */
export async function consumeSseStream(
  response: Response,
  handlers: StreamHandlers,
): Promise<GenerateResponse> {
  if (!response.ok) {
    const json: unknown = await response.json()
    const parsedError = errorResponseSchema.safeParse(json)
    throw new Error(
      parsedError.success
        ? parsedError.data.error.message
        : `Gateway request failed with status ${response.status}`,
    )
  }

  if (!response.body) {
    throw new Error('Gateway request failed: streaming response had no body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await readChunk(reader, handlers.signal)
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    buffer = buffer.replace(/\r\n/g, '\n')

    let delimiterIndex = buffer.indexOf('\n\n')
    while (delimiterIndex !== -1) {
      const rawFrame = buffer.slice(0, delimiterIndex)
      buffer = buffer.slice(delimiterIndex + 2)

      const result = handleFrame(rawFrame, handlers)
      if (result !== undefined) return result

      delimiterIndex = buffer.indexOf('\n\n')
    }
  }

  throw new Error('Gateway stream ended without a completed or error frame')
}

export async function generateStream(
  connection: ServiceConnection,
  input: GenerateRequestInput,
  handlers: StreamHandlers,
): Promise<GenerateResponse> {
  const body = generateRequestSchema.parse(input)
  const baseUrl = connection.baseUrl.replace(/\/+$/, '')

  const response = await gatewayFetch(`${baseUrl}/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.token}`,
    },
    body: JSON.stringify(body),
    ...(handlers.signal ? { signal: handlers.signal } : {}),
  })

  return consumeSseStream(response, handlers)
}

export async function editStream(
  connection: ServiceConnection,
  input: EditRequestInput,
  files: EditFiles,
  handlers: StreamHandlers,
): Promise<EditResponse> {
  const body = editRequestSchema.parse(input)
  const baseUrl = connection.baseUrl.replace(/\/+$/, '')

  const response = await gatewayFetch(`${baseUrl}/edit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${connection.token}` },
    body: buildEditFormData(body, files),
    ...(handlers.signal ? { signal: handlers.signal } : {}),
  })

  return consumeSseStream(response, handlers)
}
