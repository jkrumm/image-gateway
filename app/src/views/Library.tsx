import type { GenerationImageV2, Project, Role } from '@image-gateway/shared'
import { Group, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { error as logError } from '@tauri-apps/plugin-log'
import { readFile } from '@tauri-apps/plugin-fs'
import { EmptyState } from 'basalt-ui'
import { CONTAINER_KEYS } from 'basalt-ui/tokens'
import { useEffect, useMemo, useState } from 'react'
import type { CreateSeed, RefineSeed } from '../App'
import { FacetChips } from '../components/library/FacetChips'
import { GenerationCard } from '../components/library/GenerationCard'
import { GenerationInspector, type UseAsLoading } from '../components/library/GenerationInspector'
import { LibrarySidebar } from '../components/library/LibrarySidebar'
import type { Recipe } from '../lib/imaging/recipe'
import { buildLibraryIndex } from '../lib/library-index'
import { filterLibraryEntries, type LibraryScope } from '../lib/library-filters'
import {
  absolutePath,
  updateGenerationMetadata,
  type LibraryEntry,
  type SaveEditRequest,
  type SaveGenerationRequest,
} from '../lib/library'
import type { GenerationImageMeta, GenerationMetadata } from '../lib/metadata'
import {
  buildPromoteRequest,
  buildRerunRequest,
  buildTweakRequest,
  describeCoercions,
  type ReplayCoercion,
  snappedReplayRequest,
} from '../lib/replay'
import { withImageRoleAdded, withImageRoles, withImageStarred } from '../lib/roles'
import { useQueue } from '../lib/queue'
import { studioStore } from '../lib/studio-store'

/** Maps a saved image's on-disk format back to a MIME type for constructing a `File`. */
function mimeTypeForFormat(format: GenerationImageMeta['format']): string {
  if (format === 'png') return 'image/png'
  if (format === 'webp') return 'image/webp'
  return 'image/jpeg'
}

async function loadFile(
  generationId: string,
  image: { filename: string; format: 'png' | 'webp' | 'jpeg' },
): Promise<File> {
  const path = await absolutePath(generationId, image.filename)
  const bytes = await readFile(path)
  return new File([bytes], image.filename, { type: mimeTypeForFormat(image.format) })
}

/** Loads an edit's saved input images (and mask, if any) back into `File`s, for a verbatim
 * Re-run/Promote of an edit-kind generation. `null` when the sidecar has no input images to load
 * (should not happen for a real edit, but the field is optional in the schema). */
async function loadEditFiles(
  metadata: GenerationMetadata,
): Promise<{ images: File[]; mask?: File } | null> {
  if (!metadata.input_images || metadata.input_images.length === 0) return null
  const images = await Promise.all(
    metadata.input_images.map((image) => loadFile(metadata.id, image)),
  )
  const mask = metadata.mask ? await loadFile(metadata.id, metadata.mask) : undefined
  return { images, ...(mask ? { mask } : {}) }
}

type LibraryProps = {
  entries: LibraryEntry[]
  totalCost: number
  onSeedCreate: (seed: CreateSeed) => void
  onSeedRefine: (seed: RefineSeed) => void
  onLibraryChange: () => void
}

/** `{ id, op }` of the direct-enqueue job currently in flight, so only that generation's Re-run/
 * Promote button shows a spinner. */
type BusyOp = { id: string; op: 'rerun' | 'promote' }

function toggleInSet(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

/** Replaying a generation recorded against a retired model can require changing settings the
 * sidecar recorded (transparency, input_fidelity, an unreplayable size). Say so — the studio
 * never rewrites a recorded setting silently (concept §2's central taboo). */
function notifyCoercions(op: string, coercions: ReplayCoercion[]): void {
  if (coercions.length === 0) return
  notifications.show({
    color: 'yellow',
    title: `${op}: settings changed`,
    message: describeCoercions(coercions),
  })
}

export function Library({
  entries,
  totalCost,
  onSeedCreate,
  onSeedRefine,
  onLibraryChange,
}: LibraryProps) {
  const queue = useQueue()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [scope, setScope] = useState<LibraryScope>({ type: 'all' })
  const [query, setQuery] = useState('')
  const [modelFilters, setModelFilters] = useState<Set<string>>(new Set())
  const [kindFilters, setKindFilters] = useState<Set<string>>(new Set())
  const [roleFilters, setRoleFilters] = useState<Set<string>>(new Set())
  const [projects, setProjects] = useState<Project[]>([])
  const [busyOp, setBusyOp] = useState<BusyOp | null>(null)
  const [refiningKey, setRefiningKey] = useState<string | null>(null)
  const [useAsLoading, setUseAsLoading] = useState<UseAsLoading | null>(null)
  const [savingRolesFor, setSavingRolesFor] = useState<string | null>(null)

  useEffect(() => {
    void studioStore.listProjects().then(setProjects)
  }, [])

  const index = useMemo(() => buildLibraryIndex(entries.map((entry) => entry.metadata)), [entries])
  const entriesById = useMemo(
    () => new Map(entries.map((entry) => [entry.metadata.id, entry])),
    [entries],
  )
  const byId = useMemo(() => new Map(index.entries.map((entry) => [entry.id, entry])), [index])

  const filtered = useMemo(
    () =>
      filterLibraryEntries(index, {
        scope,
        query,
        models: modelFilters,
        kinds: kindFilters,
        roles: roleFilters,
      }),
    [index, scope, query, modelFilters, kindFilters, roleFilters],
  )
  const filteredEntries = filtered
    .map((metadata) => entriesById.get(metadata.id))
    .filter((entry): entry is LibraryEntry => entry !== undefined)

  const selected = selectedId ? entriesById.get(selectedId) : undefined
  const selectedChildren = selectedId ? index.childrenOf(selectedId) : []

  function handleTweak(metadata: GenerationMetadata, imageFilename?: string): void {
    const tweak = buildTweakRequest(metadata)
    notifyCoercions('Tweak', tweak.coercions)
    const seed: CreateSeed = {
      op: 'tweak',
      request: tweak.request,
      parent: { id: metadata.id, op: 'tweak', ...(imageFilename ? { image: imageFilename } : {}) },
    }
    onSeedCreate(seed)
    setSelectedId(null)
  }

  async function directEnqueue(
    metadata: GenerationMetadata,
    op: 'rerun' | 'promote',
    build: (m: GenerationMetadata) => ReturnType<typeof buildRerunRequest>,
  ): Promise<void> {
    setBusyOp({ id: metadata.id, op })
    try {
      const { request, coercions } = build(metadata)
      notifyCoercions(op === 'rerun' ? 'Re-run' : 'Promote', coercions)
      if (metadata.kind === 'edit') {
        const files = await loadEditFiles(metadata)
        if (!files || files.images.length === 0) {
          notifications.show({
            color: 'red',
            title: `Could not ${op}`,
            message: 'Original reference images are missing from disk.',
          })
          return
        }
        queue.enqueueEdit(request as SaveEditRequest, files.images, files.mask)
        return
      }
      queue.enqueueGenerate(request as SaveGenerationRequest)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void logError(`${op} failed: ${message}`)
      notifications.show({ color: 'red', title: `Could not ${op}`, message })
    } finally {
      setBusyOp(null)
    }
  }

  async function handleUseAsEditReference(
    metadata: GenerationMetadata,
    image: GenerationImageV2,
  ): Promise<void> {
    setUseAsLoading({ filename: image.filename, action: 'edit-reference' })
    try {
      const file = await loadFile(metadata.id, image)
      // "Use as edit reference" is a replay path too — the settings it carries into Create must be
      // valid for today's generatable model, and any coercion must be visible.
      const { request, coercions } = snappedReplayRequest(metadata)
      notifyCoercions('Use as edit reference', coercions)
      const seed: CreateSeed = {
        op: 'edit',
        request,
        references: [file],
        parent: { id: metadata.id, image: image.filename, op: 'edit' },
      }
      onSeedCreate(seed)
      setSelectedId(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void logError(`failed to load image for editing: ${message}`)
      notifications.show({ color: 'red', title: 'Could not load image', message })
    } finally {
      setUseAsLoading(null)
    }
  }

  async function handleUseAsStyleSource(
    metadata: GenerationMetadata,
    image: GenerationImageV2,
  ): Promise<void> {
    setUseAsLoading({ filename: image.filename, action: 'style-source' })
    try {
      await updateGenerationMetadata(metadata.id, {
        images: withImageRoleAdded(metadata.images, image.filename, 'style-source'),
      })
      onLibraryChange()
      notifications.show({
        color: 'green',
        title: 'Marked as style source',
        message: image.filename,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void logError(`failed to mark style source: ${message}`)
      notifications.show({ color: 'red', title: 'Could not update roles', message })
    } finally {
      setUseAsLoading(null)
    }
  }

  async function handleRolesChange(
    metadata: GenerationMetadata,
    image: GenerationImageV2,
    roles: Role[],
  ): Promise<void> {
    setSavingRolesFor(image.filename)
    try {
      await updateGenerationMetadata(metadata.id, {
        images: withImageRoles(metadata.images, image.filename, roles),
      })
      onLibraryChange()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void logError(`failed to update roles: ${message}`)
      notifications.show({ color: 'red', title: 'Could not update roles', message })
    } finally {
      setSavingRolesFor(null)
    }
  }

  async function handleStarredChange(
    metadata: GenerationMetadata,
    image: GenerationImageV2,
    starred: boolean,
  ): Promise<void> {
    setSavingRolesFor(image.filename)
    try {
      await updateGenerationMetadata(metadata.id, {
        images: withImageStarred(metadata.images, image.filename, starred),
      })
      onLibraryChange()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void logError(`failed to update star: ${message}`)
      notifications.show({ color: 'red', title: 'Could not update star', message })
    } finally {
      setSavingRolesFor(null)
    }
  }

  async function openInRefine(
    metadata: GenerationMetadata,
    key: string,
    recipe?: Recipe,
  ): Promise<void> {
    const firstImage = metadata.images[0]
    if (!firstImage) return

    setRefiningKey(key)
    try {
      const file = await loadFile(metadata.id, firstImage)
      onSeedRefine({
        generationId: metadata.id,
        image: file,
        ...(recipe !== undefined ? { recipe } : {}),
      })
      setSelectedId(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void logError(`failed to load image for refine: ${message}`)
      notifications.show({ color: 'red', title: 'Could not load image', message })
    } finally {
      setRefiningKey(null)
    }
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No generations yet"
        description="Generations you create in Create are saved here automatically."
      />
    )
  }

  return (
    <Group align="flex-start" gap="lg" p="lg" wrap="nowrap">
      <LibrarySidebar
        scope={scope}
        onScopeChange={setScope}
        projects={projects}
        allCount={index.entries.length}
        starredCount={index.starred.length}
      />

      <Stack gap="lg" style={{ flex: 1, minWidth: 0 }}>
        <Group justify="space-between">
          <Title order={5}>Library</Title>
          <Text size="sm" c="dimmed">
            {entries.length} generations · ${totalCost.toFixed(2)}
          </Text>
        </Group>

        <TextInput
          placeholder="Search prompts and briefs…"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />

        <FacetChips
          modelFacets={index.facets.model}
          kindFacets={index.facets.kind}
          roleFacets={index.facets.role}
          activeModels={modelFilters}
          activeKinds={kindFilters}
          activeRoles={roleFilters}
          onToggleModel={(value) => setModelFilters((prev) => toggleInSet(prev, value))}
          onToggleKind={(value) => setKindFilters((prev) => toggleInSet(prev, value))}
          onToggleRole={(value) => setRoleFilters((prev) => toggleInSet(prev, value))}
        />

        {filteredEntries.length === 0 ? (
          <EmptyState
            title="No matching generations"
            description="Try a different search term, or clear the active filters."
          />
        ) : (
          <SimpleGrid
            type="container"
            cols={{
              base: 2,
              [CONTAINER_KEYS.regular]: 3,
              [CONTAINER_KEYS.wide]: 4,
            }}
            spacing="md"
          >
            {filteredEntries.map((entry) => (
              <GenerationCard
                key={entry.metadata.id}
                entry={entry}
                onOpen={() => setSelectedId(entry.metadata.id)}
              />
            ))}
          </SimpleGrid>
        )}
      </Stack>

      {selected && (
        <GenerationInspector
          entry={selected}
          byId={byId}
          childGenerations={selectedChildren}
          onClose={() => setSelectedId(null)}
          onOpenGeneration={(id) => setSelectedId(id)}
          onTweak={() => handleTweak(selected.metadata)}
          onRerun={() => void directEnqueue(selected.metadata, 'rerun', buildRerunRequest)}
          onPromote={() => void directEnqueue(selected.metadata, 'promote', buildPromoteRequest)}
          rerunning={busyOp?.id === selected.metadata.id && busyOp.op === 'rerun'}
          promoting={busyOp?.id === selected.metadata.id && busyOp.op === 'promote'}
          onOpenRefine={() => void openInRefine(selected.metadata, 'main')}
          refiningMain={refiningKey === 'main'}
          refiningDerivativeKey={refiningKey !== 'main' ? refiningKey : null}
          onRefineDerivative={(key, recipe) => void openInRefine(selected.metadata, key, recipe)}
          useAsLoading={useAsLoading}
          onUseAsEditReference={(image) => void handleUseAsEditReference(selected.metadata, image)}
          onUseAsStyleSource={(image) => void handleUseAsStyleSource(selected.metadata, image)}
          onReusePromptSettings={(image) => handleTweak(selected.metadata, image.filename)}
          savingRolesFor={savingRolesFor}
          onRolesChange={(image, roles) => void handleRolesChange(selected.metadata, image, roles)}
          onStarredChange={(image, starred) =>
            void handleStarredChange(selected.metadata, image, starred)
          }
        />
      )}
    </Group>
  )
}
