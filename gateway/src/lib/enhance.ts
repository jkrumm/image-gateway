import { z } from 'zod'
import {
  IMAGE_MODELS,
  SIZE_PRESETS,
  PLAYBOOK_VERSION,
  composePlaybookSystemPrompt,
  estimateCost,
  planAdditionSchema,
  planIntentResultSchema,
  planWarningSchema,
  resolveModel,
  routingReason,
  validateBackgroundForModel,
  validateInputFidelityForModel,
  validateQualityForModel,
  validateSizeForModel,
  type Intent,
  type PlanMode,
  type PlanOverrides,
  type PlanRequest,
  type PlanResponse,
  type PlanSettings,
  type VerbatimCheck,
} from '@image-gateway/shared'
import { env } from '../env.js'
import { requestWithRetry } from './upstream.js'
import { log } from './log.js'

/**
 * The `/enhance` v2 "Plan" brain — see docs/concept.md §7. Compiles the
 * versioned playbook into a
 * system prompt, asks the enhance model for a single structured JSON plan,
 * then does the part the LLM must never be trusted with: settings resolved
 * through `rules.ts`, a verbatim containment check, cost estimate, and the
 * aggressiveness gate. "The LLM proposes; rules.ts disposes."
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Chat-completions usage shape (live-probed 2026-07-16 — see the v1 routes/enhance.ts history). */
export interface ChatCompletionUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  completion_tokens_details?: Record<string, number>
  // Cache-read tokens ride along as `prompt_tokens_details.cached_tokens` —
  // measured working on this endpoint 2026-09-13 (deepseek-v4.1-flash,
  // gpt-5.6-luna, glm-5.3-flash all report it). A subset of `prompt_tokens`,
  // not additive.
  prompt_tokens_details?: { cached_tokens?: number }
}

export interface ChatCompletionResponse {
  choices: { message: { content: string | null }; finish_reason?: string }[]
  usage?: ChatCompletionUsage
}

// ---------------------------------------------------------------------------
// Intent -> playbook file mapping
// ---------------------------------------------------------------------------

/**
 * `plan.ts`'s `Intent` enum is not a 1:1 mapping onto `shared/playbook/` file
 * keys: the `icon` intent's file is `icons` (plural). Every other intent
 * matches its filename exactly, including `figure-art` and `texture` (both
 * files exist). Never called with `'auto'` — callers branch on that first.
 */
const INTENT_PLAYBOOK_OVERRIDES: Partial<Record<Exclude<Intent, 'auto'>, string>> = {
  icon: 'icons',
}

export function intentPlaybookKey(intent: Exclude<Intent, 'auto'>): string {
  return INTENT_PLAYBOOK_OVERRIDES[intent] ?? intent
}

/**
 * Compile the enhancer system prompt for one request's intent. `auto` omits
 * every intent file — the LLM detects intent from the brief itself and
 * reports it back as `intent.detected`.
 */
export function composeSystemPromptForIntent(intent: Intent): string {
  if (intent === 'auto') return composePlaybookSystemPrompt()
  return composePlaybookSystemPrompt([intentPlaybookKey(intent)])
}

// ---------------------------------------------------------------------------
// Aggressiveness gate (server-side source of truth, never the LLM's call)
// ---------------------------------------------------------------------------

const FULL_MAX_WORDS = 25
const GAPS_MAX_WORDS = 100

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/**
 * docs/concept.md §7: brief word count <25 -> full,
 * 25-100 -> gaps, >100 -> off (passthrough). `request.mode` set to anything
 * but `auto` always wins. The word count is taken from whichever brief-shaped
 * text this round actually carries — `brief` for a new plan, `delta` for an
 * iteration (the `current_prompt` side is already-accepted, established
 * prose, not new input to gate on).
 */
export type ModeApplied = Exclude<PlanMode, 'auto'>

export function computeModeApplied(request: PlanRequest): ModeApplied {
  if (request.mode !== 'auto') return request.mode
  const text = request.brief ?? request.delta ?? ''
  const count = wordCount(text)
  if (count < FULL_MAX_WORDS) return 'full'
  if (count <= GAPS_MAX_WORDS) return 'gaps'
  return 'off'
}

// ---------------------------------------------------------------------------
// LLM output contract (the model's *portion* of the plan — everything else
// is server-derived) and message construction
// ---------------------------------------------------------------------------

const llmProposedSettingsSchema = z.object({
  /**
   * `.catch('auto')` rather than a bare enum: the model is advisory, and a
   * proposal naming a retired model (the enhance model has gpt-image-1.5 /
   * -1-mini / -2 in its training data, and the playbook is edited
   * independently of this file) must degrade to "let the gateway pick" — not
   * fail the whole plan and burn a retry round-trip on a field the server
   * overrules anyway. The enum still guarantees whatever survives here is
   * generatable today, so the settings this returns always validate against
   * the request schema.
   */
  model: z
    .enum([...IMAGE_MODELS, 'auto'] as const)
    .default('auto')
    .catch('auto'),
  size: z.string().default('auto'),
  quality: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'auto']).default('auto'),
  background: z.enum(['transparent', 'opaque', 'auto']).default('auto'),
  n: z.number().int().min(1).max(10).default(1),
  moderation: z.enum(['auto', 'low']).default('auto'),
  input_fidelity: z.enum(['high', 'low']).optional(),
  partial_images: z.number().int().min(0).max(3).default(1),
})
export type LlmProposedSettings = z.infer<typeof llmProposedSettingsSchema>

const llmPlanSchema = z.object({
  intent: planIntentResultSchema,
  prompt: z.string().min(1),
  additions: z.array(planAdditionSchema).default([]),
  assumptions: z.array(z.string()).default([]),
  warnings: z.array(planWarningSchema).default([]),
  proposed_settings: llmProposedSettingsSchema,
  /**
   * Optional trailing constraint clause (e.g. a restated preserve list, a
   * safety clarification). Only spliced onto the final prompt in `off`
   * (passthrough) mode and for delta-mode preserve-list restatement — the
   * gateway never trusts the LLM's own `prompt` field to leave the brief
   * untouched in passthrough mode.
   */
  constraint_block: z.string().optional(),
})
export type LlmPlan = z.infer<typeof llmPlanSchema>

const OUTPUT_CONTRACT = `You are the Plan brain for a personal image-generation studio's gateway. Given a brief (or an iteration request), respond with a SINGLE JSON object and nothing else — no markdown fences, no commentary, no prose before or after it.

The JSON object must have exactly this shape:
{
  "intent": { "detected": "<icon|hero|painterly|technical|diagram|article|figure-art|texture>", "confidence": <0-1 number> },
  "prompt": "<the finished image-generation prompt, per the playbook's canonical ordering and terminal constraint block>",
  "additions": [{ "slot": "<gap filled, e.g. lighting>", "text": "<the added text>" }],
  "assumptions": ["<free-text notes on what you assumed or corrected>"],
  "warnings": [{ "code": "<short_code>", "severity": "warn"|"rewrite"|"hard", "message": "<explanation>", "suggested_rewrite": "<optional compliant rewrite>", "moderation_suggestion": "low", "predicted_stage": "input"|"output" }],
  "proposed_settings": {
    "model": "gpt-image-2.5-flare"|"gpt-image-2.5-sunburst"|"auto" (prefer "auto" — the gateway routes flare for drafts, sunburst for edits and high/xhigh/max finals),
    "size": "<'auto', a preset (1024x1024, 1536x1024, 1024x1536), or a custom WxH>",
    "quality": "low"|"medium"|"high"|"xhigh"|"max"|"auto",
    "background": "transparent"|"opaque"|"auto" ("transparent" needs output_format png or webp — never jpeg),
    "n": <integer 1-10>,
    "moderation": "auto"|"low",
    "input_fidelity": "high"|"low" (omit — no available model supports it; the gateway rejects it outright),
    "partial_images": <integer 0-3, 1 for a live single-image preview>
  },
  "constraint_block": "<optional trailing constraint clause, e.g. a restated preserve list; empty/omitted if none>"
}

Do not include an "endpoint" field — the gateway derives it from whether reference images are attached. Every setting you propose is advisory: the gateway validates it against the real model-capability matrix and may correct it.`

function modeInstruction(modeApplied: ModeApplied): string {
  switch (modeApplied) {
    case 'full':
      return "Aggressiveness: FULL. Fully enhance the brief per the playbook's canonical ordering, filling every reasonable gap (lighting, composition, medium, mood, style anchor)."
    case 'gaps':
      return 'Aggressiveness: GAP-FILL ONLY. The brief is already fairly complete — only fill missing slots that materially affect the output. Do not rewrite or embellish what is already stated.'
    case 'off':
      return 'Aggressiveness: PASSTHROUGH. Do NOT rewrite the brief/current prompt\'s prose at all — the gateway ignores your "prompt" field in this mode and uses the raw brief/current prompt verbatim. Your job here is only to: (1) evaluate policy risk into "warnings", (2) propose settings, (3) optionally propose a single trailing "constraint_block" (e.g. a restated preserve list or a safety clarification) — leave it empty if none is needed. Still fill "prompt" with your best-effort echo of the input for logging purposes.'
  }
}

function intentInstruction(intent: Intent): string {
  if (intent === 'auto') {
    return 'Detect the intent from the brief and report it as "intent.detected", choosing the closest match from the enum.'
  }
  return `The intent is fixed to "${intent}" — do not redetect it; set "intent.detected" to "${intent}" with confidence 1.`
}

function briefOrDeltaSection(request: PlanRequest): string {
  if (request.current_prompt !== undefined) {
    const preserve =
      request.preserve_list.length > 0 ? request.preserve_list.join(', ') : 'none specified'
    const delta = request.delta ?? '(no delta given — treat as a verbatim re-run request)'
    return [
      'This is an iteration on an existing accepted prompt.',
      `Current accepted prompt: "${request.current_prompt}"`,
      `Requested change (the delta): "${delta}"`,
      `Preserve list (must survive unchanged; re-state it in "constraint_block"): ${preserve}`,
      'Apply ONLY the delta — do not otherwise rewrite the current prompt.',
    ].join('\n')
  }
  return `Brief: "${request.brief}"`
}

function styleGuideSection(request: PlanRequest): string | null {
  if (!request.style_guide) return null
  const { prompt_fragment, palette, avoid, ref_image_count } = request.style_guide
  const parts = [
    `Attached style guide — weave this fragment verbatim into the prompt: "${prompt_fragment}"`,
  ]
  if (palette.length > 0)
    parts.push(`Palette (verbatim hexes, do not alter): ${palette.join(', ')}`)
  if (avoid.length > 0) parts.push(`Avoid: ${avoid.join(', ')}`)
  if (ref_image_count > 0)
    parts.push(`${ref_image_count} style reference image(s) will ride along.`)
  return parts.join('\n')
}

function seriesContextSection(request: PlanRequest): string | null {
  if (request.series_context.length === 0) return null
  const prompts = request.series_context.map((entry) => `- ${entry.prompt}`).join('\n')
  return `This brief belongs to an ongoing series. Reuse the established vocabulary (medium, lighting, palette) from these prior accepted prompts verbatim; vary only the declared subject/delta:\n${prompts}`
}

function overridesSection(overrides: PlanOverrides | undefined): string | null {
  if (!overrides || Object.keys(overrides).length === 0) return null
  return `The user has pinned these settings — do not propose anything that contradicts them (the gateway enforces them regardless of what you propose): ${JSON.stringify(overrides)}`
}

export function buildPlanSystemPrompt(intent: Intent): string {
  return `${composeSystemPromptForIntent(intent)}\n\n---\n\n${OUTPUT_CONTRACT}`
}

export function buildPlanUserMessage(request: PlanRequest, modeApplied: ModeApplied): string {
  const sections = [
    modeInstruction(modeApplied),
    intentInstruction(request.intent),
    briefOrDeltaSection(request),
    styleGuideSection(request),
    seriesContextSection(request),
    overridesSection(request.overrides),
    request.has_references
      ? 'The user has attached reference image(s) — this plan will run through the edit endpoint.'
      : null,
  ].filter((section): section is string => section !== null)
  return sections.join('\n\n')
}

export function buildPlanMessages(request: PlanRequest, modeApplied: ModeApplied): ChatMessage[] {
  return [
    { role: 'system', content: buildPlanSystemPrompt(request.intent) },
    { role: 'user', content: buildPlanUserMessage(request, modeApplied) },
  ]
}

// ---------------------------------------------------------------------------
// Upstream call + JSON parsing (retry-once on parse/validation failure)
// ---------------------------------------------------------------------------

function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenceMatch = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(trimmed)
  return fenceMatch?.[1] !== undefined ? fenceMatch[1].trim() : trimmed
}

export type ParsedLlmPlan = { data: LlmPlan } | { error: string }

/** Parse and validate one LLM completion's content against `llmPlanSchema`. Pure. */
export function parseLlmPlan(raw: string): ParsedLlmPlan {
  const text = stripCodeFence(raw)
  let candidate: unknown
  try {
    candidate = JSON.parse(text)
  } catch (err) {
    return { error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  const result = llmPlanSchema.safeParse(candidate)
  if (!result.success) {
    return {
      error: result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    }
  }
  return { data: result.data }
}

function chatCompletionsUrl(): string {
  const base = env.OPENAI_BASE_URL.replace(/\/$/, '')
  return `${base}/chat/completions`
}

const DEFAULT_MAX_COMPLETION_TOKENS = 16000

/**
 * Hang guard for the enhance model's `/chat/completions` call, not a budget
 * (rules/agent-limits.md) — a reasoning-heavy planner call can legitimately
 * spend minutes on `xhigh`/`max` effort. Deliberately >= 30 minutes and
 * independent of `upstream.ts`'s 180s default, which stays tuned for the
 * image-generation endpoints.
 */
const ENHANCE_REQUEST_TIMEOUT_MS = 1_800_000

async function callChatCompletions(
  messages: ChatMessage[],
  options: { responseFormat?: 'json_object'; maxCompletionTokens?: number } = {},
): Promise<ChatCompletionResponse> {
  const body: Record<string, unknown> = {
    model: env.ENHANCE_MODEL,
    messages,
    reasoning_effort: env.ENHANCE_REASONING_EFFORT,
    max_completion_tokens: options.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
  }
  if (options.responseFormat) body['response_format'] = { type: options.responseFormat }

  const res = await requestWithRetry(
    chatCompletionsUrl(),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    { timeoutMs: ENHANCE_REQUEST_TIMEOUT_MS },
  )
  return (await res.json()) as ChatCompletionResponse
}

/**
 * Call the enhance model requesting a single JSON object.
 * `response_format: { type: 'json_object' }` is accepted (200) by our
 * upstream for `ENHANCE_MODEL` (probed 2026-07-17 against the same endpoint
 * as `docs/research/endpoint-verification.md` — throwaway script, not
 * committed). Falls back to prompt-instructed JSON (fence-stripped by
 * `parseLlmPlan`) if a future `ENHANCE_MODEL` ever rejects the parameter —
 * detected by the rejection message naming it, not a hardcoded model
 * allowlist.
 */
export async function callPlanModel(
  messages: ChatMessage[],
  options: { maxCompletionTokens?: number } = {},
): Promise<ChatCompletionResponse> {
  try {
    return await callChatCompletions(messages, { responseFormat: 'json_object', ...options })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!message.toLowerCase().includes('response_format')) throw err
    log('plan.response_format_unsupported', { error: message })
    return callChatCompletions(messages, options)
  }
}

function sumUsage(
  a: ChatCompletionUsage | undefined,
  b: ChatCompletionUsage | undefined,
): ChatCompletionUsage {
  return {
    prompt_tokens: (a?.prompt_tokens ?? 0) + (b?.prompt_tokens ?? 0),
    completion_tokens: (a?.completion_tokens ?? 0) + (b?.completion_tokens ?? 0),
    total_tokens: (a?.total_tokens ?? 0) + (b?.total_tokens ?? 0),
    prompt_tokens_details: {
      cached_tokens:
        (a?.prompt_tokens_details?.cached_tokens ?? 0) +
        (b?.prompt_tokens_details?.cached_tokens ?? 0),
    },
  }
}

/**
 * An under-budgeted reasoning model returns HTTP 200 with empty content and
 * `finish_reason: length` — silently (rules/agent-limits.md). Never read that
 * as "the model failed"; the fix is more budget, not a smaller effort.
 */
function isTruncatedResponse(response: ChatCompletionResponse): boolean {
  const choice = response.choices[0]
  const content = choice?.message.content ?? ''
  return choice?.finish_reason === 'length' || content.trim().length === 0
}

/**
 * Call the plan model, and if the reply comes back truncated/empty, retry
 * once with double the completion-token budget before giving up. Raising the
 * budget is the correct fix for `finish_reason: length` — lowering effort is
 * not.
 */
async function callPlanModelWithBudgetRetry(
  messages: ChatMessage[],
): Promise<ChatCompletionResponse> {
  const first = await callPlanModel(messages)
  if (!isTruncatedResponse(first)) return first

  const retryBudget = DEFAULT_MAX_COMPLETION_TOKENS * 2
  log('plan.llm_truncated_retry', { maxCompletionTokens: retryBudget })
  const second = await callPlanModel(messages, { maxCompletionTokens: retryBudget })
  if (isTruncatedResponse(second)) {
    throw new PlanUpstreamError(
      'enhance model returned a truncated/empty response twice even after doubling max_completion_tokens',
      sumUsage(first.usage, second.usage),
    )
  }
  return second
}

/**
 * Thrown after the LLM's output fails validation twice (initial + one retry).
 * Carries the usage both attempts consumed — that spend is real and must still
 * reach argo, or a planner that fails often looks free.
 */
export class PlanUpstreamError extends Error {
  constructor(
    message: string,
    readonly usage: ChatCompletionUsage,
  ) {
    super(message)
  }
}

export interface PlanLlmResult {
  plan: LlmPlan
  usage: ChatCompletionUsage
}

/**
 * Request a plan from the enhance model, retrying ONCE with the validation
 * error appended to the conversation if the first reply fails to parse or
 * validate. Throws `PlanUpstreamError` if the second attempt also fails.
 */
export async function requestLlmPlan(messages: ChatMessage[]): Promise<PlanLlmResult> {
  const first = await callPlanModelWithBudgetRetry(messages)
  const firstContent = first.choices[0]?.message.content ?? ''
  const firstResult = parseLlmPlan(firstContent)
  if ('data' in firstResult)
    return { plan: firstResult.data, usage: first.usage ?? EMPTY_CHAT_USAGE }

  log('plan.llm_validation_retry', { error: firstResult.error })
  const retryMessages: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: firstContent },
    {
      role: 'user',
      content: `Your last response failed validation: ${firstResult.error}. Reply again with ONLY the corrected JSON object — no commentary, no code fences.`,
    },
  ]
  const second = await callPlanModelWithBudgetRetry(retryMessages)
  const secondContent = second.choices[0]?.message.content ?? ''
  const secondResult = parseLlmPlan(secondContent)
  const usage = sumUsage(first.usage, second.usage)
  if ('data' in secondResult) return { plan: secondResult.data, usage }

  throw new PlanUpstreamError(
    `enhance model output failed validation twice: ${secondResult.error}`,
    usage,
  )
}

const EMPTY_CHAT_USAGE: ChatCompletionUsage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
}

// ---------------------------------------------------------------------------
// Server-side post-processing — "the LLM proposes, rules.ts disposes"
// ---------------------------------------------------------------------------

const REAL_SIZE_PRESETS = SIZE_PRESETS.filter((preset) => preset !== 'auto')

/**
 * Snap an invalid size to the nearest real preset (by aspect-ratio distance
 * in log-space, so 3:2 and 2:3 are equidistant from square). Presets are
 * valid on every model, so this is a safe universal correction regardless of
 * *why* `validateSizeForModel` rejected the requested size.
 */
export function snapToNearestPreset(size: string): string {
  const match = /^(\d+)x(\d+)$/.exec(size)
  if (!match || match[1] === undefined || match[2] === undefined) return '1024x1024'
  const width = Number(match[1])
  const height = Number(match[2])
  const ratio = width / height

  let best: string = REAL_SIZE_PRESETS[0] ?? '1024x1024'
  let bestDiff = Infinity
  for (const preset of REAL_SIZE_PRESETS) {
    const [presetWidth, presetHeight] = preset.split('x').map(Number)
    if (presetWidth === undefined || presetHeight === undefined) continue
    const diff = Math.abs(Math.log(ratio) - Math.log(presetWidth / presetHeight))
    if (diff < bestDiff) {
      bestDiff = diff
      best = preset
    }
  }
  return best
}

function overlaySettings(
  proposed: LlmProposedSettings,
  overrides: PlanOverrides | undefined,
): LlmProposedSettings {
  if (!overrides) return proposed
  return {
    model: overrides.model ?? proposed.model,
    size: overrides.size ?? proposed.size,
    quality: overrides.quality ?? proposed.quality,
    background: overrides.background ?? proposed.background,
    n: overrides.n ?? proposed.n,
    moderation: overrides.moderation ?? proposed.moderation,
    input_fidelity: overrides.input_fidelity ?? proposed.input_fidelity,
    partial_images: overrides.partial_images ?? proposed.partial_images,
  }
}

export interface ResolvedSettings {
  settings: PlanSettings
  /** Correction notes, appended to the response's `assumptions`. */
  notes: string[]
}

/**
 * Overlay user overrides (verbatim, never derived over) onto the LLM's
 * proposal, then validate/correct the result through `rules.ts` — the single
 * source of truth for model routing/size/fidelity. Any correction is recorded
 * in `notes` rather than applied silently.
 */
export function resolveSettings(args: {
  proposed: LlmProposedSettings
  overrides: PlanOverrides | undefined
  hasReferences: boolean
}): ResolvedSettings {
  const notes: string[] = []
  const merged = overlaySettings(args.proposed, args.overrides)
  const endpoint = args.hasReferences ? 'edit' : 'generate'

  const model = resolveModel({ model: merged.model, endpoint, quality: merged.quality })
  const reason = routingReason({ model: merged.model, endpoint, quality: merged.quality })
  if (reason) notes.push(`Routed to ${model}: ${reason}.`)

  // `/enhance` is advisory — it returns settings the user is about to run, so
  // it corrects an impossible background here (with a note) instead of handing
  // back a plan that `/generate` would then reject with a 400. The hard refusal
  // lives on the request path; this is the "rules.ts disposes" counterpart.
  let background = merged.background
  const backgroundError = validateBackgroundForModel(model, background)
  if (backgroundError) {
    notes.push(`Forced background to opaque: ${backgroundError}.`)
    background = 'opaque'
  }

  let quality = merged.quality
  const qualityError = validateQualityForModel(model, quality)
  if (qualityError) {
    notes.push(`Dropped to quality high: ${qualityError}.`)
    quality = 'high'
  }

  let size = merged.size
  const sizeError = validateSizeForModel(model, size)
  if (sizeError) {
    const snapped = snapToNearestPreset(size)
    notes.push(
      `Requested size "${size}" is invalid for ${model} (${sizeError}); snapped to ${snapped}.`,
    )
    size = snapped
  }

  let inputFidelity = merged.input_fidelity
  if (inputFidelity !== undefined) {
    const fidelityError = validateInputFidelityForModel(model, inputFidelity)
    if (fidelityError) {
      notes.push(`Dropped input_fidelity: ${fidelityError}.`)
      inputFidelity = undefined
    }
  }

  const settings: PlanSettings = {
    endpoint,
    model,
    size,
    quality,
    background,
    n: merged.n,
    moderation: merged.moderation,
    partial_images: merged.partial_images,
    ...(inputFidelity !== undefined ? { input_fidelity: inputFidelity } : {}),
  }

  return { settings, notes }
}

// ---------------------------------------------------------------------------
// Verbatim containment check
// ---------------------------------------------------------------------------

/**
 * Extract every quoted string and concrete token (numbers, hex colors,
 * capitalized proper nouns) from a source text. The first word of the text is
 * excluded from the proper-noun pass — it's almost always just sentence-case,
 * not a name worth preserving.
 */
export function extractVerbatimTokens(text: string): string[] {
  const tokens = new Set<string>()

  for (const match of text.matchAll(/"([^"]+)"/g)) {
    if (match[1]) tokens.add(match[1])
  }
  for (const match of text.matchAll(/'([^']+)'/g)) {
    if (match[1]) tokens.add(match[1])
  }
  for (const match of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    tokens.add(match[0])
  }
  for (const match of text.matchAll(/\b\d+(?:\.\d+)?\b/g)) {
    tokens.add(match[0])
  }

  const words = text.split(/\s+/)
  words.forEach((word, index) => {
    if (index === 0) return
    const clean = word.replace(/^[^A-Za-z0-9#]+|[^A-Za-z0-9#]+$/g, '')
    if (/^[A-Z][a-zA-Z]{2,}$/.test(clean)) tokens.add(clean)
  })

  return [...tokens]
}

/** Server-side containment post-check: does every concrete token from `source` survive into `prompt`? Advisory — never fails the request. */
export function checkVerbatim(source: string, prompt: string): VerbatimCheck {
  const missing = extractVerbatimTokens(source).filter((token) => !prompt.includes(token))
  return { ok: missing.length === 0, missing }
}

// ---------------------------------------------------------------------------
// Final prompt assembly (passthrough enforcement)
// ---------------------------------------------------------------------------

/**
 * In every mode but `off`, the LLM's own `prompt` field is the finished
 * prompt (already playbook-ordered with its terminal constraint block). In
 * `off` (passthrough), the gateway enforces "prompt unchanged" itself rather
 * than trusting the LLM to have left it alone — the Berkeley-finding taboo
 * this design is built around (docs/concept.md §2) — only splicing on an
 * LLM-suggested `constraint_block`.
 */
export function composeFinalPrompt(args: {
  modeApplied: ModeApplied
  request: PlanRequest
  llmPrompt: string
  constraintBlock: string | undefined
}): string {
  if (args.modeApplied !== 'off') return args.llmPrompt
  const base = (args.request.current_prompt ?? args.request.brief ?? '').trim()
  if (!args.constraintBlock) return base
  return `${base}\n\n${args.constraintBlock.trim()}`
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface PlanResult {
  response: PlanResponse
  usage: ChatCompletionUsage
}

/** Build a full `/enhance` v2 response from a validated `PlanRequest`. The single entry point the route calls. */
export async function planFromRequest(request: PlanRequest): Promise<PlanResult> {
  const modeApplied = computeModeApplied(request)
  const messages = buildPlanMessages(request, modeApplied)
  const { plan: llm, usage } = await requestLlmPlan(messages)

  const intent =
    request.intent === 'auto'
      ? llm.intent
      : { detected: request.intent, confidence: llm.intent.confidence }

  const prompt = composeFinalPrompt({
    modeApplied,
    request,
    llmPrompt: llm.prompt,
    constraintBlock: llm.constraint_block,
  })

  const { settings, notes } = resolveSettings({
    proposed: llm.proposed_settings,
    overrides: request.overrides,
    hasReferences: request.has_references,
  })

  const sourceText = request.brief ?? request.delta ?? ''
  const verbatim_check = checkVerbatim(sourceText, prompt)

  const estimated_cost = estimateCost({
    model: settings.model,
    quality: settings.quality,
    size: settings.size,
    streaming: settings.partial_images > 0,
    n: settings.n,
  })

  const response: PlanResponse = {
    intent,
    prompt,
    additions: modeApplied === 'off' ? [] : llm.additions,
    verbatim_check,
    assumptions: [...llm.assumptions, ...notes],
    settings,
    estimated_cost,
    warnings: llm.warnings,
    mode_applied: modeApplied,
    playbook_version: PLAYBOOK_VERSION,
    enhance_model: env.ENHANCE_MODEL,
  }

  return { response, usage }
}
