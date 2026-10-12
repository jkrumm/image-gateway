import {
  generationImageV2Schema,
  generationMetadataV2Schema,
  generationParamsSchema,
  type GenerationParams,
} from '@image-gateway/shared'
import { z } from 'zod'
import { recipeSchema } from './imaging/recipe'

/**
 * The schema-2 sidecar shape (params, per-image roles/starred, parent/lineage, project_ids,
 * style_guide_ids, the accepted `enhance` record, `moderation_outcome`) is built once in
 * `shared/src/sidecar.ts` — the gateway needs the same shapes for `/enhance` responses and style
 * guides, so this file extends that schema rather than re-declaring it in parallel. Only
 * `derivatives` (Refine's baked exports, typed against app/src/lib/imaging/recipe.ts, which
 * `shared` cannot depend on) is added locally.
 */
export { generationParamsSchema }
export type { GenerationParams }

/**
 * Kept for existing call sites (library.ts's write helpers, Library.tsx's read helpers) that
 * predate schema 2's split between `images[]` (curated, has roles/starred) and `input_images`/
 * `mask` (bare refs, no roles/starred). The *input* type — roles/starred optional, since they're
 * defaulted — covers all three shapes at write time, before `.parse()` fills the defaults in.
 */
export const generationImageMetaSchema = generationImageV2Schema
export type GenerationImageMeta = z.input<typeof generationImageMetaSchema>

/**
 * One baked PNG written by the Refine workbench to `<id>/derived/<path>.png` (e.g.
 * `favicon-32.png`, or `<name>.iconset/icon_16x16.png` for the macOS iconset preset — `filename`
 * is relative to the generation's `derived/` directory and may contain a subfolder).
 *
 * `listGenerations()` silently skips sidecars that fail `safeParse` — every field here must stay
 * optional-or-defaulted so a pre-Refine sidecar with no `derivatives` key keeps parsing rather
 * than vanishing from the library. See `metadata.test.ts` for the pinned regression.
 */
export const generationDerivativeSchema = z.object({
  filename: z.string(),
  /** Human label, e.g. "macOS iconset", "Favicon 32". */
  label: z.string().optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  createdAt: z.string(),
  /** The Refine recipe that produced this derivative, so "Refine again" can reopen the workbench
   * seeded with it. Optional — derivatives exported before this field existed have none. */
  recipe: recipeSchema.optional(),
})
export type GenerationDerivative = z.infer<typeof generationDerivativeSchema>

/** Sidecar written alongside every generation's images at `~/Pictures/ImageGen/<id>/metadata.json`,
 * schema 2 (docs/concept.md §6). */
export const generationMetadataSchema = generationMetadataV2Schema.extend({
  /** Baked exports written by the Refine workbench (macOS iconset, favicon set, single PNG, …).
   * Optional so sidecars written before Refine existed keep parsing. App-local — not part of the
   * shared contract (see the module comment above). */
  derivatives: z.array(generationDerivativeSchema).optional(),
})
export type GenerationMetadata = z.infer<typeof generationMetadataSchema>
/**
 * Pre-parse shape accepted by `.parse()`/`.safeParse()` — every defaulted field (`schema`'s
 * `kind`, each image's `roles`/`starred`, `project_ids`, `style_guide_ids`, …) is optional here,
 * unlike `GenerationMetadata` (the fully-resolved output type, where zod v4 makes defaulted
 * fields required). `library.ts`'s write helpers build against this type, not `GenerationMetadata`.
 */
export type GenerationMetadataInput = z.input<typeof generationMetadataSchema>

/**
 * Read-time migration for schema-1 sidecars (no `schema` key at all — none of the real sidecars
 * probed this session had one, so detecting on `schema === 1` would silently fail to migrate
 * every existing generation). Legacy-detection predicate is `!('schema' in json)`, per the brief.
 *
 * Every schema-2 field with a zod `.default()` (kind, roles/starred, project_ids, style_guide_ids,
 * …) is filled in by `generationMetadataSchema.parse()`/`.safeParse()` itself — this function only
 * handles the one thing zod can't do on its own: renaming the flat `parent_id` string into the
 * richer `parent` object, inferring `op: 'edit'` in the one case the record actually tells us
 * (kind === 'edit' with a parent_id) and omitting `op` otherwise rather than guessing. Every other
 * field, recognized or not, passes through via the `rest` spread. Migration never rewrites the
 * sidecar on disk — it upgrades lazily whenever something re-saves it (`library.ts`, `derived.ts`).
 */
export function migrateGenerationMetadata(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const record = raw as Record<string, unknown>
  if ('schema' in record) return record

  const { parent_id, ...rest } = record
  if (typeof parent_id !== 'string') {
    return { ...rest, schema: 2 }
  }

  return {
    ...rest,
    schema: 2,
    parent: { id: parent_id, ...(rest['kind'] === 'edit' ? { op: 'edit' as const } : {}) },
  }
}
