import { Elysia } from 'elysia'
import {
  errorResponseSchema,
  planRequestSchema,
  planResponseSchema,
  type Usage,
} from '@image-gateway/shared'
import { env } from '../env.js'
import { planFromRequest, PlanUpstreamError, type ChatCompletionUsage } from '../lib/enhance.js'
import { computeCost } from '../lib/pricing.js'
import { reportUsage, reportUsageError } from '../lib/usage.js'
import { log } from '../lib/log.js'

/**
 * Chat-completions usage (prompt_tokens/completion_tokens) has no text/image
 * split, unlike the image endpoints' `input_tokens_details` — this is a pure-text
 * call, so `text_tokens`/`image_tokens` are left unset rather than guessed at.
 * `cached_tokens` does carry through (a subset of `prompt_tokens`, priced at the
 * cached rate by `computeCost`). Already summed across both LLM calls if the
 * plan needed a retry (`requestLlmPlan`).
 */
function toUsage(chat: ChatCompletionUsage): Usage {
  const cachedTokens = chat.prompt_tokens_details?.cached_tokens
  return {
    input_tokens: chat.prompt_tokens,
    output_tokens: chat.completion_tokens,
    total_tokens: chat.total_tokens,
    ...(cachedTokens !== undefined
      ? { input_tokens_details: { cached_tokens: cachedTokens } }
      : {}),
  }
}

export const enhanceRoutes = new Elysia().post(
  '/enhance',
  async ({ body, status }) => {
    const requestId = crypto.randomUUID()
    const t0 = performance.now()

    let result
    try {
      result = await planFromRequest(body)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'upstream request failed'
      log('enhance.upstream_error', { error: message, requestId })
      // A validation-retry failure still burned tokens on both attempts — report
      // them, or a planner that fails often reads as free.
      const spent = err instanceof PlanUpstreamError ? toUsage(err.usage) : undefined
      void reportUsageError({
        requestId,
        model: env.ENHANCE_MODEL,
        subTool: 'enhance',
        durationMs: Math.round(performance.now() - t0),
        usage: spent,
        cost: spent ? computeCost(env.ENHANCE_MODEL, spent) : undefined,
      })
      return status(502, { error: { message, type: 'upstream_error' } })
    }

    const latencyMs = Math.round(performance.now() - t0)

    const usage = toUsage(result.usage)
    // Priced from `pricing.ts`'s TEXT_RATES, not RATES — a text model, not an
    // image one. A model missing from that table still yields
    // `{ usd: null, source: 'none' }`, which argo renders as $0.
    const cost = computeCost(env.ENHANCE_MODEL, usage)

    void reportUsage({
      requestId,
      model: env.ENHANCE_MODEL,
      subTool: 'enhance',
      usage,
      cost,
      durationMs: latencyMs,
    })

    return result.response
  },
  {
    body: planRequestSchema,
    response: {
      200: planResponseSchema,
      502: errorResponseSchema,
    },
    detail: {
      tags: ['Prompts'],
      summary: 'Plan an image generation from a brief',
      description:
        'Compiles the versioned playbook (`shared/playbook/`) into a system prompt, asks the enhance model (`ENHANCE_MODEL`) for a single structured plan, then resolves the proposed settings through `rules.ts`, runs a server-side verbatim containment check, and estimates cost — before any image is generated. Never generates an image; the caller reviews the plan, then calls `/generate` or `/edit` with the returned settings. Supports fresh briefs and delta iteration on an accepted `current_prompt`.',
      security: [{ BearerAuth: [] }],
    },
  },
)
