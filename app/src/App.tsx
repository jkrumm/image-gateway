import type { GenerateRequestInput, GenerationParent } from '@image-gateway/shared'
import { ActionIcon, Group, ScrollArea, SegmentedControl, Stack, Text, Title } from '@mantine/core'
import { EmptyState } from 'basalt-ui'
import { money } from 'basalt-ui/format'
import { Activity, useCallback, useEffect, useState } from 'react'
import { QueueBar } from './components/QueueBar'
import { SettingsIcon } from './components/SettingsIcon'
import { SettingsModal } from './components/SettingsModal'
import type { Recipe } from './lib/imaging/recipe'
import { listGenerations, type LibraryEntry } from './lib/library'
import { QueueProvider } from './lib/queue'
import { loadStoredSettings, useSettings } from './lib/settings'
import { Create } from './views/Create'
import { Library } from './views/Library'
import { Refine } from './views/Refine'

/**
 * Seeds the Create surface from the Library (docs/concept.md §2). Replaces the
 * former `ComposerSeed`/`EditorSeed` split with one shape carrying an explicit `op` so Create knows
 * *why* it was seeded rather than inferring it from which fields happen to be present:
 *
 * - `'tweak'` — reopen the Plan for editing (delta mode), from the Library's Tweak action or an
 *   image's "Reuse prompt + settings" use-as action.
 * - `'edit'` — "Use as edit reference": seeds the references rail with `references` *and* the
 *   originating prompt/settings (previously lost — only `{ image, parentId }` traveled).
 * - `'series'` — reserved for project-anchor seeding (concept §3); no UI path emits it yet.
 *
 * `references` is only meaningful for `'edit'`. `parent` carries the full lineage edge this seed
 * should record on the resulting generation (`{ id, image?, op }`) — distinct from the request's
 * own settings, since e.g. a Tweak's `parent.op` is always `'tweak'` even though the user may go
 * on to submit as a plain generation or as an edit.
 */
export type CreateSeed = {
  op: 'tweak' | 'edit' | 'series'
  request: GenerateRequestInput
  references?: File[]
  parent?: GenerationParent
}

/** Seeds the Refine view with a past generation's first output image plus the generation id
 * exports get written back under (`<id>/derived/...`). An optional `recipe` reopens the workbench
 * with a previously exported derivative's saved recipe instead of the workbench's own defaults
 * (e.g. "Refine again" from the Library). */
export type RefineSeed = {
  generationId: string
  image: File
  recipe?: Recipe
}

type View = 'create' | 'library' | 'styles' | 'refine'

export function App() {
  const [view, setView] = useState<View>('create')
  const [createSeed, setCreateSeed] = useState<CreateSeed | null>(null)
  const [refineSeed, setRefineSeed] = useState<RefineSeed | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useSettings()
  const [entries, setEntries] = useState<LibraryEntry[]>([])

  // Hydrate from `.imagegen/settings.json` on boot. localStorage is partitioned per executable
  // (dev vs bundled — see settings.ts), and the file may have been seeded by `make configure`
  // without the app ever running, so the file wins whenever it holds a usable pair.
  useEffect(() => {
    async function hydrate(): Promise<void> {
      const stored = await loadStoredSettings()
      if (stored !== undefined) setSettings(stored)
    }
    void hydrate()
  }, [setSettings])

  const refreshLibrary = useCallback(async () => {
    const next = await listGenerations()
    setEntries(next)
  }, [])

  useEffect(() => {
    void refreshLibrary()
  }, [refreshLibrary])

  const totalCost = entries.reduce((sum, entry) => sum + (entry.metadata.cost.usd ?? 0), 0)

  function seedCreate(seed: CreateSeed): void {
    setCreateSeed(seed)
    setView('create')
  }

  function seedRefine(seed: RefineSeed): void {
    setRefineSeed(seed)
    setView('refine')
  }

  return (
    <QueueProvider settings={settings} onSaved={() => void refreshLibrary()}>
      <Stack gap={0} style={{ height: '100vh' }}>
        <Group
          justify="space-between"
          px="md"
          py="sm"
          style={{ borderBottom: '1px solid var(--vx-surface-border)', flexShrink: 0 }}
        >
          <Title order={4}>ImageGen</Title>
          <Group gap="lg">
            {/* 1.30.0 makes a shell-less `PageBar` a reachable home, and it was measured against
                this header: it does not fit. `PageBar.tabs` renders in ROW 2, under the title row,
                so this one ~50px bar becomes two (~44 + 36) in a 100vh desktop window whose scarce
                axis is vertical; `tabs` only accepts `ViewTabs`, whose `field` would mean a
                `createLocalStore` for a four-value local switch (a raw control there is
                `basalt/hand-rolled-filter`, an ERROR, not this warning); and the cost readout has
                no slot at all, only the `kind: 'custom'` escape hatch. The deeper mismatch: these
                are the app's TOP-LEVEL destinations, and `PageBar.tabs` models a page's sub-views —
                basalt puts top-level nav in `BasaltShell`'s sidebar, which this window cannot take.
                Since 1.30.0 one rule id waives both the AST and the text lane. */}
            {/* theme-allow control-outside-home — top-level nav; PageBar row 2 is not its home */}
            <SegmentedControl
              value={view}
              onChange={(value) => setView(value as View)}
              data={[
                { label: 'Create', value: 'create' },
                { label: 'Library', value: 'library' },
                { label: 'Styles', value: 'styles' },
              ]}
            />
            <Text size="sm" c="dimmed">
              {entries.length} generations · {money(totalCost, { currency: 'USD' })}
            </Text>
            <ActionIcon
              variant="subtle"
              onClick={() => setSettingsOpen(true)}
              aria-label="Settings"
            >
              <SettingsIcon />
            </ActionIcon>
          </Group>
        </Group>

        <QueueBar />

        {/* Each view stays mounted via `Activity` so tab switches preserve form state (typed
            prompt, selected model/size, …) instead of resetting it on unmount. `mode="hidden"`
            renders the subtree with `display: none`, so the hidden `ScrollArea`s take no layout
            space and each view keeps its own independent scroll position. */}
        <Activity mode={view === 'create' ? 'visible' : 'hidden'}>
          <ScrollArea style={{ flex: 1 }} scrollbars="y">
            <Create
              settings={settings}
              createSeed={createSeed}
              entries={entries}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          </ScrollArea>
        </Activity>
        <Activity mode={view === 'library' ? 'visible' : 'hidden'}>
          <ScrollArea style={{ flex: 1 }} scrollbars="y">
            <Library
              entries={entries}
              totalCost={totalCost}
              onSeedCreate={seedCreate}
              onSeedRefine={seedRefine}
              onLibraryChange={() => void refreshLibrary()}
            />
          </ScrollArea>
        </Activity>
        <Activity mode={view === 'styles' ? 'visible' : 'hidden'}>
          <ScrollArea style={{ flex: 1 }} scrollbars="y">
            <EmptyState
              title="Styles"
              description="Style guides (palette, vocabulary, reference images, proof renders) ship in a later wave. Distill one from a Library selection, a design.md, or a screenshot once it lands."
            />
          </ScrollArea>
        </Activity>
        <Activity mode={view === 'refine' ? 'visible' : 'hidden'}>
          <ScrollArea style={{ flex: 1 }} scrollbars="y">
            <Refine seed={refineSeed} />
          </ScrollArea>
        </Activity>

        <SettingsModal opened={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </Stack>
    </QueueProvider>
  )
}
