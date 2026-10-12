import { convertFileSrc } from '@tauri-apps/api/core'
import {
  Badge,
  Button,
  Card,
  Group,
  Modal,
  SegmentedControl,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { error as logError } from '@tauri-apps/plugin-log'
import { readFile } from '@tauri-apps/plugin-fs'
import { EmptyState } from 'basalt-ui'
import { CONTAINER_KEYS } from 'basalt-ui/tokens'
import { useEffect, useState } from 'react'
import type { Role } from '@image-gateway/shared'
import { absolutePath, type LibraryEntry } from '../../lib/library'

/** Maps a saved image's on-disk format back to a MIME type for constructing a `File`. */
function mimeTypeForFormat(format: 'png' | 'webp' | 'jpeg'): string {
  if (format === 'png') return 'image/png'
  if (format === 'webp') return 'image/webp'
  return 'image/jpeg'
}

/** Roles that make an image a sensible reference/style source (concept §2 story 7: the in-app
 * library picker defaults to these, with a toggle to show everything). */
const REFERENCE_ROLES: Role[] = ['style-source', 'logo', 'reference']

type FilterMode = 'reference' | 'all'

function useLibraryThumbnail(entry: LibraryEntry): string | null {
  const [src, setSrc] = useState<string | null>(null)
  const firstImage = entry.metadata.images[0]

  useEffect(() => {
    setSrc(null)
    if (!firstImage) return
    let cancelled = false
    void absolutePath(entry.metadata.id, firstImage.filename).then((path) => {
      return cancelled ? undefined : setSrc(convertFileSrc(path))
    })
    return () => {
      cancelled = true
    }
  }, [entry.metadata.id, firstImage])

  return src
}

type PickerTileProps = {
  entry: LibraryEntry
  onPick: () => void
}

function PickerTile({ entry, onPick }: PickerTileProps) {
  const thumbnailSrc = useLibraryThumbnail(entry)
  const roles = [...new Set(entry.metadata.images.flatMap((image) => image.roles))]

  return (
    <Card padding="sm" onClick={onPick} style={{ cursor: 'pointer' }}>
      <Card.Section>
        {thumbnailSrc ? (
          <img
            src={thumbnailSrc}
            alt={entry.metadata.prompt}
            style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <Skeleton height={120} />
        )}
      </Card.Section>
      <Stack gap={4} mt="xs">
        <Text size="xs" lineClamp={2}>
          {entry.metadata.prompt}
        </Text>
        {roles.length > 0 && (
          <Group gap={4}>
            {roles.map((role) => (
              <Badge key={role} size="xs" variant="light">
                {role}
              </Badge>
            ))}
          </Group>
        )}
      </Stack>
    </Card>
  )
}

export type LibraryPickerModalProps = {
  opened: boolean
  onClose: () => void
  entries: LibraryEntry[]
  onPick: (file: File) => void
}

/**
 * In-app library picker for the References rail (concept §2 story 7: "Add reference opens the
 * in-app library picker filtered to role: style-source|logo|reference (toggle: all)"). Loads the
 * picked generation's first output image from disk and hands it back as a `File`, the same shape
 * `ReferencesRail` already accepts from drag-drop/file-dialog.
 */
export function LibraryPickerModal({ opened, onClose, entries, onPick }: LibraryPickerModalProps) {
  const [filter, setFilter] = useState<FilterMode>('reference')
  const [loadingId, setLoadingId] = useState<string | null>(null)

  const visible =
    filter === 'all'
      ? entries
      : entries.filter((entry) =>
          entry.metadata.images.some((image) =>
            image.roles.some((role) => REFERENCE_ROLES.includes(role)),
          ),
        )

  async function pick(entry: LibraryEntry): Promise<void> {
    const firstImage = entry.metadata.images[0]
    if (!firstImage) return

    setLoadingId(entry.metadata.id)
    try {
      const path = await absolutePath(entry.metadata.id, firstImage.filename)
      const bytes = await readFile(path)
      const file = new File([bytes], firstImage.filename, {
        type: mimeTypeForFormat(firstImage.format),
      })
      onPick(file)
      onClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void logError(`failed to load library image as reference: ${message}`)
      notifications.show({ color: 'red', title: 'Could not load image', message })
    } finally {
      setLoadingId(null)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Add reference from library" size="lg">
      <Stack gap="md">
        <Group justify="space-between">
          <SegmentedControl
            value={filter}
            onChange={(value) => setFilter(value as FilterMode)}
            data={[
              { label: 'Reference roles', value: 'reference' },
              { label: 'All', value: 'all' },
            ]}
          />
          <Text size="xs" c="dimmed">
            {visible.length} image{visible.length === 1 ? '' : 's'}
          </Text>
        </Group>

        {visible.length === 0 ? (
          <EmptyState
            title="No matching images"
            description="Star or role-tag library images as style-source, logo, or reference to find them here faster, or switch to All."
          />
        ) : (
          <SimpleGrid type="container" cols={{ base: 2, [CONTAINER_KEYS.regular]: 3 }} spacing="sm">
            {visible.map((entry) => (
              <PickerTile key={entry.metadata.id} entry={entry} onPick={() => void pick(entry)} />
            ))}
          </SimpleGrid>
        )}

        {loadingId && (
          <Group justify="flex-end">
            <Button size="xs" variant="subtle" loading disabled>
              Loading…
            </Button>
          </Group>
        )}
      </Stack>
    </Modal>
  )
}
