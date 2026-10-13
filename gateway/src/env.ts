import { z } from 'zod'

const Env = z.object({
  PORT: z.coerce.number().default(7716),
  API_SECRET: z.string().min(1),
  // Full OpenAI-compatible base URL (including any path prefix). `/images/generations`
  // is appended by src/lib/upstream.ts — never hardcode `/openai/v1` or similar here.
  OPENAI_BASE_URL: z.url(),
  OPENAI_API_KEY: z.string().min(1),
  // Text model for `POST /enhance` (brief -> fuller prompt), called via
  // `/chat/completions` on the same upstream. Confirmed present by a live
  // `/responses` probe (2026-07-16) — see routes/enhance.ts.
  //
  // Pinned to a concrete id, never the `gpt-5.6` alias this used to carry: that
  // alias resolves server-side (probed 2026-09-12 -> `gpt-5.6-sol`) and can be
  // re-pointed at another tier without notice, silently changing both output
  // and bill.
  //
  // gpt-6-luna at effort "high": expanding a brief into a structured JSON plan
  // is short single-shot work. Moved off deepseek-v4.1-flash 2026-10-08 —
  // gpt-6-luna passed modelpick's fast bench 15/15 at every effort at a third
  // of DeepSeek's token price, and a live probe confirmed `response_format:
  // json_object` at high/medium/none. See modelpick/docs/decisions/model-configs.md.
  ENHANCE_MODEL: z.string().min(1).default('gpt-6-luna'),
  // Top-level `reasoning_effort` sent with every ENHANCE_MODEL call. Restricted
  // to the ladder probed on this endpoint for gpt-6-luna.
  ENHANCE_REASONING_EFFORT: z.enum(['none', 'low', 'medium', 'high']).default('high'),
  // Replicate route on the same proxy (`/cutout`, `/icons`). Optional: derived from
  // OPENAI_BASE_URL by swapping the trailing `/openai/v1` for `/replicate/v1` — see
  // src/lib/replicate.ts. Set only when that derivation does not apply.
  REPLICATE_BASE_URL: z.url().optional(),
  ARGO_USAGE_URL: z.url().optional(),
  ARGO_API_SECRET: z.string().optional(),
  // Labels usage telemetry records so local dev runs don't get counted as VPS traffic.
  MACHINE: z.string().min(1).default('vps'),
})

export const env = Env.parse(process.env)
