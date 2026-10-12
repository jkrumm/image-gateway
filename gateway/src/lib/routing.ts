import {
  resolveModel,
  routingReason,
  validateBackgroundForModel,
  validateInputFidelityForModel,
  validateQualityForModel,
  validateSizeForModel,
  validateTransparentOutputFormat,
  type EditRequest,
  type GenerateRequest,
  type ImageModel,
  type RequestQuality,
} from '@image-gateway/shared'

export interface RouteResult {
  model: ImageModel
  routed: boolean
  reason?: string
}

/**
 * Pick the model that actually serves the request.
 *
 * An explicit `model` is always honoured (`routed: false`). `model: 'auto'`
 * is routed between the two generatable models by endpoint and quality (see
 * `resolveModel` in `rules.ts`) and reported honestly via `routed`/`reason` —
 * the response contract's `routed`/`routing_reason` fields (`contract.ts`)
 * exist for exactly this.
 */
export function routeModel(req: {
  model: GenerateRequest['model']
  endpoint: 'generate' | 'edit'
  quality: RequestQuality
}): RouteResult {
  const model = resolveModel(req)
  const reason = routingReason(req)
  if (reason === null) return { model, routed: false }
  return { model, routed: true, reason }
}

/**
 * Validate a requested size against a model's constraints. Delegates to the
 * shared rule — kept as a named export so routes don't reach past this
 * module's interface into `@image-gateway/shared` directly.
 */
export function validateSize(model: ImageModel, size: string): string | null {
  return validateSizeForModel(model, size)
}

/**
 * Validate `background` against a model's alpha-channel support. Both
 * generatable models support a real alpha channel today; this remains a
 * defensive 400 rather than trusting the request schema alone.
 */
export function validateBackground(
  model: ImageModel,
  background: GenerateRequest['background'],
): string | null {
  return validateBackgroundForModel(model, background)
}

/**
 * Validate `background: "transparent"` against the requested output format —
 * jpeg has no alpha channel, so the combination is refused here rather than
 * silently dropping transparency or bouncing off upstream as a 502.
 */
export function validateTransparentFormat(
  background: GenerateRequest['background'],
  outputFormat: GenerateRequest['output_format'],
): string | null {
  return validateTransparentOutputFormat(background, outputFormat)
}

/**
 * Validate `input_fidelity` against a model's capabilities. Delegates to the
 * shared rule; see `validateSize` for why this thin wrapper exists.
 */
export function validateInputFidelity(
  model: ImageModel,
  inputFidelity: EditRequest['input_fidelity'],
): string | null {
  return validateInputFidelityForModel(model, inputFidelity)
}

/**
 * Validate `quality` against a model's extended-tier support (`xhigh`/`max`).
 * Delegates to the shared rule; see `validateSize` for why this thin wrapper
 * exists.
 */
export function validateQuality(
  model: ImageModel,
  quality: GenerateRequest['quality'],
): string | null {
  return validateQualityForModel(model, quality)
}
