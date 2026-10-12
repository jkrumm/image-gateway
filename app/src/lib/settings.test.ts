/**
 * Settings persistence. The `useSettings` hook itself is localStorage-backed and needs a DOM, so
 * what is pinned here is the part that actually fixes the "enter the token again" bug: the
 * file-backed load/store pair, exercised through the injectable `StudioStore` (same reasoning as
 * `studio-store.test.ts` — no Tauri runtime in `bun test`). This also covers the v1→v2 migration
 * (flat `{ baseUrl, token }` → `{ gateway: { baseUrl, token } }`) since `loadStoredSettings` is
 * the file-backed path's only migration point (the on-disk file carries no version envelope —
 * see `settings.ts`'s `migrateSettingsShape`).
 *
 * The load path's contract is "degrade to undefined, never throw": it runs on boot, and anything
 * that throws there leaves a blank window instead of a settings prompt.
 */
import { describe, expect, test } from 'bun:test'
import { isSettingsConfigured, loadStoredSettings, storeSettings } from './settings'
import type { StudioStore } from './studio-store'

/** Only the two methods these functions touch; the rest of StudioStore is irrelevant here. */
function fakeStore(initial?: unknown): StudioStore & { written: unknown[] } {
  let stored = initial
  const written: unknown[] = []
  return {
    written,
    readSettings: async () => stored,
    writeSettings: async (value: unknown) => {
      written.push(value)
      stored = value
    },
  } as unknown as StudioStore & { written: unknown[] }
}

const GATEWAY = { baseUrl: 'https://image-gateway.example.com', token: 'secret-token' }
const VALID = { gateway: GATEWAY }

describe('loadStoredSettings', () => {
  test('returns a fully configured gateway-only pair', async () => {
    expect(await loadStoredSettings(fakeStore(VALID))).toEqual(VALID)
  })

  test('ignores a retired imageShare key left in an older file', async () => {
    expect(
      await loadStoredSettings(
        fakeStore({ gateway: GATEWAY, imageShare: { baseUrl: 'https://x', token: 't' } }),
      ),
    ).toEqual(VALID)
  })

  test('returns undefined when the file is absent', async () => {
    expect(await loadStoredSettings(fakeStore(undefined))).toBeUndefined()
  })

  test('returns undefined for a malformed file rather than throwing', async () => {
    expect(await loadStoredSettings(fakeStore({ gateway: { baseUrl: 42 } }))).toBeUndefined()
  })

  test('returns undefined when the gateway parses but is half-filled', async () => {
    // A file with a URL and no token must not count as configured — otherwise the app skips the
    // settings prompt and every request 401s with no explanation.
    expect(
      await loadStoredSettings(fakeStore({ gateway: { baseUrl: GATEWAY.baseUrl, token: '' } })),
    ).toBeUndefined()
    expect(
      await loadStoredSettings(fakeStore({ gateway: { baseUrl: '   ', token: GATEWAY.token } })),
    ).toBeUndefined()
  })

  test('a structurally invalid retired imageShare (missing token key) never fails the parse', async () => {
    // A hand-edited file like `{"gateway":{...},"imageShare":{"baseUrl":"x"}}` must not lose the
    // gateway connection just because of the retired key.
    expect(
      await loadStoredSettings(fakeStore({ gateway: GATEWAY, imageShare: { baseUrl: 'x' } })),
    ).toEqual(VALID)
  })

  test('a throwing read degrades to undefined instead of propagating', async () => {
    const throwing = {
      readSettings: async () => {
        throw new Error('forbidden path')
      },
    } as unknown as StudioStore
    expect(await loadStoredSettings(throwing)).toBeUndefined()
  })

  describe('v1 → v2 migration', () => {
    test('migrates a flat v1 { baseUrl, token } file into gateway.*', async () => {
      const v1File = { baseUrl: GATEWAY.baseUrl, token: GATEWAY.token }
      expect(await loadStoredSettings(fakeStore(v1File))).toEqual(VALID)
    })

    test('a half-filled v1 file still degrades to undefined after migrating', async () => {
      expect(
        await loadStoredSettings(fakeStore({ baseUrl: GATEWAY.baseUrl, token: '' })),
      ).toBeUndefined()
    })
  })
})

describe('storeSettings', () => {
  test('round-trips a gateway-only pair through the store', async () => {
    const store = fakeStore()
    await storeSettings(VALID, store)
    expect(store.written).toEqual([VALID])
    expect(await loadStoredSettings(store)).toEqual(VALID)
  })

  test('rejects a malformed pair rather than writing it', async () => {
    const store = fakeStore()
    await expect(
      storeSettings(
        { gateway: { baseUrl: 'https://x', token: 1 } } as unknown as typeof VALID,
        store,
      ),
    ).rejects.toThrow()
    expect(store.written).toEqual([])
  })
})

describe('isSettingsConfigured', () => {
  test('requires both fields to be non-blank', () => {
    expect(isSettingsConfigured(GATEWAY)).toBe(true)
    expect(isSettingsConfigured({ baseUrl: '', token: 't' })).toBe(false)
    expect(isSettingsConfigured({ baseUrl: 'https://x', token: '  ' })).toBe(false)
  })

  test('an absent connection is not configured', () => {
    expect(isSettingsConfigured(undefined)).toBe(false)
  })
})
