/**
 * Pure request-construction for the Library's three replay ops (docs/concept.md §2, "Tweak vs
 * Re-run, finally distinct"). Deliberately has no Tauri imports — the file-loading (reading an
 * edit's saved input images off disk) and the actual enqueue/navigation calls live in
 * `Library.tsx`, which is untestable without a Tauri runtime; everything that can be pure, is,
 * so the replay-request shape and (above all) the size-snap chokepoint are pinned by unit tests.
 *
 * The replay hazard (repo AGENTS.md / the G5 brief): a recorded `params.size` is truthful but not
 * necessarily replayable — gpt-image-2 (and its 2.5 successors) return non-16-divisible dimensions
 * for `size: "auto"` (observed live: 1024x1024 in -> 1254x1254 out), and re-sending that 400s
 * upstream. Every function here that turns a saved generation back into a request pipes the size
 * through `snapSizeForModel`, resolving the model first since size validity is per-model.
 *
 * The second replay hazard: a sidecar may name a model that can no longer generate (`gpt-image-2`,
 * `-1.5`, `-1-mini`) and may carry parameters only those models accepted (`input_fidelity`).
 * Replaying such a generation must still work end-to-end, so those fields are coerced into a valid
 * request against a current generatable model — but never silently (concept §2's central taboo).
 * `background: 'transparent'` needs no coercion any more (both generatable models have an alpha
 * channel); the check below stays as a defensive no-op in case that ever regresses. Every coercion
 * is returned alongside the request as a `ReplayCoercion` for the caller to surface.
 */
import {
  IMAGE_MODELS,
  MODEL_CAPABILITIES,
  resolveModel,
  snapSizeForModel,
  type GenerateRequestInput,
  type GenerationParent,
  type ImageModel,
  type KnownImageModel,
  type RequestQuality,
} from '@image-gateway/shared'
import type { GenerationMetadata } from './metadata'

/** The full request-field bag reconstructable from a saved generation's sidecar — a superset
 * compatible with both `GenerateRequestInput` and `EditRequestInput` (the extra `input_fidelity`
 * field is simply ignored by `generateRequestSchema.parse()`, which strips unknown keys). */
export type ReplayRequest = GenerateRequestInput & { input_fidelity?: 'high' | 'low' }

/** A recorded generation read back verbatim, before any coercion. `model` is a `KnownImageModel`
 * (not the narrower generatable `ImageModel`) because a sidecar may name a retired model. */
export type RecordedRequest = Omit<ReplayRequest, 'model'> & { model: KnownImageModel }

/** One field a replay had to change to stay valid on today's only generatable model. Surfaced to
 * the user rather than applied silently. */
export type ReplayCoercion = {
  field: 'model' | 'background' | 'input_fidelity' | 'size'
  from: string
  to: string
  reason: string
}

/** A replay-ready request plus every change made to the recorded values to get there. */
export type ReplayPlan<TRequest extends ReplayRequest = ReplayRequest> = {
  request: TRequest
  coercions: ReplayCoercion[]
}

/** True when MODEL can still serve a new request today. */
function isGeneratable(model: KnownImageModel): model is ImageModel {
  return (IMAGE_MODELS as readonly string[]).includes(model)
}

/**
 * Reconstructs a request bag from a saved generation's sidecar, verbatim — no size snapping and no
 * coercion. `quality`/`background` come back from `params` as plain strings (mirroring the
 * gateway's resolved response), cast to the request enums the create controls and request schemas
 * expect.
 */
export function requestFromMetadata(metadata: GenerationMetadata): RecordedRequest {
  return {
    prompt: metadata.prompt,
    model: metadata.model,
    size: metadata.params.size,
    quality: metadata.params.quality as GenerateRequestInput['quality'],
    background: metadata.params.background as GenerateRequestInput['background'],
    output_format: metadata.params.output_format,
    ...(metadata.params.output_compression !== undefined
      ? { output_compression: metadata.params.output_compression }
      : {}),
    n: metadata.params.n,
    moderation: metadata.params.moderation,
    ...(metadata.params.input_fidelity !== undefined
      ? { input_fidelity: metadata.params.input_fidelity }
      : {}),
  }
}

/**
 * The chokepoint every replay path must go through (repo AGENTS.md's "replay hazard"). In order:
 * retires a non-generatable model onto the model `resolveModel`'s routing rule would pick for this
 * generation (edit → sunburst; a recorded `high`/`xhigh`/`max` generate → sunburst; else flare —
 * same rule as a fresh `auto` request), drops `input_fidelity` when the resolved model rejects it,
 * then snaps the recorded size into validity. `background: 'transparent'` needs no coercion any
 * more — both generatable models have an alpha channel; the check below is a defensive no-op kept
 * for the day that regresses. `snapSizeForModel` is handed the *recorded* model — it resolves the
 * generatable target itself, and is a no-op for `'auto'` and already-valid sizes.
 */
export function snappedReplayRequest(metadata: GenerationMetadata): ReplayPlan {
  const recorded = requestFromMetadata(metadata)
  const coercions: ReplayCoercion[] = []

  const model: ImageModel = isGeneratable(recorded.model)
    ? recorded.model
    : resolveModel({
        model: 'auto',
        endpoint: metadata.kind === 'edit' ? 'edit' : 'generate',
        quality: (recorded.quality ?? 'auto') as RequestQuality,
      })
  if (model !== recorded.model) {
    coercions.push({
      field: 'model',
      from: recorded.model,
      to: model,
      reason: `${recorded.model} is retired — the studio generates with ${IMAGE_MODELS.join(' / ')}`,
    })
  }

  let background = recorded.background ?? 'auto'
  if (background === 'transparent' && !MODEL_CAPABILITIES[model].transparentBackground) {
    background = 'opaque'
    coercions.push({
      field: 'background',
      from: 'transparent',
      to: 'opaque',
      reason: `${model} has no alpha channel and cannot generate a transparent background`,
    })
  }

  let inputFidelity = recorded.input_fidelity
  if (inputFidelity !== undefined && !MODEL_CAPABILITIES[model].inputFidelity) {
    coercions.push({
      field: 'input_fidelity',
      from: inputFidelity,
      to: 'unset',
      reason: `${model} rejects input_fidelity outright (it is always high)`,
    })
    inputFidelity = undefined
  }

  const recordedSize = recorded.size ?? 'auto'
  const size = snapSizeForModel(recorded.model, recordedSize)
  if (size !== recordedSize) {
    coercions.push({
      field: 'size',
      from: recordedSize,
      to: size,
      reason: `${recordedSize} is not a size ${model} accepts`,
    })
  }

  const request: ReplayRequest = { ...recorded, model, background, size }
  if (inputFidelity === undefined) delete request.input_fidelity
  else request.input_fidelity = inputFidelity

  return { request, coercions }
}

/** Tweak: navigates to Create fully editable, recorded prompt+settings prefilled. Create's own
 * seed-consumption effect re-snaps the size on arrival (defense in depth) — this pre-snaps too so
 * the seed itself is never invalid, e.g. for a future non-UI caller that skips that effect. */
export function buildTweakRequest(metadata: GenerationMetadata): ReplayPlan {
  return snappedReplayRequest(metadata)
}

/** Re-run: the recorded prompt+settings, verbatim except for the mandatory coercions, direct-
 * enqueued (no navigation) with `parent` recording the op that produced it. */
export function buildRerunRequest(
  metadata: GenerationMetadata,
): ReplayPlan<ReplayRequest & { parent: GenerationParent }> {
  const { request, coercions } = snappedReplayRequest(metadata)
  return { request: { ...request, parent: { id: metadata.id, op: 'rerun' } }, coercions }
}

/** Promote: Re-run's settings with quality forced to `high` and `n` forced to `1` (concept §2:
 * "re-run at quality high with n: 1"), direct-enqueued with `parent.op: 'promote'`. Promote skips
 * the `/enhance` round-trip entirely (direct-enqueue, no Plan call), so there is no `preserve_list`
 * to re-emit here — that field only exists on a Plan request. */
export function buildPromoteRequest(
  metadata: GenerationMetadata,
): ReplayPlan<ReplayRequest & { parent: GenerationParent }> {
  const { request, coercions } = snappedReplayRequest(metadata)
  return {
    request: {
      ...request,
      quality: 'high',
      n: 1,
      parent: { id: metadata.id, op: 'promote' },
    },
    coercions,
  }
}

/** One-line summary of a replay's coercions, for a notification body. Empty string when none. */
export function describeCoercions(coercions: ReplayCoercion[]): string {
  return coercions
    .map((coercion) => `${coercion.field}: ${coercion.from} → ${coercion.to} (${coercion.reason})`)
    .join('; ')
}
