/**
 * Pure half of the roles-editor write path — computing the next `images[]` array for a patch.
 * `library.ts#updateGenerationMetadata` does the actual disk write; kept separate so the decision
 * logic (which image, which roles/starred) is unit-testable without a Tauri runtime.
 */
import type { GenerationImageV2, Role } from '@image-gateway/shared'

/** Returns a copy of `images` with the image at `filename` given exactly `roles` (replaces, does
 * not merge — the roles editor is a multi-select of the closed vocabulary, so it always submits
 * the full next set). Every other image is returned unchanged (same reference). */
export function withImageRoles(
  images: GenerationImageV2[],
  filename: string,
  roles: Role[],
): GenerationImageV2[] {
  return images.map((image) => (image.filename === filename ? { ...image, roles } : image))
}

/** Returns a copy of `images` with the image at `filename`'s `starred` flag set. */
export function withImageStarred(
  images: GenerationImageV2[],
  filename: string,
  starred: boolean,
): GenerationImageV2[] {
  return images.map((image) => (image.filename === filename ? { ...image, starred } : image))
}

/** Adds one role to an image if it isn't already present, idempotently — the "Use as style
 * source" quick action reuses this rather than requiring a trip through the full roles editor. */
export function withImageRoleAdded(
  images: GenerationImageV2[],
  filename: string,
  role: Role,
): GenerationImageV2[] {
  return images.map((image) =>
    image.filename === filename && !image.roles.includes(role)
      ? { ...image, roles: [...image.roles, role] }
      : image,
  )
}
