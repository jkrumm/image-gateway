import { z } from 'zod'
import { costSchema } from './contract'

/**
 * Background removal runs on Replicate, reached through the same IU proxy and key as the OpenAI
 * upstream (see docs/research/endpoint-verification.md, 2026-10-13). Both are OFFICIAL models, so
 * they are called by `owner/name` with no version hash.
 */
export const CUTOUT_MODELS = [
  'recraft-ai/recraft-remove-background',
  'bria/remove-background',
] as const
export type CutoutModel = (typeof CUTOUT_MODELS)[number]

/** Recraft: cheaper, faster, keeps input resolution, tuned for AI-generated content. */
export const DEFAULT_CUTOUT_MODEL: CutoutModel = 'recraft-ai/recraft-remove-background'

/** Flat per-run price in USD (Replicate bills per run, not per token). */
export const CUTOUT_PRICE_USD: Record<CutoutModel, number> = {
  'recraft-ai/recraft-remove-background': 0.01,
  'bria/remove-background': 0.018,
}

/** recraft's documented input limits; enforced for both models so the cutout contract is uniform. */
export const CUTOUT_LIMITS = {
  maxImageBytes: 5 * 1024 * 1024,
  maxPixels: 16_000_000,
  minEdge: 256,
  maxEdge: 4096,
} as const

/** Master artwork for `/icons` — generous, since it is downscaled before any cutout call. */
export const ICONS_LIMITS = {
  maxImageBytes: 20 * 1024 * 1024,
} as const

export const cutoutRequestSchema = z.object({
  model: z.enum(CUTOUT_MODELS).default(DEFAULT_CUTOUT_MODEL),
})
export type CutoutRequest = z.infer<typeof cutoutRequestSchema>

export const cutoutResponseSchema = z.object({
  id: z.string(),
  model: z.enum(CUTOUT_MODELS),
  image: z.object({ b64_json: z.string(), format: z.literal('png') }),
  width: z.number().int(),
  height: z.number().int(),
  cost: costSchema,
  latency_ms: z.number(),
})
export type CutoutResponse = z.infer<typeof cutoutResponseSchema>

export const CUTOUT_MODES = ['auto', 'always', 'never'] as const

export const iconsRequestSchema = z.object({
  /** Fill for the OPAQUE targets only (apple-touch-icon, icon-mask, icon-1024). */
  background: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'background must be a #rrggbb hex color')
    .default('#ffffff'),
  /** `auto` cuts out only when the master has no real transparency. */
  cutout: z.enum(CUTOUT_MODES).default('auto'),
  cutout_model: z.enum(CUTOUT_MODELS).default(DEFAULT_CUTOUT_MODEL),
})
export type IconsRequest = z.infer<typeof iconsRequestSchema>
export type IconsRequestInput = z.input<typeof iconsRequestSchema>

export const iconFileSchema = z.object({
  name: z.string(),
  mime: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  b64: z.string(),
})
export type IconFile = z.infer<typeof iconFileSchema>

export const iconsManifestSchema = z.object({
  icons: z.array(
    z.object({
      src: z.string(),
      sizes: z.string(),
      type: z.string(),
      purpose: z.string().optional(),
    }),
  ),
})
export type IconsManifest = z.infer<typeof iconsManifestSchema>

export const iconsResponseSchema = z.object({
  id: z.string(),
  files: z.array(iconFileSchema),
  /** `<link>` tags for the web targets, ready to paste into `<head>`. */
  html: z.string(),
  /** The `icons` array for a web app manifest. */
  manifest: iconsManifestSchema,
  /** Present only when a cutout actually ran. */
  cutout: z.object({ model: z.enum(CUTOUT_MODELS), cost: costSchema }).nullable(),
  cost: costSchema,
  latency_ms: z.number(),
})
export type IconsResponse = z.infer<typeof iconsResponseSchema>
