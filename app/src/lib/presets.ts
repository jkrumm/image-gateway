import type { GenerateRequest } from '@image-gateway/shared'

export type Preset = {
  id: string
  label: string
  description: string
  /** Applied on top of the current form state — never touches the prompt. */
  request: {
    size: string
    quality: GenerateRequest['quality']
    background: GenerateRequest['background']
  }
}

/**
 * Presets carry no `model`: leaving it `auto` lets the gateway route between flare (drafts) and
 * sunburst (edits, `high`+ finals) — see `resolveModel` in `shared/src/rules.ts`. Every preset
 * still sets `background` explicitly so applying one is valid regardless of the previous
 * selection.
 */
export const PRESETS: Preset[] = [
  {
    id: 'journal-cover',
    label: 'Journal cover',
    description: 'Widescreen custom size for a journal or blog header.',
    request: { size: '2560x1440', quality: 'high', background: 'auto' },
  },
  {
    id: 'app-icon',
    label: 'App icon',
    description: 'Square canvas for an icon — transparent background, real alpha channel.',
    request: { size: '1024x1024', quality: 'high', background: 'transparent' },
  },
  {
    id: 'art',
    label: 'Art',
    description: 'Portrait canvas for standalone artwork.',
    request: { size: '1024x1536', quality: 'high', background: 'auto' },
  },
]
