import type { EditResponse, GenerateResponse } from '@image-gateway/shared'
import { notifications } from '@mantine/notifications'
import { error as logError } from '@tauri-apps/plugin-log'
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { edit, editStream, generate, generateStream, type EditFiles } from './gateway'
import {
  saveEdit,
  saveGeneration,
  type SaveEditRequest,
  type SaveGenerationRequest,
} from './library'
import type { Settings } from './settings'

export type JobStatus = 'running' | 'done' | 'error' | 'cancelled'

/**
 * Latest SSE partial-image frame for a streaming job, decoded straight into a data URL
 * (`data:image/<format>;base64,...`) so callers can drop it into an `<img src>` with no
 * further decoding. Best-effort progress only — upstream may deliver fewer partials than
 * requested, so `index` must never be used to wait for a fixed count. Cleared once the
 * job's `response` lands; never written to disk (only the final result is persisted, via
 * the existing `saveGeneration`/`saveEdit` path).
 */
export type JobPreview = {
  dataUrl: string
  /** 0-based partial-frame counter as reported by the gateway. */
  index: number
}

export type Job = {
  id: string
  kind: 'generate' | 'edit'
  /** Short prompt excerpt for the queue bar. */
  label: string
  status: JobStatus
  startedAt: number
  finishedAt?: number
  /** Library id once persisted to disk. */
  savedId?: string
  error?: string
  /** The gateway response, once the job completes successfully — drives result display. */
  response?: GenerateResponse | EditResponse
  /** Latest streamed preview, present only while a streaming job is still running. */
  preview?: JobPreview | undefined
}

/**
 * Per-call streaming opt-out. Streaming is on by default whenever the effective `n` is 1
 * (upstream hard constraint: "Streaming is only supported with n=1") — pass
 * `{ stream: false }` to force the non-streaming path even for an `n === 1` request.
 * `n > 1` always falls back to non-streaming regardless of this flag.
 */
export type EnqueueOptions = { stream?: boolean }

/**
 * Whether a job should take the streaming SSE path. Pure and exported for testing — the
 * one rule that matters: streaming is an upstream hard constraint at `n=1`
 * ("Streaming is only supported with n=1"), never a preference, so `n > 1` always wins
 * over an opt-in `stream: true`.
 */
export function shouldStreamJob(n: number | undefined, streamRequested: boolean): boolean {
  return streamRequested && (n ?? 1) === 1
}

/**
 * The `partial_images` count to send when streaming: preserves a caller-specified
 * positive count, otherwise defaults to 1 preview frame. Upstream may still deliver
 * fewer partials than requested — this only sets the ceiling.
 */
export function effectivePartialImages(requested: number | undefined): number {
  return requested && requested > 0 ? requested : 1
}

/** Decodes an SSE partial-image frame straight into an `<img src>`-ready data URL. */
export function previewDataUrl(format: 'png' | 'webp' | 'jpeg', b64Json: string): string {
  return `data:image/${format};base64,${b64Json}`
}

/**
 * `EditRequestInput`'s `n`/`partial_images` are `z.coerce.number()` fields (the multipart
 * wire format has no native number type), so their TS input type is `unknown` — mirror
 * zod's own coercion here rather than asserting past it.
 */
function coerceNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : Number(value)
}

type QueueContextValue = {
  jobs: readonly Job[]
  enqueueGenerate: (input: SaveGenerationRequest, options?: EnqueueOptions) => string
  enqueueEdit: (
    input: SaveEditRequest,
    images: File[],
    mask?: File,
    options?: EnqueueOptions,
  ) => string
  cancel: (id: string) => void
  dismiss: (id: string) => void
}

const QueueContext = createContext<QueueContextValue | null>(null)

const LABEL_MAX_LENGTH = 48

function labelFor(prompt: string): string {
  const trimmed = prompt.trim()
  return trimmed.length > LABEL_MAX_LENGTH ? `${trimmed.slice(0, LABEL_MAX_LENGTH)}…` : trimmed
}

type QueueProviderProps = {
  children: ReactNode
  settings: Settings
  onSaved: () => void
}

/**
 * Owns in-flight generate/edit jobs independent of which view is mounted. The fetch and the
 * `saveGeneration`/`saveEdit` call both live here, so a job started in Compose keeps running
 * (and, on completion, still gets written to disk) even after the user switches to Library or
 * Edit — nothing about a job's lifecycle is tied to a mounted component. Cancellation is
 * explicit-only, via `cancel(id)`; there is no unmount-triggered abort.
 */
export function QueueProvider({ children, settings, onSaved }: QueueProviderProps) {
  const [jobs, setJobs] = useState<Job[]>([])
  const controllersRef = useRef(new Map<string, AbortController>())

  const updateJob = useCallback((id: string, patch: Partial<Job>) => {
    setJobs((prev) => prev.map((job) => (job.id === id ? { ...job, ...patch } : job)))
  }, [])

  const onPartialFor = useCallback(
    (id: string, controller: AbortController) =>
      (frame: {
        b64_json: string
        format: 'png' | 'webp' | 'jpeg'
        partial_image_index: number
      }) => {
        // A frame can race an already-settled abort (cancel fires between the last
        // `read()` resolving and this callback running) — drop it rather than reviving
        // a job the user just cancelled.
        if (controller.signal.aborted) return
        updateJob(id, {
          preview: {
            dataUrl: previewDataUrl(frame.format, frame.b64_json),
            index: frame.partial_image_index,
          },
        })
      },
    [updateJob],
  )

  const runGenerate = useCallback(
    async (
      id: string,
      input: SaveGenerationRequest,
      controller: AbortController,
      stream: boolean,
    ) => {
      try {
        const response = shouldStreamJob(input.n, stream)
          ? await generateStream(
              settings.gateway,
              { ...input, partial_images: effectivePartialImages(input.partial_images) },
              { onPartial: onPartialFor(id, controller), signal: controller.signal },
            )
          : await generate(settings.gateway, { ...input, partial_images: 0 }, controller.signal)
        if (controller.signal.aborted) return
        const metadata = await saveGeneration(response, input)
        updateJob(id, {
          status: 'done',
          finishedAt: Date.now(),
          savedId: metadata.id,
          response,
          preview: undefined,
        })
        notifications.show({
          color: 'green',
          title: 'Generation saved',
          message: `Saved to library as ${metadata.id}`,
        })
        onSaved()
      } catch (error) {
        if (controller.signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        void logError(`generation failed: ${message}`)
        updateJob(id, {
          status: 'error',
          finishedAt: Date.now(),
          error: message,
          preview: undefined,
        })
        notifications.show({ color: 'red', title: 'Generation failed', message })
      } finally {
        controllersRef.current.delete(id)
      }
    },
    [settings, onSaved, updateJob, onPartialFor],
  )

  const runEdit = useCallback(
    async (
      id: string,
      input: SaveEditRequest,
      files: EditFiles,
      controller: AbortController,
      stream: boolean,
    ) => {
      try {
        const response = shouldStreamJob(coerceNumber(input.n), stream)
          ? await editStream(
              settings.gateway,
              {
                ...input,
                partial_images: effectivePartialImages(coerceNumber(input.partial_images)),
              },
              files,
              { onPartial: onPartialFor(id, controller), signal: controller.signal },
            )
          : await edit(settings.gateway, { ...input, partial_images: 0 }, files, controller.signal)
        if (controller.signal.aborted) return
        const metadata = await saveEdit(response, input, files)
        updateJob(id, {
          status: 'done',
          finishedAt: Date.now(),
          savedId: metadata.id,
          response,
          preview: undefined,
        })
        notifications.show({
          color: 'green',
          title: 'Edit saved',
          message: `Saved to library as ${metadata.id}`,
        })
        onSaved()
      } catch (error) {
        if (controller.signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        void logError(`edit failed: ${message}`)
        updateJob(id, {
          status: 'error',
          finishedAt: Date.now(),
          error: message,
          preview: undefined,
        })
        notifications.show({ color: 'red', title: 'Edit failed', message })
      } finally {
        controllersRef.current.delete(id)
      }
    },
    [settings, onSaved, updateJob, onPartialFor],
  )

  const enqueueGenerate = useCallback(
    (input: SaveGenerationRequest, options?: EnqueueOptions): string => {
      const id = crypto.randomUUID()
      const controller = new AbortController()
      controllersRef.current.set(id, controller)
      setJobs((prev) => [
        ...prev,
        {
          id,
          kind: 'generate',
          label: labelFor(input.prompt),
          status: 'running',
          startedAt: Date.now(),
        },
      ])
      void runGenerate(id, input, controller, options?.stream ?? true)
      return id
    },
    [runGenerate],
  )

  const enqueueEdit = useCallback(
    (input: SaveEditRequest, images: File[], mask?: File, options?: EnqueueOptions): string => {
      const id = crypto.randomUUID()
      const controller = new AbortController()
      controllersRef.current.set(id, controller)
      const files: EditFiles = { images, ...(mask ? { mask } : {}) }
      setJobs((prev) => [
        ...prev,
        {
          id,
          kind: 'edit',
          label: labelFor(input.prompt),
          status: 'running',
          startedAt: Date.now(),
        },
      ])
      void runEdit(id, input, files, controller, options?.stream ?? true)
      return id
    },
    [runEdit],
  )

  // Explicit user cancel only — never wired to unmount. `abort()` here is forwarded into
  // `generate`/`edit` (via `controller.signal`), which plugin-http's `fetch` honors — the
  // in-flight upstream request is genuinely cancelled, not just abandoned. `abort()` also
  // flips `controller.signal.aborted` synchronously, which the runner checks before
  // persisting and in its catch block — so a cancelled job's result is discarded on arrival
  // and the resulting fetch rejection doesn't surface as a red "failed" notification.
  const cancel = useCallback(
    (id: string) => {
      controllersRef.current.get(id)?.abort()
      updateJob(id, { status: 'cancelled', finishedAt: Date.now() })
    },
    [updateJob],
  )

  const dismiss = useCallback((id: string) => {
    setJobs((prev) => prev.filter((job) => job.id !== id))
  }, [])

  const value = useMemo<QueueContextValue>(
    () => ({ jobs, enqueueGenerate, enqueueEdit, cancel, dismiss }),
    [jobs, enqueueGenerate, enqueueEdit, cancel, dismiss],
  )

  return createElement(QueueContext.Provider, { value }, children)
}

export function useQueue(): QueueContextValue {
  const ctx = useContext(QueueContext)
  if (!ctx) throw new Error('useQueue must be used within a QueueProvider')
  return ctx
}
