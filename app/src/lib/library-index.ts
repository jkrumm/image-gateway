/**
 * In-memory search/facet/lineage index over an already-loaded library (docs/concept.md §6:
 * "startup scan of sidecars into an in-memory index... at personal scale this is milliseconds";
 * SQLite+FTS5 is the named escape hatch, not built here). Pure and synchronous over a plain
 * `GenerationMetadata[]` — the caller owns the Tauri fs read (`library.ts#listGenerations()`) and
 * hands the result in; this module intentionally never imports `@tauri-apps/*`, so it is
 * unit-testable without the Tauri runtime.
 *
 * Not wired into `App.tsx` — that is the Create/Library surfaces' job (G4/G5). This module only
 * exports a ready-to-consume `buildLibraryIndex()`.
 */
import type { GenerationKind, Role } from '@image-gateway/shared'
import type { GenerationMetadata } from './metadata'

/** One distinct facet value and how many entries carry it, sorted by count desc then value asc —
 * the shape a filter-chip list renders directly. */
export type FacetBucket = { value: string; count: number }

export type LibraryIndex = {
  /** Every entry the index was built from, in the order given. */
  entries: GenerationMetadata[]
  /** Case-insensitive substring search over `prompt` + `enhance.brief`. An empty/whitespace query
   * returns every entry (no filtering), matching "All" as the default library scope. */
  search: (query: string) => GenerationMetadata[]
  /** Distinct values (with counts) for the model/kind/role/project facets, for building filter
   * chips. `starred` is a one-bit flag, not a multi-value facet — see the `starred` list below. */
  facets: {
    model: FacetBucket[]
    kind: FacetBucket[]
    role: FacetBucket[]
    project: FacetBucket[]
  }
  /** Entries with at least one starred image. */
  starred: GenerationMetadata[]
  byModel: (model: string) => GenerationMetadata[]
  byKind: (kind: GenerationKind) => GenerationMetadata[]
  byRole: (role: Role) => GenerationMetadata[]
  byProject: (projectId: string) => GenerationMetadata[]
  /** Reverse-lineage: direct children of a generation id, i.e. every entry whose `parent.id`
   * equals `id` (docs/concept.md §2: "Lineage panel... children grouped by operation"). */
  childrenOf: (id: string) => GenerationMetadata[]
}

function groupBy<T extends string>(
  entries: GenerationMetadata[],
  keysOf: (entry: GenerationMetadata) => T[],
): Map<T, GenerationMetadata[]> {
  const map = new Map<T, GenerationMetadata[]>()
  for (const entry of entries) {
    for (const key of keysOf(entry)) {
      const bucket = map.get(key)
      if (bucket) bucket.push(entry)
      else map.set(key, [entry])
    }
  }
  return map
}

function bucketsOf<T extends string>(map: Map<T, GenerationMetadata[]>): FacetBucket[] {
  return [...map.entries()]
    .map(([value, matches]) => ({ value, count: matches.length }))
    .toSorted((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

export function buildLibraryIndex(entries: GenerationMetadata[]): LibraryIndex {
  const byModelMap = groupBy<string>(entries, (entry) => [entry.model])
  const byKindMap = groupBy(entries, (entry) => [entry.kind])
  const byRoleMap = groupBy(entries, (entry) => [
    ...new Set(entry.images.flatMap((image) => image.roles)),
  ])
  const byProjectMap = groupBy(entries, (entry) => entry.project_ids)

  const childrenMap = new Map<string, GenerationMetadata[]>()
  for (const entry of entries) {
    const parentId = entry.parent?.id
    if (parentId === undefined) continue
    const bucket = childrenMap.get(parentId)
    if (bucket) bucket.push(entry)
    else childrenMap.set(parentId, [entry])
  }

  const starred = entries.filter((entry) => entry.images.some((image) => image.starred))

  return {
    entries,
    search: (query) => {
      const needle = query.trim().toLowerCase()
      if (needle === '') return entries
      return entries.filter(
        (entry) =>
          entry.prompt.toLowerCase().includes(needle) ||
          (entry.enhance?.brief.toLowerCase().includes(needle) ?? false),
      )
    },
    facets: {
      model: bucketsOf(byModelMap),
      kind: bucketsOf(byKindMap),
      role: bucketsOf(byRoleMap),
      project: bucketsOf(byProjectMap),
    },
    starred,
    byModel: (model) => byModelMap.get(model) ?? [],
    byKind: (kind) => byKindMap.get(kind) ?? [],
    byRole: (role) => byRoleMap.get(role) ?? [],
    byProject: (projectId) => byProjectMap.get(projectId) ?? [],
    childrenOf: (id) => childrenMap.get(id) ?? [],
  }
}
