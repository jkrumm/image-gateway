import { env } from '../env.js'
import type { Cost, Usage } from '@image-gateway/shared'
import { log } from './log.js'

/**
 * Which route produced the record. Argo groups on `sub_tool`, so without this
 * every generation, edit and plan collapses into one `(unset)` bucket.
 */
export type UsageSubTool = 'generate' | 'edit' | 'enhance' | 'cutout' | 'icons'

const EMPTY_COST: Cost = { usd: null, source: 'none' }
const ZERO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 }

/**
 * The one per-request outcome sink: every finished generate/edit/enhance/cutout/icons call
 * (success or upstream failure, streamed or not) passes through here, so it
 * writes the `request.done` log line — `make logs` otherwise shows nothing for
 * a healthy gateway — then fire-and-forgets the record to argo. The argo POST
 * is a strict no-op when its env vars are unset; failures are logged, never
 * thrown, and never block the caller.
 */
async function postRecord(args: {
  requestId: string
  /** Argo upserts on source + source_id + machine; a request with several records needs one each. */
  sourceId?: string | undefined
  model: string
  subTool: UsageSubTool
  usage: Usage
  cost: Cost
  durationMs: number
  outcome: 'ok' | 'error'
}): Promise<void> {
  log('request.done', {
    requestId: args.requestId,
    subTool: args.subTool,
    model: args.model,
    outcome: args.outcome,
    durationMs: args.durationMs,
    costUsd: args.cost.usd,
    outputTokens: args.usage.output_tokens,
  })

  if (!env.ARGO_USAGE_URL || !env.ARGO_API_SECRET) return
  const usageUrl = env.ARGO_USAGE_URL
  const apiSecret = env.ARGO_API_SECRET

  try {
    const now = new Date().toISOString()
    const record = {
      source: 'image-gateway',
      source_id: args.sourceId ?? args.requestId,
      grain: 'request',
      ts: now,
      ingested_at: now,
      model: args.model,
      model_norm: args.model,
      // argo's ingest derives `workspace` from `project` only for path-driven
      // sources (claude-code, litellm) and leaves it NULL otherwise — and its
      // dashboard filters workspace with an `IN (...)` list, which never matches
      // NULL. A service that omits these disappears from every chart the moment
      // the Private/Work filter is touched, so both are declared explicitly.
      project: 'image-gateway',
      workspace: 'private',
      sub_tool: args.subTool,
      machine: env.MACHINE,
      billing: 'iu',
      outcome: args.outcome,
      input_tokens: args.usage.input_tokens,
      output_tokens: args.usage.output_tokens,
      cache_read_tokens: args.usage.input_tokens_details?.cached_tokens ?? 0,
      cache_write_tokens: 0,
      // Reasoning is already folded into `completion_tokens`/`output_tokens` on
      // this endpoint — no separate reasoning field to report.
      reasoning_tokens: 0,
      duration_ms: args.durationMs,
      cost_usd: args.cost.usd,
      cost_source: args.cost.source,
      raw: null,
    }

    const res = await fetch(usageUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiSecret}`,
      },
      body: JSON.stringify({ records: [record] }),
    })

    // fetch only rejects on network failure, so an auth or schema rejection from
    // argo would otherwise drop the record in total silence.
    if (!res.ok) {
      log('usage.report_rejected', { status: res.status, statusText: res.statusText })
    }
  } catch (err) {
    log('usage.report_failed', { error: String(err) })
  }
}

/** Report a successful request. */
export function reportUsage(args: {
  requestId: string
  sourceId?: string | undefined
  model: string
  subTool: UsageSubTool
  usage: Usage
  cost: Cost
  durationMs: number
}): Promise<void> {
  return postRecord({ ...args, outcome: 'ok' })
}

/**
 * Report a failed request so argo's error-rate view can see it. Reporting only
 * successes leaves `outcome` permanently `'ok'`, which reads as a service that
 * has never failed rather than one that isn't measured.
 *
 * `usage` is optional because most failures produce no token counts — but an
 * enhance failure does (the planner burns tokens on both attempts before giving
 * up), and that spend is real. Pass it whenever it's known.
 */
export function reportUsageError(args: {
  requestId: string
  sourceId?: string | undefined
  model: string
  subTool: UsageSubTool
  durationMs: number
  // Explicit `| undefined`: `exactOptionalPropertyTypes` is on, and callers pass
  // the field through conditionally rather than omitting the key.
  usage?: Usage | undefined
  cost?: Cost | undefined
}): Promise<void> {
  return postRecord({
    requestId: args.requestId,
    sourceId: args.sourceId,
    model: args.model,
    subTool: args.subTool,
    durationMs: args.durationMs,
    usage: args.usage ?? ZERO_USAGE,
    cost: args.cost ?? EMPTY_COST,
    outcome: 'error',
  })
}
