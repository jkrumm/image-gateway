import type { Cost, Usage } from '@image-gateway/shared'
import { log } from './log.js'

/** Which route produced the line, so `make logs` can tell generations, edits and plans apart. */
export type RequestSubTool = 'generate' | 'edit' | 'enhance' | 'cutout' | 'icons'

const EMPTY_COST: Cost = { usd: null, source: 'none' }
const ZERO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 }

/**
 * The one per-request outcome sink: every finished generate/edit/enhance/cutout/icons call
 * (success or upstream failure, streamed or not) passes through here and writes the
 * `request.done` log line — `make logs` otherwise shows nothing for a healthy gateway.
 */
function logRequestDone(args: {
  requestId: string
  model: string
  subTool: RequestSubTool
  usage: Usage
  cost: Cost
  durationMs: number
  outcome: 'ok' | 'error'
}): void {
  log('request.done', {
    requestId: args.requestId,
    subTool: args.subTool,
    model: args.model,
    outcome: args.outcome,
    durationMs: args.durationMs,
    costUsd: args.cost.usd,
    outputTokens: args.usage.output_tokens,
  })
}

/** Log a successful request. */
export function logRequestOk(args: {
  requestId: string
  model: string
  subTool: RequestSubTool
  usage: Usage
  cost: Cost
  durationMs: number
}): void {
  logRequestDone({ ...args, outcome: 'ok' })
}

/**
 * Log a failed request. Logging only successes leaves `outcome` permanently `'ok'`, which
 * reads as a service that has never failed rather than one that isn't measured.
 *
 * `usage` is optional because most failures produce no token counts — but an
 * enhance failure does (the planner burns tokens on both attempts before giving
 * up), and that spend is real. Pass it whenever it's known.
 */
export function logRequestError(args: {
  requestId: string
  model: string
  subTool: RequestSubTool
  durationMs: number
  // Explicit `| undefined`: `exactOptionalPropertyTypes` is on, and callers pass
  // the field through conditionally rather than omitting the key.
  usage?: Usage | undefined
  cost?: Cost | undefined
}): void {
  logRequestDone({
    requestId: args.requestId,
    model: args.model,
    subTool: args.subTool,
    durationMs: args.durationMs,
    usage: args.usage ?? ZERO_USAGE,
    cost: args.cost ?? EMPTY_COST,
    outcome: 'error',
  })
}
