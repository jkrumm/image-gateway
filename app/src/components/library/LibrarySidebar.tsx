import type { Project } from '@image-gateway/shared'
import { Group, NavLink, Stack, Text, Title } from '@mantine/core'
import type { LibraryScope } from '../../lib/library-filters'

type LibrarySidebarProps = {
  scope: LibraryScope
  onScopeChange: (scope: LibraryScope) => void
  projects: Project[]
  allCount: number
  starredCount: number
}

function scopeKey(scope: LibraryScope): string {
  return scope.type === 'project' ? `project:${scope.slug}` : scope.type
}

/** Library sidebar scopes (docs/concept.md §2): All / Starred / Projects. Project membership comes
 * from `studioStore.listProjects()` — real data, not a placeholder, though a fresh library may show
 * none yet. */
export function LibrarySidebar({
  scope,
  onScopeChange,
  projects,
  allCount,
  starredCount,
}: LibrarySidebarProps) {
  return (
    <Stack gap={4} w={200} style={{ flexShrink: 0 }}>
      <Title order={6} c="dimmed" tt="uppercase" fz="xs">
        Library
      </Title>
      <NavLink
        label={
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm">All</Text>
            <Text size="xs" c="dimmed">
              {allCount}
            </Text>
          </Group>
        }
        active={scopeKey(scope) === 'all'}
        onClick={() => onScopeChange({ type: 'all' })}
      />
      <NavLink
        label={
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm">Starred</Text>
            <Text size="xs" c="dimmed">
              {starredCount}
            </Text>
          </Group>
        }
        active={scopeKey(scope) === 'starred'}
        onClick={() => onScopeChange({ type: 'starred' })}
      />

      <Title order={6} c="dimmed" tt="uppercase" fz="xs" mt="md">
        Projects
      </Title>
      {projects.length === 0 && (
        <Text size="xs" c="dimmed" px="xs">
          No projects yet
        </Text>
      )}
      {projects.map((project) => (
        <NavLink
          key={project.slug}
          label={project.name}
          active={scopeKey(scope) === `project:${project.slug}`}
          onClick={() => onScopeChange({ type: 'project', slug: project.slug })}
        />
      ))}
    </Stack>
  )
}
