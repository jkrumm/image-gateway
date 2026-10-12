import {
  DEFAULT_MODEL,
  EDIT_LIMITS,
  estimateCost,
  IMAGE_MODELS,
  MODEL_CAPABILITIES,
  resolveModel,
  SIZE_PRESETS,
  snapSizeForModel,
  validateSizeForModel,
  validateTransparentOutputFormat,
  type GenerateRequest,
  type GenerationParent,
  type ImageModel,
  type Intent,
  type PlanOverrides,
  type PlanRequestInput,
  type PlanResponse,
  type PlanWarning,
  type Project,
  type SeriesContextEntry,
  type SidecarEnhance,
  type StyleGuide,
} from '@image-gateway/shared'
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Group,
  NumberInput,
  Select,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { error as logError } from '@tauri-apps/plugin-log'
import { EmptyState } from 'basalt-ui'
import { FormGroup, FormRow } from 'basalt-ui/controls'
import { VX } from 'basalt-ui/tokens'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CreateSeed } from '../App'
import { MaskCanvas, type MaskCanvasHandle } from '../components/create/MaskCanvas'
import {
  createDraftSchema,
  describeDraftNotices,
  parseCreateDraft,
  type CreateDraft,
  type LoadedDraft,
} from '../components/create/draft'
import { PlanCard } from '../components/create/PlanCard'
import {
  ReferencesRail,
  useReferenceUrls,
  type ReferenceItem,
} from '../components/create/ReferencesRail'
import { plan } from '../lib/gateway'
import type { LibraryEntry, SaveEditRequest, SaveGenerationRequest } from '../lib/library'
import { PRESETS } from '../lib/presets'
import { transparencyClaimMismatchesBackground } from '../lib/prompt-guard'
import { shouldStreamJob, useQueue } from '../lib/queue'
import { isSettingsConfigured, type Settings } from '../lib/settings'
import { studioStore } from '../lib/studio-store'

const QUALITY_OPTIONS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
const BACKGROUND_OPTIONS = ['auto', 'opaque', 'transparent']
const FORMAT_OPTIONS = ['png', 'webp', 'jpeg']
const MODERATION_OPTIONS = ['auto', 'low']
const PRESET_OPTIONS = PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function isSizePresetValue(size: string): boolean {
  return (SIZE_PRESETS as readonly string[]).includes(size)
}

/**
 * The `model` value the Create surface's own state ever holds. Deliberately narrower than
 * `GenerateRequest['model']` — the wire request schema also accepts `LEGACY_REQUEST_MODELS` (a
 * deploy-compat shim for a pre-2026-09-23 app build, `shared/src/contract.ts`), but the CURRENT
 * app must never construct or hold one of those ids itself. A value read off a seed (which is
 * typed against the wider wire shape) is narrowed through `toModelChoice` before it ever reaches
 * this state, rather than the state's type widening to match the wire.
 */
type ModelChoice = ImageModel | 'auto'

function toModelChoice(value: string | undefined): ModelChoice {
  if (value !== undefined && (IMAGE_MODELS as readonly string[]).includes(value)) {
    return value as ImageModel
  }
  return 'auto'
}

type CreateProps = {
  settings: Settings
  createSeed: CreateSeed | null
  entries: LibraryEntry[]
  onOpenSettings: () => void
}

/**
 * Merged Compose+Edit surface (docs/concept.md §2). Generate-vs-edit is
 * derived, not chosen: references attached routes to `/edit`, none routes to `/generate`. The
 * Plan card is the heart — brief in, crafted prompt + derived settings + warnings + cost out,
 * always shown before a run and always editable (the central taboo: never silently rewrite).
 */
export function Create({ settings, createSeed, entries, onOpenSettings }: CreateProps) {
  const queue = useQueue()

  // --- Brief / delta / prompt -------------------------------------------------------------
  const [brief, setBrief] = useState('')
  const [delta, setDelta] = useState('')
  const [prompt, setPrompt] = useState('')
  const [currentPrompt, setCurrentPrompt] = useState<string | undefined>(undefined)
  const deltaMode = currentPrompt !== undefined
  const [rawMode, setRawMode] = useState(false)
  const [intent, setIntent] = useState<Intent>('auto')

  // --- Plan ---------------------------------------------------------------------------------
  const [planResult, setPlanResult] = useState<PlanResponse | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [dismissedAssumptions, setDismissedAssumptions] = useState<Set<number>>(new Set())
  const [dismissedWarnings, setDismissedWarnings] = useState<Set<number>>(new Set())
  /** Indices of `planResult.warnings` the user resolved via "Apply compliant rewrite", vs. plain
   * dismissal — both hide the warning through `dismissedWarnings`, but the sidecar's per-warning
   * `action` (accepted|dismissed) needs to tell them apart. */
  const [acceptedWarnings, setAcceptedWarnings] = useState<Set<number>>(new Set())

  // --- Derived settings (pre-filled by Plan, always overridable) ----------------------------
  const [model, setModel] = useState<ModelChoice>(DEFAULT_MODEL)
  const [sizeChoice, setSizeChoice] = useState('auto')
  const [customSize, setCustomSize] = useState('')
  const [quality, setQuality] = useState<GenerateRequest['quality']>('auto')
  const [background, setBackground] = useState<GenerateRequest['background']>('auto')
  const [outputFormat, setOutputFormat] = useState<GenerateRequest['output_format']>('png')
  const [outputCompression, setOutputCompression] = useState<number | undefined>(undefined)
  const [moderation, setModeration] = useState<GenerateRequest['moderation']>('auto')
  const [n, setN] = useState(1)
  const [presetId, setPresetId] = useState<string | null>(null)

  /** Settings a restored draft or a replayed legacy generation could not keep, shown as a
   * dismissible Alert. The studio never rewrites a recorded setting silently (concept §2). */
  const [coercionNotice, setCoercionNotice] = useState<string | null>(null)

  /** Fields the user has explicitly touched since the last Plan/seed — echoed verbatim into the
   * next Plan request's `overrides` rather than silently re-derived (concept §2's central taboo). */
  const [pinnedFields, setPinnedFields] = useState<Set<string>>(new Set())

  function pinField(field: string): void {
    setPinnedFields((prev) => {
      const next = new Set(prev)
      next.add(field)
      return next
    })
  }

  function setQualityPinned(value: GenerateRequest['quality']): void {
    setQuality(value)
    pinField('quality')
  }
  function setBackgroundPinned(value: GenerateRequest['background']): void {
    setBackground(value)
    pinField('background')
  }
  function setNPinned(value: number): void {
    setN(value)
    pinField('n')
  }
  function setModerationPinned(value: GenerateRequest['moderation']): void {
    setModeration(value)
    pinField('moderation')
  }
  function setSizeChoicePinned(value: string): void {
    setSizeChoice(value)
    pinField('size')
  }
  function setCustomSizePinned(value: string): void {
    setCustomSize(value)
    pinField('size')
  }
  function applySizeString(value: string): void {
    if (isSizePresetValue(value)) {
      setSizeChoice(value)
      setCustomSize('')
    } else {
      setSizeChoice('custom')
      setCustomSize(value)
    }
  }

  // --- References / mask ---------------------------------------------------------------------
  const [references, setReferences] = useState<ReferenceItem[]>([])
  const isEdit = references.length > 0
  const referencesWithUrls = useReferenceUrls(references)
  const firstReferenceWithUrl = referencesWithUrls[0]
  const [brushSize, setBrushSize] = useState(40)
  const maskCanvasRef = useRef<MaskCanvasHandle>(null)

  const firstReferenceId = references[0]?.id
  const firstReferenceFile = references[0]?.file
  const [firstImageDims, setFirstImageDims] = useState<{ width: number; height: number } | null>(
    null,
  )

  useEffect(() => {
    if (!firstReferenceFile) {
      setFirstImageDims(null)
      return
    }
    let cancelled = false
    void createImageBitmap(firstReferenceFile)
      .then((bitmap) => {
        // Read dimensions BEFORE close(): a closed ImageBitmap is detached and reports 0x0
        // (browser-verified) — that would silently derive "0x0" and fall back to 'auto'.
        const dims = { width: bitmap.width, height: bitmap.height }
        bitmap.close()
        return cancelled ? undefined : setFirstImageDims(dims)
      })
      .catch((error: unknown) => {
        if (cancelled) return undefined
        const message = error instanceof Error ? error.message : String(error)
        void logError(`failed to read reference image dimensions: ${message}`)
        return setFirstImageDims(null)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the first reference's stable id, not the File object
  }, [firstReferenceId])

  // --- Lineage --------------------------------------------------------------------------------
  const [parent, setParent] = useState<GenerationParent | undefined>(undefined)

  // --- Project / style guide context ------------------------------------------------------
  const [projects, setProjects] = useState<Project[]>([])
  const [styleGuides, setStyleGuides] = useState<StyleGuide[]>([])
  const [selectedProjectSlug, setSelectedProjectSlug] = useState<string | null>(null)
  const [selectedStyleGuideSlug, setSelectedStyleGuideSlug] = useState<string | null>(null)

  useEffect(() => {
    void studioStore.listProjects().then(setProjects)
    void studioStore.listStyleGuides().then(setStyleGuides)
  }, [])

  const selectedStyleGuide = styleGuides.find((guide) => guide.slug === selectedStyleGuideSlug)

  // --- Job -------------------------------------------------------------------------------------
  const [jobId, setJobId] = useState<string | null>(null)
  const activeJob = jobId ? queue.jobs.find((job) => job.id === jobId) : undefined
  const loading = activeJob?.status === 'running'
  const result = activeJob?.response ?? null

  // --- Seed from Library (Tweak / Use as edit reference / series) -----------------------------
  useEffect(() => {
    if (!createSeed) return
    const req = createSeed.request
    // `req.model` is wire-typed (`GenerateRequestInput['model']`, which also accepts
    // `LEGACY_REQUEST_MODELS`) — narrowed here so the app's own state never holds a legacy id.
    // In practice every seed's model already went through `replay.ts`'s coercion to a real
    // `ImageModel` before it got here; this is the defensive backstop, not the primary guard.
    const seedModel = toModelChoice(req.model)
    const seedBackground = req.background ?? 'auto'
    const seedQuality = req.quality ?? 'auto'
    const seedEndpoint = (createSeed.references?.length ?? 0) > 0 ? 'edit' : 'generate'
    const seedResolved = resolveModel({
      model: seedModel,
      endpoint: seedEndpoint,
      quality: seedQuality,
    })
    // Seeded sizes may be truthful-but-unreplayable (e.g. a recorded 1254x1254) — snap through
    // the shared chokepoint before it ever reaches a control or a request. `replay.ts`'s builders
    // already snap too (defense in depth); re-snapping an already-valid size is a no-op.
    const snappedSize = snapSizeForModel(seedResolved, req.size ?? 'auto')

    // `replay.ts` already coerced a legacy seed and Library surfaced it; this is the belt-and-
    // braces pass for seeds built elsewhere, so a control can never hold an unrepresentable value.
    const backgroundUnsupported =
      seedBackground === 'transparent' && !MODEL_CAPABILITIES[seedResolved].transparentBackground
    if (backgroundUnsupported) {
      setCoercionNotice(
        `This generation requested a transparent background. ${seedResolved} has no alpha channel, so it was changed to opaque.`,
      )
    }

    setModel(seedModel)
    applySizeString(snappedSize)
    setQuality(seedQuality)
    setBackground(backgroundUnsupported ? 'opaque' : seedBackground)
    setOutputFormat(req.output_format ?? 'png')
    setOutputCompression(req.output_compression)
    setModeration(req.moderation ?? 'auto')
    setN(req.n ?? 1)
    setPrompt(req.prompt)
    setBrief('')
    setDelta('')
    // Tweak/series reopen the Plan in delta mode (concept §2: "continue from this" seeds the Plan
    // with the accepted prompt as context and an empty 'what changes?' field); "Use as edit
    // reference" seeds the prompt directly into the editable field instead — it isn't iterating on
    // an accepted plan, it's reusing one generation's output as another's raw material.
    setCurrentPrompt(createSeed.op === 'edit' ? undefined : req.prompt)
    setReferences((createSeed.references ?? []).map((file) => ({ id: crypto.randomUUID(), file })))
    setParent(createSeed.parent)
    setPinnedFields(new Set())
    setPlanResult(null)
    setPlanError(null)
    setJobId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once per new seed object, not on every render
  }, [createSeed])

  // --- Draft persistence (concept §2: "Create state is persisted... survive restarts") -------
  const [draftLoaded, setDraftLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void studioStore
      .readCreateDraft()
      .then((raw) => {
        if (cancelled) return undefined
        const parsed = parseCreateDraft(raw)
        if (!parsed) return undefined
        applyDraft(parsed.draft)
        if (parsed.notices.length > 0) {
          setCoercionNotice(
            `Your saved draft used settings this studio no longer supports — ${describeDraftNotices(parsed.notices)}.`,
          )
        }
        return undefined
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        void logError(`failed to read Create draft: ${message}`)
      })
      .finally(() => {
        if (!cancelled) setDraftLoaded(true)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time load on mount
  }, [])

  function applyDraft(draft: LoadedDraft): void {
    setBrief(draft.brief)
    setDelta(draft.delta)
    setPrompt(draft.prompt)
    setRawMode(draft.rawMode)
    setIntent(draft.intent)
    setModel(draft.model)
    setSizeChoice(draft.sizeChoice)
    setCustomSize(draft.customSize)
    setQuality(draft.quality)
    setBackground(draft.background)
    setOutputFormat(draft.outputFormat)
    setOutputCompression(draft.outputCompression)
    setN(draft.n)
    setModeration(draft.moderation)
    setPinnedFields(new Set(draft.pinnedFields))
    setParent(draft.parent)
    setCurrentPrompt(draft.currentPrompt)
    setSelectedProjectSlug(draft.projectSlug ?? null)
    setSelectedStyleGuideSlug(draft.styleGuideSlug ?? null)
  }

  useEffect(() => {
    if (!draftLoaded) return
    const timeout = setTimeout(() => {
      const draft = createDraftSchema.parse({
        version: 1,
        brief,
        delta,
        prompt,
        rawMode,
        intent,
        model,
        sizeChoice,
        customSize,
        quality,
        background,
        outputFormat,
        outputCompression,
        n,
        moderation,
        // Retained in the persisted shape for backward compatibility; no generatable model
        // supports input_fidelity, so the control is gone and this is always written as 'default'.
        inputFidelityChoice: 'default',
        pinnedFields: [...pinnedFields],
        parent,
        currentPrompt,
        projectSlug: selectedProjectSlug ?? undefined,
        styleGuideSlug: selectedStyleGuideSlug ?? undefined,
      } satisfies CreateDraft)
      void studioStore.writeCreateDraft(draft)
    }, 500)
    return () => clearTimeout(timeout)
  }, [
    draftLoaded,
    brief,
    delta,
    prompt,
    rawMode,
    intent,
    model,
    sizeChoice,
    customSize,
    quality,
    background,
    outputFormat,
    outputCompression,
    n,
    moderation,
    pinnedFields,
    parent,
    currentPrompt,
    selectedProjectSlug,
    selectedStyleGuideSlug,
  ])

  // --- Derived model/size state ---------------------------------------------------------------
  // Both generatable models accept arbitrary `WxH` on both the generate and edit endpoints, so
  // custom sizes are always available — the old presets-only gate belonged to the retired models.
  const resolvedModel = useMemo(
    () => resolveModel({ model, endpoint: isEdit ? 'edit' : 'generate', quality }),
    [model, isEdit, quality],
  )

  if (!isSettingsConfigured(settings.gateway)) {
    return (
      <EmptyState
        title="Connect your gateway"
        description="Add the image-gateway URL and bearer token in Settings to start creating."
        action={<Button onClick={onOpenSettings}>Open settings</Button>}
      />
    )
  }

  const sizeOptions = [...SIZE_PRESETS, 'custom']
  // An edit defaults to preserving its primary reference's shape; a plain generation's 'auto'
  // stays 'auto' (upstream's own auto-sizing) — snapping only happens on replay, not here.
  const derivedAutoSize =
    isEdit && firstImageDims
      ? snapSizeForModel(resolvedModel, `${firstImageDims.width}x${firstImageDims.height}`)
      : 'auto'
  const effectiveSize =
    sizeChoice === 'custom' ? customSize : sizeChoice === 'auto' ? derivedAutoSize : sizeChoice
  const customSizeError =
    sizeChoice === 'custom' ? validateSizeForModel(resolvedModel, customSize) : null
  // `transparent` needs an alpha channel in the OUTPUT FORMAT, not just the model — jpeg has none.
  const transparentFormatError = validateTransparentOutputFormat(background, outputFormat)

  const streaming = shouldStreamJob(n, true)
  const liveCost = estimateCost({
    model: resolvedModel,
    quality,
    size: effectiveSize,
    streaming,
    n,
  })

  const briefLabel = deltaMode ? 'What changes?' : 'Brief'
  const briefValue = deltaMode ? delta : brief
  const planDisabled = planLoading || (!deltaMode && brief.trim().length === 0)
  const canSubmit =
    prompt.trim().length > 0 &&
    !loading &&
    customSizeError === null &&
    transparentFormatError === null
  // Warning only — never gates canSubmit. The studio never silently overrules the user.
  const transparencyMismatch = transparencyClaimMismatchesBackground(prompt, background)

  function buildOverrides(): PlanOverrides | undefined {
    const overrides: PlanOverrides = {}
    if (pinnedFields.has('model')) overrides.model = model
    if (pinnedFields.has('size')) overrides.size = effectiveSize
    if (pinnedFields.has('quality')) overrides.quality = quality
    if (pinnedFields.has('background')) overrides.background = background
    if (pinnedFields.has('n')) overrides.n = n
    if (pinnedFields.has('moderation')) overrides.moderation = moderation
    // No `input_fidelity` override: neither generatable model accepts the parameter.
    return Object.keys(overrides).length > 0 ? overrides : undefined
  }

  /** The selected project's anchors that resolve to a known library entry — shared by
   * `buildSeriesContext` (what gets sent to `/enhance`) and `buildEnhanceRecord` (what gets
   * recorded as `series_context_ids` in the saved sidecar), so the two can't drift apart. */
  function matchedSeriesAnchors(): LibraryEntry[] {
    if (!selectedProjectSlug) return []
    const project = projects.find((candidate) => candidate.slug === selectedProjectSlug)
    if (!project) return []
    return project.anchor_ids
      .map((id) => entries.find((entry) => entry.metadata.id === id))
      .filter((entry): entry is LibraryEntry => entry !== undefined)
  }

  function buildSeriesContext(): SeriesContextEntry[] {
    return matchedSeriesAnchors().map((entry) => ({
      prompt: entry.metadata.prompt,
      settings: entry.metadata.params as unknown as Record<string, unknown>,
    }))
  }

  /**
   * The accepted Plan = the eval tuple (docs/concept.md §6) — built at submit time from the
   * last-run Plan plus what the user did with it. Raw mode and "no plan run yet" both omit
   * `enhance` entirely rather than synthesizing a fake record (concept §2's central taboo).
   */
  function buildEnhanceRecord(): SidecarEnhance | undefined {
    if (rawMode || !planResult) return undefined
    return {
      brief: briefValue,
      intent: planResult.intent.detected,
      mode_applied: planResult.mode_applied,
      plan_prompt: planResult.prompt,
      final_prompt_edited: prompt !== planResult.prompt,
      additions: planResult.additions,
      assumptions: planResult.assumptions.filter((_, index) => !dismissedAssumptions.has(index)),
      warnings: planResult.warnings.map((warning, index) => ({
        code: warning.code,
        severity: warning.severity,
        action: acceptedWarnings.has(index) ? ('accepted' as const) : ('dismissed' as const),
      })),
      series_context_ids: matchedSeriesAnchors().map((entry) => entry.metadata.id),
      playbook_version: planResult.playbook_version,
      enhance_model: planResult.enhance_model,
    }
  }

  function applyPlanSettings(planSettings: PlanResponse['settings']): void {
    setModel(planSettings.model)
    applySizeString(planSettings.size)
    setQuality(planSettings.quality)
    setBackground(planSettings.background)
    setN(planSettings.n)
    setModeration(planSettings.moderation)
  }

  async function handlePlan(): Promise<void> {
    setPlanLoading(true)
    setPlanError(null)
    try {
      const overrides = buildOverrides()
      const styleGuideForRequest = selectedStyleGuide
        ? {
            prompt_fragment: selectedStyleGuide.prompt_fragment,
            palette: selectedStyleGuide.palette.map((color) => color.hex),
            avoid: selectedStyleGuide.avoid,
            ref_image_count: selectedStyleGuide.reference_images.length,
          }
        : undefined

      const input: PlanRequestInput = {
        mode: rawMode ? 'off' : 'auto',
        intent,
        ...(deltaMode
          ? {
              current_prompt: currentPrompt ?? '',
              ...(delta.trim().length > 0 ? { delta } : {}),
            }
          : { brief }),
        ...(overrides ? { overrides } : {}),
        ...(styleGuideForRequest ? { style_guide: styleGuideForRequest } : {}),
        series_context: buildSeriesContext(),
        preserve_list: [],
        has_references: references.length > 0,
      }

      const response = await plan(settings.gateway, input)
      setPlanResult(response)
      setPrompt(response.prompt)
      applyPlanSettings(response.settings)
      setDismissedAssumptions(new Set())
      setDismissedWarnings(new Set())
      setAcceptedWarnings(new Set())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void logError(`plan failed: ${message}`)
      setPlanError(message)
      notifications.show({ color: 'red', title: 'Plan failed', message })
    } finally {
      setPlanLoading(false)
    }
  }

  function handleApplyRewrite(index: number, warning: PlanWarning): void {
    if (warning.suggested_rewrite) setPrompt(warning.suggested_rewrite)
    if (warning.moderation_suggestion) setModeration(warning.moderation_suggestion)
    setDismissedWarnings((prev) => new Set(prev).add(index))
    setAcceptedWarnings((prev) => new Set(prev).add(index))
  }

  function handleClearDelta(): void {
    setCurrentPrompt(undefined)
    setDelta('')
    setParent(undefined)
    setPlanResult(null)
  }

  function applyPreset(id: string | null): void {
    setPresetId(id)
    if (!id) return
    const preset = PRESETS.find((candidate) => candidate.id === id)
    if (!preset) return
    setQualityPinned(preset.request.quality)
    setBackgroundPinned(preset.request.background)
    if (isSizePresetValue(preset.request.size)) {
      setSizeChoicePinned(preset.request.size)
      setCustomSize('')
    } else {
      setSizeChoicePinned('custom')
      setCustomSizePinned(preset.request.size)
    }
  }

  /** Shared by `buildGenerateInput`/`buildEditInput` — the app-only fields neither request sends
   * to the gateway but both save-request types now carry (Task 3/4: enhance eval tuple + context). */
  function buildSaveContext(): Pick<
    SaveGenerationRequest,
    'enhance' | 'project_ids' | 'style_guide_ids'
  > {
    const enhance = buildEnhanceRecord()
    return {
      ...(enhance !== undefined ? { enhance } : {}),
      ...(selectedProjectSlug !== null ? { project_ids: [selectedProjectSlug] } : {}),
      ...(selectedStyleGuideSlug !== null ? { style_guide_ids: [selectedStyleGuideSlug] } : {}),
    }
  }

  function buildGenerateInput(): SaveGenerationRequest {
    return {
      prompt,
      model,
      size: effectiveSize,
      quality,
      background,
      output_format: outputFormat,
      n,
      moderation,
      ...(outputCompression !== undefined ? { output_compression: outputCompression } : {}),
      ...(parent !== undefined ? { parent } : {}),
      ...buildSaveContext(),
    }
  }

  function buildEditInput(): SaveEditRequest {
    return {
      prompt,
      model,
      size: effectiveSize,
      quality,
      background,
      output_format: outputFormat,
      n,
      moderation,
      // No `input_fidelity`: no generatable model accepts the parameter (both are locked to high
      // fidelity internally and 400 on it outright).
      ...(parent !== undefined ? { parent } : {}),
      ...buildSaveContext(),
    }
  }

  function handleCancel(): void {
    if (jobId) queue.cancel(jobId)
  }

  async function handleSubmit(): Promise<void> {
    if (!isEdit) {
      setJobId(queue.enqueueGenerate(buildGenerateInput()))
      return
    }

    try {
      let maskFile: File | undefined
      const maskBlob = await maskCanvasRef.current?.exportMask()
      if (maskBlob) {
        if (maskBlob.size > EDIT_LIMITS.maxMaskBytes) {
          notifications.show({
            color: 'red',
            title: 'Mask too large',
            message: `Painted mask is ${formatBytes(maskBlob.size)} — must be under ${formatBytes(EDIT_LIMITS.maxMaskBytes)}. Clear some of the painted area.`,
          })
          return
        }
        maskFile = new File([maskBlob], 'mask.png', { type: 'image/png' })
      }

      const input = buildEditInput()
      const images = references.map((item) => item.file)
      setJobId(queue.enqueueEdit(input, images, maskFile))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void logError(`mask export failed: ${message}`)
      notifications.show({ color: 'red', title: 'Could not prepare edit', message })
    }
  }

  const presetDescription = presetId
    ? PRESETS.find((preset) => preset.id === presetId)?.description
    : undefined

  return (
    <Stack gap="lg" p="lg" maw={860} mx="auto">
      <Group gap="sm" wrap="wrap">
        <FormRow label="Project" htmlFor="create-project" style={{ width: 200 }}>
          <Select
            id="create-project"
            placeholder="No project"
            data={projects.map((project) => ({ value: project.slug, label: project.name }))}
            value={selectedProjectSlug}
            onChange={setSelectedProjectSlug}
            clearable
            size="xs"
          />
        </FormRow>
        <FormRow label="Style guide" htmlFor="create-style-guide" style={{ width: 200 }}>
          <Select
            id="create-style-guide"
            placeholder="No style guide"
            data={styleGuides.map((guide) => ({ value: guide.slug, label: guide.name }))}
            value={selectedStyleGuideSlug}
            onChange={setSelectedStyleGuideSlug}
            clearable
            size="xs"
          />
        </FormRow>
        {isEdit && (
          <Badge variant="light" color="blue" mt="lg">
            edit — {references.length} reference{references.length === 1 ? '' : 's'}
          </Badge>
        )}
      </Group>

      {coercionNotice !== null && (
        <Alert
          color="yellow"
          variant="light"
          title="Settings changed"
          withCloseButton
          onClose={() => setCoercionNotice(null)}
        >
          {coercionNotice}
        </Alert>
      )}

      <PlanCard
        briefLabel={briefLabel}
        briefValue={briefValue}
        onBriefChange={deltaMode ? setDelta : setBrief}
        deltaMode={deltaMode}
        {...(currentPrompt !== undefined ? { currentPromptPreview: currentPrompt } : {})}
        {...(deltaMode ? { onClearDelta: handleClearDelta } : {})}
        rawMode={rawMode}
        onRawModeChange={setRawMode}
        intent={intent}
        onIntentChange={setIntent}
        onPlan={() => void handlePlan()}
        planDisabled={planDisabled}
        planLoading={planLoading}
        planError={planError}
        planResult={planResult}
        prompt={prompt}
        onPromptChange={setPrompt}
        dismissedAssumptions={dismissedAssumptions}
        onDismissAssumption={(index) => setDismissedAssumptions((prev) => new Set(prev).add(index))}
        dismissedWarnings={dismissedWarnings}
        onDismissWarning={(index) => setDismissedWarnings((prev) => new Set(prev).add(index))}
        onApplyRewrite={handleApplyRewrite}
        estimatedCost={{ perImageUsd: liveCost.per_image_usd, totalUsd: liveCost.total_usd }}
      />

      <ReferencesRail items={references} onItemsChange={setReferences} libraryEntries={entries} />

      {firstReferenceWithUrl && (
        <Card py="xs" px="sm">
          <Stack gap="sm">
            <Group justify="space-between">
              <Title order={5}>Mask (optional)</Title>
              <Text size="xs" c="dimmed">
                Applies to the primary reference only — unpainted areas are preserved
              </Text>
            </Group>
            <MaskCanvas
              key={firstReferenceWithUrl.id}
              ref={maskCanvasRef}
              imageUrl={firstReferenceWithUrl.url}
              brushSize={brushSize}
              onBrushSizeChange={setBrushSize}
            />
          </Stack>
        </Card>
      )}

      <Card py="xs" px="sm">
        <Stack gap="md">
          <FormRow
            label="Preset"
            htmlFor="create-preset"
            {...(presetDescription !== undefined ? { hint: presetDescription } : {})}
          >
            <Select
              id="create-preset"
              placeholder="Apply a preset…"
              data={PRESET_OPTIONS}
              value={presetId}
              onChange={applyPreset}
              clearable
            />
          </FormRow>

          <Group grow align="flex-start">
            <FormRow
              label="Model"
              hint={`auto routes drafts (low/medium) to ${DEFAULT_MODEL} and edits/high+ finals to sunburst.`}
            >
              <Group gap="xs" h={36}>
                <Badge variant="light" size="lg">
                  {resolvedModel}
                </Badge>
              </Group>
            </FormRow>
            <FormRow label="Format" htmlFor="create-format">
              <Select
                id="create-format"
                data={FORMAT_OPTIONS}
                value={outputFormat}
                onChange={(value) => {
                  if (value) setOutputFormat(value as GenerateRequest['output_format'])
                }}
                allowDeselect={false}
                error={transparentFormatError ?? undefined}
              />
            </FormRow>
            <FormRow label="Images" htmlFor="create-images">
              <NumberInput
                id="create-images"
                min={1}
                max={10}
                value={n}
                onChange={(value) => {
                  const parsed = typeof value === 'number' ? value : Number(value)
                  if (!Number.isNaN(parsed)) setNPinned(parsed)
                }}
              />
            </FormRow>
          </Group>

          <FormGroup label="Size">
            <SegmentedControl
              value={sizeChoice}
              onChange={setSizeChoicePinned}
              data={sizeOptions.map((value) => ({ value, label: value }))}
            />
            {sizeChoice === 'custom' && (
              <TextInput
                placeholder="e.g. 2560x1440"
                value={customSize}
                onChange={(event) => setCustomSizePinned(event.currentTarget.value)}
                error={customSizeError ?? undefined}
              />
            )}
          </FormGroup>

          <FormGroup label="Quality">
            <SegmentedControl
              value={quality}
              onChange={(value) => setQualityPinned(value as GenerateRequest['quality'])}
              data={QUALITY_OPTIONS}
            />
          </FormGroup>

          <FormGroup
            label="Background"
            {...(transparentFormatError !== null ? { error: transparentFormatError } : {})}
          >
            <SegmentedControl
              value={background}
              onChange={(value) => setBackgroundPinned(value as GenerateRequest['background'])}
              data={
                MODEL_CAPABILITIES[resolvedModel].transparentBackground
                  ? BACKGROUND_OPTIONS
                  : BACKGROUND_OPTIONS.filter((value) => value !== 'transparent')
              }
            />
          </FormGroup>

          <Group grow align="flex-start">
            {outputFormat !== 'png' && (
              <FormRow
                label="Output compression"
                hint="0–100, jpeg/webp only."
                htmlFor="create-compression"
              >
                <NumberInput
                  id="create-compression"
                  min={0}
                  max={100}
                  {...(outputCompression !== undefined ? { value: outputCompression } : {})}
                  onChange={(value) => {
                    if (value === '') {
                      setOutputCompression(undefined)
                      return
                    }
                    const parsed = typeof value === 'number' ? value : Number(value)
                    setOutputCompression(Number.isNaN(parsed) ? undefined : parsed)
                  }}
                />
              </FormRow>
            )}
            <FormRow label="Moderation" htmlFor="create-moderation">
              <Select
                id="create-moderation"
                data={MODERATION_OPTIONS}
                value={moderation}
                onChange={(value) => {
                  if (value) setModerationPinned(value as GenerateRequest['moderation'])
                }}
                allowDeselect={false}
              />
            </FormRow>
          </Group>

          {transparencyMismatch !== null && (
            <Alert color="yellow" variant="light" title="Prompt/background mismatch">
              This prompt mentions “{transparencyMismatch}”, but the request sends{' '}
              <strong>background: {background}</strong> — generating anyway tends to paint a fake
              transparency checkerboard into the image instead of erroring. Either set Background to
              “transparent” above, or reword the prompt (e.g. “on a plain solid white background”).
            </Alert>
          )}

          <Group justify="flex-end" gap="sm">
            {loading && (
              <Button variant="outline" color="red" onClick={handleCancel}>
                Cancel
              </Button>
            )}
            <Button onClick={() => void handleSubmit()} loading={loading} disabled={!canSubmit}>
              {isEdit ? 'Generate edit' : 'Generate'}
            </Button>
          </Group>
        </Stack>
      </Card>

      {loading && activeJob?.preview && (
        <Card py="xs" px="sm">
          <Stack gap="xs">
            <Badge variant="light">Generating…</Badge>
            <img
              src={activeJob.preview.dataUrl}
              alt="Live preview"
              style={{
                maxWidth: 320,
                maxHeight: 320,
                borderRadius: VX.radiusCard,
                display: 'block',
              }}
            />
          </Stack>
        </Card>
      )}

      {result && (
        <Card py="xs" px="sm">
          <Stack gap="md">
            <Group justify="space-between">
              <Title order={5}>Result</Title>
              <Group gap="xs">
                <Badge variant="light">{result.model}</Badge>
              </Group>
            </Group>

            <Group gap="md" wrap="wrap">
              {result.images.map((image, index) => (
                <Box
                  // eslint-disable-next-line react/no-array-index-key -- images have no stable id
                  key={index}
                  style={{ borderRadius: VX.radiusCard, overflow: 'hidden' }}
                >
                  <img
                    src={`data:image/${image.format};base64,${image.b64_json}`}
                    alt={`Result ${index + 1}`}
                    style={{ maxWidth: 320, maxHeight: 320, display: 'block' }}
                  />
                </Box>
              ))}
            </Group>

            <Group gap="lg">
              <Text size="sm" c="dimmed">
                Cost: {result.cost.usd !== null ? `$${result.cost.usd.toFixed(4)}` : 'n/a'}
              </Text>
              <Text size="sm" c="dimmed">
                Tokens: {result.usage.total_tokens}
              </Text>
              <Text size="sm" c="dimmed">
                Latency: {result.latency_ms}ms
              </Text>
            </Group>

            {activeJob?.savedId && (
              <Alert color="green" variant="light">
                Saved to library as <strong>{activeJob.savedId}</strong>
              </Alert>
            )}
          </Stack>
        </Card>
      )}
    </Stack>
  )
}
