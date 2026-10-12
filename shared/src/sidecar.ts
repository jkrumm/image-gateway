import { z } from 'zod'
import {
  costSchema,
  editRequestSchema,
  generateRequestSchema,
  KNOWN_IMAGE_MODELS,
  usageSchema,
} from './contract.js'
import {
  INTENTS,
  PLAN_MODES,
  PLAN_WARNING_SEVERITIES,
  planAdditionSchema,
  promptFragmentSchema,
} from './plan.js'

/**
 * Sidecar schema 2 — see docs/concept.md §6. Additive over app/src/lib/
 * metadata.ts's schema-1 `generationMetadataSchema`: every schema-1 field is
 * carried forward except `kind` (gains `import`) and `parent_id` (replaced by
 * the richer `parent` object below). G3 owns the 1→2 read-time migration and
 * the app-side consumer; this module is the new source of truth it migrates
 * onto — it deliberately does not import app/src/lib/metadata.ts.
 *
 * NOT carried forward: `derivatives` (Refine's baked exports). Its `recipe`
 * field is typed against app/src/lib/imaging/recipe.ts, which shared cannot
 * depend on — see the G1 report for this as a flagged decision for G3.
 */

export const ROLES = [
  'style-source',
  'logo',
  'icon',
  'color-scheme',
  'reference',
  'final',
  'draft',
] as const
export type Role = (typeof ROLES)[number]

export const PARENT_OPS = ['tweak', 'rerun', 'edit', 'promote', 'series', 'refine'] as const
export type ParentOp = (typeof PARENT_OPS)[number]

export const GENERATION_KINDS = ['generate', 'edit', 'import'] as const
export type GenerationKind = (typeof GENERATION_KINDS)[number]

export const MODERATION_STAGES = ['input', 'output'] as const
export type ModerationStage = (typeof MODERATION_STAGES)[number]

/** Delivery targets recorded in sidecars. Read-path only: the image-share integration was
 * retired, so nothing writes `publications` any more, but existing sidecars keep parsing (and
 * keep the field through a metadata patch round-trip). Never shrink — see the retired-model
 * rule in AGENTS.md. */
export const PUBLICATION_TARGETS = ['image-share'] as const
export type PublicationTarget = (typeof PUBLICATION_TARGETS)[number]

/**
 * Mirrors app/src/lib/metadata.ts's `generationParamsSchema` shape, reusing
 * the gateway contract's own field schemas (same pattern, same rationale —
 * see that file's comment) so a reconstructed request stays in sync with the
 * contract by construction.
 */
export const generationParamsSchema = z.object({
  size: z.string(),
  // quality/background mirror the gateway RESPONSE (a resolved plain string) not the request enum.
  quality: z.string(),
  background: z.string(),
  output_format: generateRequestSchema.shape.output_format,
  output_compression: generateRequestSchema.shape.output_compression,
  n: generateRequestSchema.shape.n,
  moderation: generateRequestSchema.shape.moderation,
  // Edit-only — only meaningful for models where MODEL_CAPABILITIES.inputFidelity is true.
  input_fidelity: editRequestSchema.shape.input_fidelity,
})
export type GenerationParams = z.infer<typeof generationParamsSchema>

const baseImageRefSchema = z.object({
  filename: z.string(),
  format: z.enum(['png', 'webp', 'jpeg']),
})

/** One output image. `roles`/`starred` are new in schema 2. */
export const generationImageV2Schema = baseImageRefSchema.extend({
  roles: z.array(z.enum(ROLES)).default([]),
  starred: z.boolean().default(false),
})
export type GenerationImageV2 = z.infer<typeof generationImageV2Schema>

/**
 * Lineage back-pointer. Only `id` is guaranteed.
 *
 * concept §6 sketches the fully-known case (`{ id, image, op }`), but no real record carries it:
 * every sidecar probed on disk (2026-07-19) has only a flat `parent_id` string, and the app's
 * current save paths know the parent id without knowing which output image was used or, for a
 * plain re-run, which op produced it. `image`/`op` are therefore optional — recorded when the
 * caller genuinely knows them, omitted rather than guessed when it doesn't.
 */
export const generationParentSchema = z.object({
  id: z.string(),
  image: z.string().optional(),
  op: z.enum(PARENT_OPS).optional(),
})
export type GenerationParent = z.infer<typeof generationParentSchema>

/**
 * One historical delivery record (retired image-share integration; read-only). `image_share_id`
 * was set when the file landed in image-share; `published_key`/`cdn_url` only after publishing.
 */
export const generationPublicationSchema = z.object({
  target: z.enum(PUBLICATION_TARGETS),
  image_share_id: z.number().int(),
  published_key: z.string().optional(),
  cdn_url: z.string().optional(),
  published_at: z.string(),
})
export type GenerationPublication = z.infer<typeof generationPublicationSchema>

export const planWarningRecordSchema = z.object({
  code: z.string(),
  severity: z.enum(PLAN_WARNING_SEVERITIES),
  action: z.enum(['accepted', 'dismissed']),
})
export type PlanWarningRecord = z.infer<typeof planWarningRecordSchema>

/**
 * The accepted Plan = the eval tuple (docs/concept.md §6). Distinct from
 * `plan.ts`'s `planResponseSchema` — this is what got written to disk after
 * the user acted on it (edited the prompt or not, accepted/dismissed each
 * warning), not the raw gateway response.
 */
export const sidecarEnhanceSchema = z.object({
  brief: z.string(),
  intent: z.enum(INTENTS),
  mode_applied: z.enum(PLAN_MODES),
  plan_prompt: z.string(),
  final_prompt_edited: z.boolean(),
  /** Gap-fills the enhancer made, mirroring the `/enhance` response's `additions` shape. */
  additions: z.array(planAdditionSchema).default([]),
  /** Free-text notes on what the enhancer assumed or corrected — mirrors the response's `assumptions`. */
  assumptions: z.array(z.string()).default([]),
  warnings: z.array(planWarningRecordSchema).default([]),
  series_context_ids: z.array(z.string()).default([]),
  playbook_version: z.string(),
  enhance_model: z.string(),
})
export type SidecarEnhance = z.infer<typeof sidecarEnhanceSchema>

export const moderationOutcomeSchema = z.object({
  blocked: z.boolean(),
  stage: z.enum(MODERATION_STAGES),
  categories: z.array(z.string()).default([]),
})
export type ModerationOutcome = z.infer<typeof moderationOutcomeSchema>

/** `<id>/metadata.json` sidecar, schema 2. */
export const generationMetadataV2Schema = z.object({
  schema: z.literal(2),
  id: z.string(),
  created_at: z.string(),
  kind: z.enum(GENERATION_KINDS).default('generate'),
  prompt: z.string(),
  /**
   * `KNOWN_IMAGE_MODELS`, not `IMAGE_MODELS`: this is historical data, and
   * `listGenerations()` (app) silently skips sidecars that fail to parse, so
   * a retired model (e.g. gpt-image-1.5) must stay parseable here forever.
   */
  requested_model: z.enum([...KNOWN_IMAGE_MODELS, 'auto'] as const),
  model: z.enum(KNOWN_IMAGE_MODELS),
  routed: z.boolean(),
  routing_reason: z.string().optional(),
  params: generationParamsSchema,
  images: z.array(generationImageV2Schema),
  /** Input images saved alongside an edit (`input-1.<ext>`, `input-2.<ext>`, …). */
  input_images: z.array(baseImageRefSchema).optional(),
  /** Mask saved alongside an edit (`mask.png`), when one was supplied. */
  mask: baseImageRefSchema.optional(),
  usage: usageSchema,
  cost: costSchema,
  latency_ms: z.number(),
  gateway_version: z.string().optional(),
  /** Replaces schema 1's `parent_id` string with the richer lineage edge. */
  parent: generationParentSchema.optional(),
  project_ids: z.array(z.string()).default([]),
  style_guide_ids: z.array(z.string()).default([]),
  /** Snapshot of the style fragment actually woven in — guides evolve, records don't. */
  style_fragment_used: z.string().optional(),
  enhance: sidecarEnhanceSchema.optional(),
  moderation_outcome: moderationOutcomeSchema.optional(),
  /** Historical delivery records from the retired image-share integration. Parsed and preserved,
   * never written or used. */
  publications: z.array(generationPublicationSchema).optional(),
})
export type GenerationMetadataV2 = z.infer<typeof generationMetadataV2Schema>

/**
 * `.imagegen/projects/<slug>.json`. Membership lives in each item's sidecar
 * (`project_ids`), not here — one writer per fact (docs/concept.md §3).
 */
export const projectSchema = z.object({
  slug: z.string(),
  name: z.string(),
  notes: z.string().default(''),
  default_style_guide_id: z.string().optional(),
  default_intent: z.enum(INTENTS).optional(),
  anchor_ids: z.array(z.string()).default([]),
})
export type Project = z.infer<typeof projectSchema>

export const paletteColorSchema = z.object({
  hex: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'hex must be a 6-digit #rrggbb color'),
  role: z.string(),
})
export type PaletteColor = z.infer<typeof paletteColorSchema>

/**
 * `.imagegen/styles/<slug>/style.json` (docs/concept.md §3). Reference
 * images live alongside at `refs/`; original sources (design.md/screenshot/
 * CSS) at `sources/` for re-distillation — both are files on disk, not part
 * of this schema.
 */
export const styleGuideSchema = z.object({
  slug: z.string(),
  name: z.string(),
  /** Verbatim hexes with a role label (e.g. "primary", "accent") — never paraphrased. */
  palette: z.array(paletteColorSchema).default([]),
  /** Free-text typography feel ("confident geometric sans"), not a font name. */
  typography: z.string().optional(),
  /** Medium/texture/mood/lighting vocabulary words distilled from the sources. */
  vocabulary: z.array(z.string()).default([]),
  prompt_fragment: promptFragmentSchema,
  avoid: z.array(z.string()).default([]),
  /** Filenames under this style's `refs/` directory. */
  reference_images: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).optional(),
})
export type StyleGuide = z.infer<typeof styleGuideSchema>

/**
 * `.imagegen/drafts/create.json` — persisted Create-surface state, kept
 * minimal (docs/concept.md §6: "half-finished work is resumable... without a
 * heavier session entity").
 */
export const createDraftSchema = z.object({
  brief: z.string(),
  prompt: z.string().optional(),
  settings: generationParamsSchema.partial().optional(),
  reference_paths: z.array(z.string()).default([]),
  style_guide_ids: z.array(z.string()).default([]),
})
export type CreateDraft = z.infer<typeof createDraftSchema>
