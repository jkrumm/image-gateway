import { EDIT_LIMITS, INPUT_IMAGE_MIME_TYPES } from '@image-gateway/shared'
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  FileButton,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { CONTAINER_KEYS, VX } from 'basalt-ui/tokens'
import { useMemo, useRef, useState, type DragEvent } from 'react'
import type { LibraryEntry } from '../../lib/library'
import { LibraryPickerModal } from './LibraryPickerModal'

export type ReferenceItem = { id: string; file: File }
export type ReferenceItemWithUrl = ReferenceItem & { url: string }

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * Mints and reuses per-file object URLs across renders, revoking each one only when its item is
 * actually removed. Deliberately not tied to the mount lifecycle: `<Activity mode="hidden">` runs
 * effect cleanups while preserving state, so revoking on teardown would blank every thumbnail on a
 * tab round-trip while the memo below — unchanged `items` — hands back the same dead URLs. Ported
 * from the pre-merge Edit.tsx.
 */
export function useReferenceUrls(items: ReferenceItem[]): ReferenceItemWithUrl[] {
  const urlsRef = useRef(new Map<string, string>())

  const withUrls = useMemo(() => {
    const next = new Map<string, string>()
    const mapped = items.map((item) => {
      const existing = urlsRef.current.get(item.id)
      const url = existing ?? URL.createObjectURL(item.file)
      next.set(item.id, url)
      return { ...item, url }
    })
    for (const [id, url] of urlsRef.current) {
      if (!next.has(id)) URL.revokeObjectURL(url)
    }
    urlsRef.current = next
    return mapped
    // eslint-disable-next-line react-hooks/exhaustive-deps -- urlsRef is a stable ref, intentionally excluded
  }, [items])

  return withUrls
}

export type ReferencesRailProps = {
  items: ReferenceItem[]
  onItemsChange: (items: ReferenceItem[]) => void
  libraryEntries: LibraryEntry[]
}

/**
 * References rail (concept §2): drag-drop + file dialog + in-app library picker. The first
 * (primary) reference is what the mask tool paints over and what Create's auto-size derivation
 * reads dimensions from. Endpoint routing (generate vs. edit) is derived elsewhere from whether
 * this list is non-empty — this component only owns the list itself.
 */
export function ReferencesRail({ items, onItemsChange, libraryEntries }: ReferencesRailProps) {
  const itemsWithUrls = useReferenceUrls(items)
  const [pickerOpen, setPickerOpen] = useState(false)

  function addFiles(files: ReferenceItem[]): void {
    if (files.length === 0) return
    onItemsChange([...items, ...files])
  }

  function handleFilesPicked(candidates: File[]): void {
    if (candidates.length === 0) return
    const errors: string[] = []
    const accepted: ReferenceItem[] = []
    let remainingSlots = EDIT_LIMITS.maxImages - items.length

    for (const file of candidates) {
      if (remainingSlots <= 0) {
        errors.push(
          `Only ${EDIT_LIMITS.maxImages} reference images are allowed — "${file.name}" was skipped.`,
        )
        continue
      }
      if (!(INPUT_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
        errors.push(`"${file.name}" is not a supported type (png, jpeg, webp).`)
        continue
      }
      if (file.size > EDIT_LIMITS.maxImageBytes) {
        errors.push(`"${file.name}" exceeds the ${formatBytes(EDIT_LIMITS.maxImageBytes)} limit.`)
        continue
      }
      accepted.push({ id: crypto.randomUUID(), file })
      remainingSlots -= 1
    }

    addFiles(accepted)
    for (const message of errors) {
      notifications.show({ color: 'red', title: 'Image rejected', message })
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    handleFilesPicked(Array.from(event.dataTransfer.files))
  }

  function removeItem(id: string): void {
    onItemsChange(items.filter((item) => item.id !== id))
  }

  function swapItems(a: number, b: number): void {
    if (b < 0 || b >= items.length) return
    const itemA = items[a]
    const itemB = items[b]
    if (!itemA || !itemB) return
    const next = [...items]
    next[a] = itemB
    next[b] = itemA
    onItemsChange(next)
  }

  return (
    <Card py="xs" px="sm">
      <Stack gap="md">
        <Group justify="space-between">
          <Title order={5}>References</Title>
          <Text size="xs" c="dimmed">
            {items.length} / {EDIT_LIMITS.maxImages} · none attached routes to a plain generation;
            any attached routes to edit. Order matters — referenced in the prompt as "image 1",
            "image 2", …
          </Text>
        </Group>

        <Box
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
          p="xl"
          style={{
            border: `1px dashed ${VX.surface.border}`,
            borderRadius: VX.radiusCard,
          }}
        >
          <Stack gap="xs" align="center">
            <Text size="sm" c="dimmed">
              Drag & drop images here
            </Text>
            <Group gap="xs">
              <FileButton
                onChange={handleFilesPicked}
                accept={INPUT_IMAGE_MIME_TYPES.join(',')}
                multiple
              >
                {(props) => (
                  <Button {...props} variant="default" size="xs">
                    Choose files
                  </Button>
                )}
              </FileButton>
              <Button variant="default" size="xs" onClick={() => setPickerOpen(true)}>
                Add from library
              </Button>
            </Group>
          </Stack>
        </Box>

        {itemsWithUrls.length > 0 && (
          <SimpleGrid
            type="container"
            cols={{
              base: 3,
              [CONTAINER_KEYS.regular]: 4,
              [CONTAINER_KEYS.wide]: 6,
            }}
            spacing="sm"
          >
            {itemsWithUrls.map((item, index) => (
              // theme-allow card-inset — square thumbnail needs a tight uniform padding, not the content-card xs/sm inset
              <Card key={item.id} padding={4} pos="relative">
                <Badge
                  size="xs"
                  variant="filled"
                  style={{ position: 'absolute', top: 4, left: 4, zIndex: 1 }}
                >
                  {index === 0 ? 'primary' : index + 1}
                </Badge>
                <img
                  src={item.url}
                  alt={`Reference ${index + 1}`}
                  style={{
                    width: '100%',
                    height: 96,
                    objectFit: 'cover',
                    borderRadius: VX.radiusCtrl,
                    display: 'block',
                  }}
                />
                <Group gap={4} justify="center" mt={4}>
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    disabled={index === 0}
                    onClick={() => swapItems(index, index - 1)}
                    aria-label="Move earlier"
                  >
                    ↑
                  </ActionIcon>
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    disabled={index === itemsWithUrls.length - 1}
                    onClick={() => swapItems(index, index + 1)}
                    aria-label="Move later"
                  >
                    ↓
                  </ActionIcon>
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="red"
                    onClick={() => removeItem(item.id)}
                    aria-label="Remove"
                  >
                    ✕
                  </ActionIcon>
                </Group>
              </Card>
            ))}
          </SimpleGrid>
        )}
      </Stack>

      <LibraryPickerModal
        opened={pickerOpen}
        onClose={() => setPickerOpen(false)}
        entries={libraryEntries}
        onPick={(file) => addFiles([{ id: crypto.randomUUID(), file }])}
      />
    </Card>
  )
}
