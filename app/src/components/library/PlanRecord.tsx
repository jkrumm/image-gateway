import type { SidecarEnhance } from '@image-gateway/shared'
import { Badge, Group, Stack, Text } from '@mantine/core'

function warningColor(action: 'accepted' | 'dismissed'): string {
  return action === 'accepted' ? 'teal' : 'gray'
}

type PlanRecordProps = {
  enhance: SidecarEnhance | undefined
}

/**
 * Renders the sidecar's `enhance` block — the accepted Plan (docs/concept.md §6: "the accepted
 * Plan = the eval tuple"). Optional: raw-mode generations legitimately have none, so this renders
 * nothing rather than empty scaffolding when `enhance` is absent.
 */
export function PlanRecord({ enhance }: PlanRecordProps) {
  if (!enhance) return null

  return (
    <Stack gap={6}>
      <Text size="sm" fw={500}>
        Plan
      </Text>
      <Text size="xs" c="dimmed">
        {enhance.brief}
      </Text>
      <Group gap={4} wrap="wrap">
        <Badge variant="light">intent: {enhance.intent}</Badge>
        <Badge variant="light">mode: {enhance.mode_applied}</Badge>
        {enhance.final_prompt_edited && <Badge variant="outline">prompt edited after plan</Badge>}
        <Badge variant="outline" color="gray">
          playbook {enhance.playbook_version} · {enhance.enhance_model}
        </Badge>
      </Group>

      {enhance.additions.length > 0 && (
        <Group gap={4} wrap="wrap">
          {enhance.additions.map((addition, index) => (
            <Badge key={`${addition.slot}-${index}`} variant="outline" color="gray">
              {addition.slot}: {addition.text}
            </Badge>
          ))}
        </Group>
      )}

      {enhance.assumptions.length > 0 && (
        <Stack gap={2}>
          {enhance.assumptions.map((assumption, index) => (
            // eslint-disable-next-line react/no-array-index-key -- assumptions are plain strings with no stable id
            <Text key={index} size="xs" c="dimmed">
              · {assumption}
            </Text>
          ))}
        </Stack>
      )}

      {enhance.warnings.length > 0 && (
        <Group gap={4} wrap="wrap">
          {enhance.warnings.map((warning, index) => (
            <Badge
              // eslint-disable-next-line react/no-array-index-key -- warning records have no stable id
              key={index}
              variant="light"
              color={warningColor(warning.action)}
            >
              {warning.code} ({warning.severity}) — {warning.action}
            </Badge>
          ))}
        </Group>
      )}
    </Stack>
  )
}
