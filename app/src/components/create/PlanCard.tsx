import { INTENTS, type Intent, type PlanResponse, type PlanWarning } from '@image-gateway/shared'
import {
  Alert,
  Badge,
  Button,
  Card,
  CloseButton,
  Group,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core'
import { FormRow } from 'basalt-ui/controls'
import type { KeyboardEvent } from 'react'

const INTENT_OPTIONS = INTENTS.map((intent) => ({ value: intent, label: intent }))

const MODE_BANNER: Record<PlanResponse['mode_applied'], string | null> = {
  full: null,
  gaps: 'Gap-fill only — your wording was mostly kept, missing slots (lighting, medium, …) were filled in.',
  off: 'Passthrough — your prompt, untouched. Settings were still derived and validated.',
  auto: null,
}

function warningColor(severity: PlanWarning['severity']): string {
  if (severity === 'hard') return 'red'
  if (severity === 'rewrite') return 'orange'
  return 'yellow'
}

export type PlanCardProps = {
  briefLabel: string
  briefValue: string
  onBriefChange: (value: string) => void
  deltaMode: boolean
  currentPromptPreview?: string
  onClearDelta?: () => void
  rawMode: boolean
  onRawModeChange: (value: boolean) => void
  intent: Intent
  onIntentChange: (value: Intent) => void
  onPlan: () => void
  planDisabled: boolean
  planLoading: boolean
  planError: string | null
  planResult: PlanResponse | null
  prompt: string
  onPromptChange: (value: string) => void
  dismissedAssumptions: ReadonlySet<number>
  onDismissAssumption: (index: number) => void
  dismissedWarnings: ReadonlySet<number>
  onDismissWarning: (index: number) => void
  onApplyRewrite: (index: number, warning: PlanWarning) => void
  estimatedCost: { perImageUsd: number; totalUsd: number }
}

/**
 * The Plan card (concept §2, "the heart"): Brief → Plan (explicit action only, never on
 * keystroke) → editable prompt with enhancer additions marked, removable assumption chips,
 * inline policy warnings with one-click rewrite, and cost shown before running. The central
 * taboo (Berkeley finding): never silently rewrite — every derived value here is visible and
 * overridable, and passthrough mode says so out loud via the mode banner.
 */
export function PlanCard({
  briefLabel,
  briefValue,
  onBriefChange,
  deltaMode,
  currentPromptPreview,
  onClearDelta,
  rawMode,
  onRawModeChange,
  intent,
  onIntentChange,
  onPlan,
  planDisabled,
  planLoading,
  planError,
  planResult,
  prompt,
  onPromptChange,
  dismissedAssumptions,
  onDismissAssumption,
  dismissedWarnings,
  onDismissWarning,
  onApplyRewrite,
  estimatedCost,
}: PlanCardProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      if (!planDisabled) onPlan()
    }
  }

  const banner = planResult ? MODE_BANNER[planResult.mode_applied] : null

  return (
    <Card py="xs" px="sm">
      <Stack gap="md">
        {deltaMode && (
          <Alert color="blue" variant="light" title="Iterating from a previous generation">
            <Stack gap={4}>
              {currentPromptPreview && (
                <Text size="xs" c="dimmed" lineClamp={2}>
                  {currentPromptPreview}
                </Text>
              )}
              {onClearDelta && (
                <Button
                  size="xs"
                  variant="subtle"
                  onClick={onClearDelta}
                  style={{ alignSelf: 'flex-start' }}
                >
                  Start fresh instead
                </Button>
              )}
            </Stack>
          </Alert>
        )}

        <Textarea
          label={briefLabel}
          placeholder={
            deltaMode
              ? 'What changes? e.g. "make the sky stormier"'
              : 'Describe the image you want…'
          }
          autosize
          minRows={2}
          maxRows={8}
          value={briefValue}
          onChange={(event) => onBriefChange(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />

        <Group justify="space-between" wrap="wrap">
          <Group gap="sm">
            <FormRow label="Intent" htmlFor="plan-intent" style={{ width: 140 }}>
              <Select
                id="plan-intent"
                data={INTENT_OPTIONS}
                value={intent}
                onChange={(value) => {
                  if (value) onIntentChange(value as Intent)
                }}
                allowDeselect={false}
                size="xs"
              />
            </FormRow>
            <Tooltip label="Skip prose rewriting — still derives and validates settings, still runs the policy pre-check.">
              <Switch
                label="Raw (skip rewrite)"
                checked={rawMode}
                onChange={(event) => onRawModeChange(event.currentTarget.checked)}
                size="sm"
                mt="lg"
              />
            </Tooltip>
          </Group>
          <Button onClick={onPlan} loading={planLoading} disabled={planDisabled}>
            Plan (⌘⏎)
          </Button>
        </Group>

        {planError && (
          <Alert color="red" variant="light">
            {planError}
          </Alert>
        )}

        {banner && (
          <Alert color="gray" variant="light">
            {banner}
          </Alert>
        )}

        {planResult && (
          <Group gap="xs">
            <Badge variant="light">intent: {planResult.intent.detected}</Badge>
            <Badge variant="light">mode: {planResult.mode_applied}</Badge>
            {!planResult.verbatim_check.ok && (
              <Tooltip label={`Missing: ${planResult.verbatim_check.missing.join(', ')}`}>
                <Badge color="orange" variant="light">
                  verbatim check flagged {planResult.verbatim_check.missing.length} term
                  {planResult.verbatim_check.missing.length === 1 ? '' : 's'}
                </Badge>
              </Tooltip>
            )}
          </Group>
        )}

        <Textarea
          label="Prompt"
          description="Sent as-is. Edit freely — nothing here is re-derived silently."
          placeholder={
            deltaMode ? undefined : 'Plan will fill this in, or type your own prompt directly…'
          }
          autosize
          minRows={3}
          maxRows={12}
          value={prompt}
          onChange={(event) => onPromptChange(event.currentTarget.value)}
        />

        {planResult && planResult.additions.length > 0 && (
          <Stack gap={4}>
            <Text size="xs" fw={500} c="dimmed">
              Enhancer additions
            </Text>
            <Group gap={4} wrap="wrap">
              {planResult.additions.map((addition, index) => (
                <Badge key={`${addition.slot}-${index}`} variant="outline" color="gray">
                  {addition.slot}: {addition.text}
                </Badge>
              ))}
            </Group>
          </Stack>
        )}

        {planResult && planResult.assumptions.length > 0 && (
          <Stack gap={4}>
            <Text size="xs" fw={500} c="dimmed">
              Assumptions
            </Text>
            <Group gap={4} wrap="wrap">
              {planResult.assumptions.map((assumption, index) =>
                dismissedAssumptions.has(index) ? null : (
                  // eslint-disable-next-line react/no-array-index-key -- assumptions are plain strings with no stable id
                  <Badge
                    key={index}
                    variant="light"
                    rightSection={
                      <CloseButton
                        size={14}
                        aria-label="Dismiss assumption"
                        onClick={(event) => {
                          event.stopPropagation()
                          onDismissAssumption(index)
                        }}
                      />
                    }
                  >
                    {assumption}
                  </Badge>
                ),
              )}
            </Group>
          </Stack>
        )}

        {planResult &&
          planResult.warnings.map((warning, index) =>
            dismissedWarnings.has(index) ? null : (
              <Alert
                // eslint-disable-next-line react/no-array-index-key -- warnings are plain records with no stable id
                key={index}
                color={warningColor(warning.severity)}
                variant="light"
                title={warning.code}
                withCloseButton
                onClose={() => onDismissWarning(index)}
              >
                <Stack gap={6}>
                  <Text size="sm">{warning.message}</Text>
                  {warning.suggested_rewrite && (
                    <Button
                      size="xs"
                      variant="light"
                      color={warningColor(warning.severity)}
                      onClick={() => onApplyRewrite(index, warning)}
                      style={{ alignSelf: 'flex-start' }}
                    >
                      Apply compliant rewrite
                    </Button>
                  )}
                </Stack>
              </Alert>
            ),
          )}

        <Group gap="lg">
          <Text size="sm" c="dimmed">
            Estimated cost: ${estimatedCost.perImageUsd.toFixed(4)}/image · $
            {estimatedCost.totalUsd.toFixed(4)} total
          </Text>
          {planResult && (
            <Text size="xs" c="dimmed">
              (at plan time: ${planResult.estimated_cost.per_image_usd.toFixed(4)}/image)
            </Text>
          )}
        </Group>
      </Stack>
    </Card>
  )
}
