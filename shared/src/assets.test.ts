import { describe, expect, test } from 'bun:test'
import {
  CUTOUT_MODELS,
  CUTOUT_PRICE_USD,
  DEFAULT_CUTOUT_MODEL,
  cutoutRequestSchema,
  iconsRequestSchema,
} from './assets'

describe('cutout contract', () => {
  test('the default model is a known model and every model has a price', () => {
    expect(CUTOUT_MODELS).toContain(DEFAULT_CUTOUT_MODEL)
    for (const model of CUTOUT_MODELS) expect(CUTOUT_PRICE_USD[model]).toBeGreaterThan(0)
    expect(CUTOUT_PRICE_USD[DEFAULT_CUTOUT_MODEL]).toBe(0.01)
  })

  test('model defaults to recraft and rejects unknown ids', () => {
    expect(cutoutRequestSchema.parse({}).model).toBe(DEFAULT_CUTOUT_MODEL)
    expect(cutoutRequestSchema.safeParse({ model: 'x/y' }).success).toBe(false)
  })
})

describe('icons contract', () => {
  test('defaults: white background, auto cutout, recraft, auto upscale, auto svg', () => {
    expect(iconsRequestSchema.parse({})).toEqual({
      background: '#ffffff',
      cutout: 'auto',
      cutout_model: DEFAULT_CUTOUT_MODEL,
      upscale: 'auto',
      svg: 'auto',
    })
  })

  test('upscale is auto | always | never, svg is auto | never', () => {
    expect(iconsRequestSchema.safeParse({ upscale: 'always' }).success).toBe(true)
    expect(iconsRequestSchema.safeParse({ upscale: 'sometimes' }).success).toBe(false)
    expect(iconsRequestSchema.safeParse({ svg: 'never' }).success).toBe(true)
    expect(iconsRequestSchema.safeParse({ svg: 'always' }).success).toBe(false)
  })

  test('background must be #rrggbb', () => {
    expect(iconsRequestSchema.safeParse({ background: '#12ab9F' }).success).toBe(true)
    for (const bad of ['white', '#fff', '12ab9f', '#12ab9fa'])
      expect(iconsRequestSchema.safeParse({ background: bad }).success).toBe(false)
  })

  test('cutout is auto | always | never', () => {
    expect(iconsRequestSchema.safeParse({ cutout: 'never' }).success).toBe(true)
    expect(iconsRequestSchema.safeParse({ cutout: 'maybe' }).success).toBe(false)
  })
})
