import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { InputError } from './cutout.js'
import {
  generateIcons,
  ICONS_HTML,
  ICONS_MANIFEST,
  lacksTransparency,
  MASKABLE_BOX,
  type CutoutRunner,
} from './icons.js'

const SIZE = 600
const BASE = {
  background: '#ffffff',
  cutout: 'auto',
  cutout_model: 'recraft-ai/recraft-remove-background',
} as const

/** A red disc (radius 200) centred in a SIZE square; background alpha is configurable. */
function discRaw(opts: { background: [number, number, number, number] }): Buffer {
  const data = Buffer.alloc(SIZE * SIZE * 4)
  const c = SIZE / 2
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const inside = (x - c) ** 2 + (y - c) ** 2 <= 200 ** 2
      const px = inside ? [220, 30, 30, 255] : opts.background
      data.set(px, (y * SIZE + x) * 4)
    }
  }
  return data
}

const toPng = (data: Buffer, channels: 3 | 4 = 4): Promise<Buffer> =>
  sharp(data, { raw: { width: SIZE, height: SIZE, channels } })
    .png()
    .toBuffer()

const opaqueWhiteDisc = (): Promise<Buffer> => toPng(discRaw({ background: [255, 255, 255, 255] }))
const transparentDisc = (): Promise<Buffer> => toPng(discRaw({ background: [0, 0, 0, 0] }))
// recraft quirk: the "transparent" background comes back alpha=1, not 0.
const quirkyCutout = (): Promise<Buffer> => toPng(discRaw({ background: [255, 255, 255, 1] }))

function recorder(result: () => Promise<Buffer>): { run: CutoutRunner; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    run: async (model) => {
      calls.push(model)
      return result()
    },
  }
}

async function rgba(png: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

const EXPECTED: Record<string, [number, number]> = {
  'favicon.ico': [48, 48],
  'icon-192.png': [192, 192],
  'icon-512.png': [512, 512],
  'icon-mask.png': [512, 512],
  'apple-touch-icon.png': [180, 180],
  'icon-1024.png': [1024, 1024],
  'AppIcon.icns': [1024, 1024],
}

describe('generateIcons', () => {
  test('auto runs the cutout on an opaque image and emits every file at its size', async () => {
    const cutout = recorder(quirkyCutout)
    const { files, cutoutModel } = await generateIcons(await opaqueWhiteDisc(), BASE, cutout.run)

    expect(cutout.calls).toEqual([BASE.cutout_model])
    expect(cutoutModel).toBe(BASE.cutout_model)
    expect(files.map((f) => f.name)).toEqual(Object.keys(EXPECTED))

    for (const file of files) {
      expect([file.name, file.width, file.height]).toEqual([file.name, ...EXPECTED[file.name]!])
      if (file.name.endsWith('.png')) {
        const meta = await sharp(file.bytes).metadata()
        expect([file.name, meta.width, meta.height]).toEqual([file.name, file.width, file.height])
      }
    }
    expect(files.find((f) => f.name === 'favicon.ico')?.bytes.readUInt16LE(4)).toBe(3)
    expect(
      files
        .find((f) => f.name === 'AppIcon.icns')
        ?.bytes.subarray(0, 4)
        .toString(),
    ).toBe('icns')
  })

  test('transparent targets keep alpha: corners are fully transparent (recraft alpha=1 cleaned)', async () => {
    const { files } = await generateIcons(await opaqueWhiteDisc(), BASE, recorder(quirkyCutout).run)
    for (const name of ['icon-192.png', 'icon-512.png']) {
      const { data, width } = await rgba(files.find((f) => f.name === name)!.bytes)
      expect([name, data[3]]).toEqual([name, 0])
      expect([name, data[(width * (width / 2) + width / 2) * 4 + 3]]).toEqual([name, 255])
    }
  })

  test('opaque targets have no transparent pixels', async () => {
    const { files } = await generateIcons(await opaqueWhiteDisc(), BASE, recorder(quirkyCutout).run)
    for (const name of ['icon-mask.png', 'apple-touch-icon.png', 'icon-1024.png']) {
      const { data } = await rgba(files.find((f) => f.name === name)!.bytes)
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] !== 255) throw new Error(`${name}: pixel ${(i - 3) / 4} has alpha ${data[i]}`)
      }
    }
  })

  test('the maskable subject stays inside the centered 409px box', async () => {
    const { files } = await generateIcons(
      await opaqueWhiteDisc(),
      { ...BASE, background: '#0000ff' },
      recorder(quirkyCutout).run,
    )
    const { data, width, height } = await rgba(files.find((f) => f.name === 'icon-mask.png')!.bytes)
    let minX = width
    let maxX = -1
    let minY = height
    let maxY = -1
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        const isBackground = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 255
        if (isBackground) continue
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
    }
    const margin = Math.floor((512 - MASKABLE_BOX) / 2)
    expect(minX).toBeGreaterThanOrEqual(margin)
    expect(minY).toBeGreaterThanOrEqual(margin)
    expect(maxX).toBeLessThan(margin + MASKABLE_BOX)
    expect(maxY).toBeLessThan(margin + MASKABLE_BOX)
    // ...and it actually fills the box rather than shrinking away.
    expect(maxX - minX + 1).toBeGreaterThan(MASKABLE_BOX - 8)
  })

  test('auto skips the cutout when the image already has real transparency', async () => {
    const cutout = recorder(quirkyCutout)
    const { files, cutoutModel } = await generateIcons(await transparentDisc(), BASE, cutout.run)
    expect(cutout.calls).toEqual([])
    expect(cutoutModel).toBeNull()
    expect(files).toHaveLength(7)
  })

  test('always forces the cutout, never skips it', async () => {
    const forced = recorder(quirkyCutout)
    await generateIcons(await transparentDisc(), { ...BASE, cutout: 'always' }, forced.run)
    expect(forced.calls).toHaveLength(1)

    const skipped = recorder(quirkyCutout)
    const { cutoutModel } = await generateIcons(
      await opaqueWhiteDisc(),
      { ...BASE, cutout: 'never' },
      skipped.run,
    )
    expect(skipped.calls).toEqual([])
    expect(cutoutModel).toBeNull()
  })

  test('the chosen cutout model is passed through', async () => {
    const cutout = recorder(quirkyCutout)
    const { cutoutModel } = await generateIcons(
      await opaqueWhiteDisc(),
      { ...BASE, cutout_model: 'bria/remove-background' },
      cutout.run,
    )
    expect(cutout.calls).toEqual(['bria/remove-background'])
    expect(cutoutModel).toBe('bria/remove-background')
  })

  test('rejects garbage bytes and fully transparent images with InputError', async () => {
    const none = recorder(quirkyCutout).run
    await expect(generateIcons(new Uint8Array([1, 2, 3]), BASE, none)).rejects.toThrow(InputError)
    const blank = await toPng(Buffer.alloc(SIZE * SIZE * 4))
    await expect(generateIcons(blank, BASE, none)).rejects.toThrow(InputError)
  })

  test('a grayscale image decodes (no 2-channel surprise)', async () => {
    const gray = await sharp(Buffer.alloc(SIZE * SIZE, 128), {
      raw: { width: SIZE, height: SIZE, channels: 1 },
    })
      .png()
      .toBuffer()
    const { files } = await generateIcons(
      gray,
      { ...BASE, cutout: 'never' },
      recorder(quirkyCutout).run,
    )
    expect(files).toHaveLength(7)
  })

  test('a non-square subject is centered on a square master', async () => {
    // 600x200 red bar on transparent: trimmed to 600x200, padded to a 600 square.
    const data = Buffer.alloc(SIZE * SIZE * 4)
    for (let y = 200; y < 400; y++)
      for (let x = 0; x < SIZE; x++) data.set([220, 30, 30, 255], (y * SIZE + x) * 4)
    const { files } = await generateIcons(await toPng(data), BASE, recorder(quirkyCutout).run)
    const { data: out, width } = await rgba(files.find((f) => f.name === 'icon-512.png')!.bytes)
    const column = width / 2
    const alphaAt = (y: number): number => out[(y * width + column) * 4 + 3] ?? -1
    expect(alphaAt(256)).toBe(255)
    expect(alphaAt(20)).toBe(0)
    expect(alphaAt(492)).toBe(0)
  })
})

describe('lacksTransparency', () => {
  test('is true only when every pixel alpha is >= 250', () => {
    expect(lacksTransparency(Buffer.from([1, 2, 3, 255, 4, 5, 6, 250]))).toBe(true)
    expect(lacksTransparency(Buffer.from([1, 2, 3, 255, 4, 5, 6, 249]))).toBe(false)
  })
})

describe('web snippets', () => {
  test('html links the three web targets and the manifest lists all three icons', () => {
    expect(ICONS_HTML).toContain('href="/favicon.ico"')
    expect(ICONS_HTML).toContain('href="/apple-touch-icon.png"')
    expect(ICONS_HTML).toContain('href="/manifest.webmanifest"')
    expect(ICONS_MANIFEST.icons.map((i) => i.src)).toEqual([
      '/icon-192.png',
      '/icon-512.png',
      '/icon-mask.png',
    ])
    expect(ICONS_MANIFEST.icons[2]?.purpose).toBe('maskable')
  })
})
