import { describe, expect, test } from 'bun:test'
import type { GenerationImageV2 } from '@image-gateway/shared'
import { withImageRoleAdded, withImageRoles, withImageStarred } from './roles'

const images: GenerationImageV2[] = [
  { filename: 'image-1.png', format: 'png', roles: ['draft'], starred: false },
  { filename: 'image-2.png', format: 'png', roles: [], starred: true },
]

describe('withImageRoles', () => {
  test('replaces the target image roles, leaving others untouched', () => {
    const next = withImageRoles(images, 'image-1.png', ['final', 'icon'])
    expect(next[0]?.roles).toEqual(['final', 'icon'])
    expect(next[1]).toBe(images[1])
  })
})

describe('withImageStarred', () => {
  test('sets the target image starred flag, leaving others untouched', () => {
    const next = withImageStarred(images, 'image-2.png', false)
    expect(next[1]?.starred).toBe(false)
    expect(next[0]).toBe(images[0])
  })
})

describe('withImageRoleAdded', () => {
  test('adds a role that is not yet present', () => {
    const next = withImageRoleAdded(images, 'image-1.png', 'style-source')
    expect(next[0]?.roles).toEqual(['draft', 'style-source'])
  })

  test('is idempotent when the role is already present', () => {
    const next = withImageRoleAdded(images, 'image-1.png', 'draft')
    expect(next[0]?.roles).toEqual(['draft'])
    expect(next[0]).toBe(images[0])
  })

  test('leaves other images untouched', () => {
    const next = withImageRoleAdded(images, 'image-1.png', 'style-source')
    expect(next[1]).toBe(images[1])
  })
})
