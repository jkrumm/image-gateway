import type { GenerationImageV2, Role } from '@image-gateway/shared'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  Badge,
  Button,
  CopyButton,
  Group,
  Modal,
  Skeleton,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { VX } from 'basalt-ui/tokens'
import { error as logError } from '@tauri-apps/plugin-log'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { useEffect, useState } from 'react'
import type { Recipe } from '../../lib/imaging/recipe'
import { absolutePath, type LibraryEntry } from '../../lib/library'
import type { GenerationMetadata } from '../../lib/metadata'
import { DerivedSection } from './DerivedSection'
import { LineagePanel } from './LineagePanel'
import { PlanRecord } from './PlanRecord'
import { RolesEditor } from './RolesEditor'
import { UseAsTrio, type UseAsAction } from './UseAsTrio'

export type UseAsLoading = { filename: string; action: UseAsAction }

async function handleReveal(path: string): Promise<void> {
  try {
    await revealItemInDir(path)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    void logError(`failed to reveal file in Finder: ${message}`)
    notifications.show({ color: 'red', title: 'Could not reveal file', message })
  }
}

type GenerationInspectorProps = {
  entry: LibraryEntry
  byId: ReadonlyMap<string, GenerationMetadata>
  childGenerations: GenerationMetadata[]
  onClose: () => void
  onOpenGeneration: (id: string) => void

  onTweak: () => void
  onRerun: () => void
  onPromote: () => void
  rerunning: boolean
  promoting: boolean

  onOpenRefine: () => void
  refiningMain: boolean
  refiningDerivativeKey: string | null
  onRefineDerivative: (key: string, recipe: Recipe | undefined) => void

  useAsLoading: UseAsLoading | null
  onUseAsEditReference: (image: GenerationImageV2) => void
  onUseAsStyleSource: (image: GenerationImageV2) => void
  onReusePromptSettings: (image: GenerationImageV2) => void

  savingRolesFor: string | null
  onRolesChange: (image: GenerationImageV2, roles: Role[]) => void
  onStarredChange: (image: GenerationImageV2, starred: boolean) => void
}

/**
 * The Library inspector (docs/concept.md §2): outputs, the Plan record, the lineage panel, a
 * roles/star editor and use-as trio per image, and the generation-level actions — Tweak / Re-run /
 * Promote (each genuinely distinct — Tweak navigates seeded, the other two enqueue) and Refine.
 */
export function GenerationInspector({
  entry,
  byId,
  childGenerations,
  onClose,
  onOpenGeneration,
  onTweak,
  onRerun,
  onPromote,
  rerunning,
  promoting,
  onOpenRefine,
  refiningMain,
  refiningDerivativeKey,
  onRefineDerivative,
  useAsLoading,
  onUseAsEditReference,
  onUseAsStyleSource,
  onReusePromptSettings,
  savingRolesFor,
  onRolesChange,
  onStarredChange,
}: GenerationInspectorProps) {
  const { metadata } = entry
  const [imageSrcs, setImageSrcs] = useState<string[]>([])
  const [imagePaths, setImagePaths] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    void Promise.all(
      metadata.images.map((image) => absolutePath(metadata.id, image.filename)),
    ).then((paths) => {
      if (cancelled) return undefined
      setImagePaths(paths)
      return setImageSrcs(paths.map((path) => convertFileSrc(path)))
    })
    return () => {
      cancelled = true
    }
  }, [metadata.id, metadata.images])

  return (
    <Modal opened onClose={onClose} title="Generation" size={960}>
      <Stack gap="lg">
        <Group justify="space-between" align="flex-start">
          <Text size="sm" style={{ flex: 1 }}>
            {metadata.prompt}
          </Text>
          <CopyButton value={metadata.prompt}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? 'Copied' : 'Copy prompt'}>
                <Button size="xs" variant="subtle" onClick={copy}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </Tooltip>
            )}
          </CopyButton>
        </Group>

        <Group gap="xs" wrap="wrap">
          <Badge variant="light">{metadata.model}</Badge>
          <Badge variant="light">{metadata.params.size}</Badge>
          <Badge variant="light">{metadata.params.quality}</Badge>
          <Badge variant="light">{metadata.params.background}</Badge>
          <Badge variant="light">{metadata.params.output_format}</Badge>
          <Badge variant="outline" {...(metadata.kind === 'edit' ? { color: 'grape' } : {})}>
            {metadata.kind}
          </Badge>
          {metadata.kind === 'edit' && metadata.input_images && (
            <Badge variant="outline">
              {metadata.input_images.length} input{metadata.input_images.length === 1 ? '' : 's'}
            </Badge>
          )}
          {metadata.mask && <Badge variant="outline">masked</Badge>}
          {metadata.routed && (
            <Tooltip label={metadata.routing_reason ?? 'Model routed automatically'}>
              <Badge color="orange" variant="light">
                routed
              </Badge>
            </Tooltip>
          )}
        </Group>

        <Group gap="lg">
          <Text size="sm" c="dimmed">
            Cost: {metadata.cost.usd !== null ? `$${metadata.cost.usd.toFixed(4)}` : 'n/a'}
          </Text>
          <Text size="sm" c="dimmed">
            Tokens: {metadata.usage.total_tokens}
          </Text>
          <Text size="sm" c="dimmed">
            Latency: {metadata.latency_ms}ms
          </Text>
          <Text size="sm" c="dimmed">
            {new Date(metadata.created_at).toLocaleString()}
          </Text>
        </Group>

        <Stack gap="md">
          <Text size="sm" fw={500}>
            Outputs
          </Text>
          {metadata.images.map((image, index) => (
            <Stack key={image.filename} gap={6}>
              {imageSrcs[index] ? (
                <img
                  src={imageSrcs[index]}
                  alt={`${metadata.prompt} ${index + 1}`}
                  style={{ maxWidth: 280, maxHeight: 280, borderRadius: VX.radiusCard }}
                />
              ) : (
                <Skeleton height={200} width={200} />
              )}
              <RolesEditor
                image={image}
                saving={savingRolesFor === image.filename}
                onRolesChange={(roles) => onRolesChange(image, roles)}
                onStarredChange={(starred) => onStarredChange(image, starred)}
              />
              <UseAsTrio
                loadingAction={
                  useAsLoading?.filename === image.filename ? useAsLoading.action : null
                }
                onUseAsEditReference={() => onUseAsEditReference(image)}
                onUseAsStyleSource={() => onUseAsStyleSource(image)}
                onReusePromptSettings={() => onReusePromptSettings(image)}
              />
              <Group gap={4} wrap="wrap">
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={!imagePaths[index]}
                  onClick={() => void handleReveal(imagePaths[index] as string)}
                >
                  Reveal in Finder
                </Button>
                <CopyButton value={imagePaths[index] ?? ''}>
                  {({ copied, copy }) => (
                    <Button size="xs" variant="subtle" disabled={!imagePaths[index]} onClick={copy}>
                      {copied ? 'Copied' : 'Copy path'}
                    </Button>
                  )}
                </CopyButton>
              </Group>
            </Stack>
          ))}
        </Stack>

        <PlanRecord enhance={metadata.enhance} />

        <LineagePanel
          entry={metadata}
          byId={byId}
          childGenerations={childGenerations}
          onOpenGeneration={onOpenGeneration}
        />

        <DerivedSection
          generationId={metadata.id}
          derivatives={metadata.derivatives}
          refiningKey={refiningDerivativeKey}
          onRefineAgain={onRefineDerivative}
        />

        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onOpenRefine} loading={refiningMain}>
            Refine
          </Button>
          <Button variant="default" onClick={onTweak}>
            Tweak
          </Button>
          <Button variant="default" onClick={onRerun} loading={rerunning}>
            Re-run
          </Button>
          <Button onClick={onPromote} loading={promoting}>
            Promote
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
