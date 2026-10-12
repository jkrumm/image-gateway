import { ROLES, type GenerationImageV2, type Role } from '@image-gateway/shared'
import { ActionIcon, Chip, Group, Tooltip } from '@mantine/core'

type RolesEditorProps = {
  image: GenerationImageV2
  saving: boolean
  onRolesChange: (roles: Role[]) => void
  onStarredChange: (starred: boolean) => void
}

/**
 * Per-image roles + star editor (docs/concept.md §3: closed behavioral vocabulary, star as the
 * orthogonal one-bit curation gesture). Writes go through `Library.tsx`'s
 * `updateGenerationMetadata` call — this component only reports the next desired value.
 */
export function RolesEditor({ image, saving, onRolesChange, onStarredChange }: RolesEditorProps) {
  return (
    <Group gap="xs" align="center" wrap="wrap">
      <Tooltip label={image.starred ? 'Unstar' : 'Star'}>
        <ActionIcon
          variant={image.starred ? 'filled' : 'subtle'}
          color="yellow"
          size="sm"
          disabled={saving}
          onClick={() => onStarredChange(!image.starred)}
          aria-label={image.starred ? 'Unstar' : 'Star'}
        >
          {image.starred ? '★' : '☆'}
        </ActionIcon>
      </Tooltip>
      {/* theme-allow control-outside-home — rendered only inside GenerationInspector's Modal (an overlay non-home); the rule cannot see an overlay across the file boundary */}
      <Chip.Group
        multiple
        value={image.roles}
        onChange={(values) => onRolesChange(values as Role[])}
      >
        <Group gap={4} wrap="wrap">
          {ROLES.map((role) => (
            <Chip key={role} value={role} size="xs" disabled={saving}>
              {role}
            </Chip>
          ))}
        </Group>
      </Chip.Group>
    </Group>
  )
}
