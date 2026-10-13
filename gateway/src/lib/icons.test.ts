import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { InputError } from './cutout.js'
import {
  generateIcons,
  iconsHtml,
  ICONS_MANIFEST,
  lacksTransparency,
  MASKABLE_BOX,
  StepFailure,
  SVG_MAX_BYTES,
  type IconRunners,
} from './icons.js'

const SIZE = 600
const BASE = {
  background: '#ffffff',
  cutout: 'auto',
  cutout_model: 'recraft-ai/recraft-remove-background',
  // The legacy cases below exercise the cutout alone; upscale and svg have their own describe.
  upscale: 'never',
  svg: 'never',
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

const SVG_ROOT =
  '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" style="display: block;" viewBox="0 0 2048 2048" width="1254" height="1254" preserveAspectRatio="none">'
const leafSvg = (): Promise<string> =>
  Promise.resolve(
    `${SVG_ROOT}<path transform="translate(0,0)" fill="rgb(220,30,30)" d="M 100 100 L 1900 100 L 1900 1900 Z"/></svg>`,
  )

/** Incompressible path data: svgo cannot shrink it, so the document stays above the size cap. */
function bloatedSvg(): Promise<string> {
  let seed = 7
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % 2000
  }
  const paths = Array.from({ length: 400 }, () => {
    const d = Array.from({ length: 30 }, () => `L ${next()} ${next()}`).join(' ')
    return `<path transform="translate(0,0)" fill="rgb(${next() % 256},${next() % 256},9)" d="M 0 0 ${d} Z"/>`
  })
  return Promise.resolve(`${SVG_ROOT}${paths.join('')}</svg>`)
}

/** Fake Replicate runners; `calls` logs each one in order (`upscale:<scale>`, model id, `vectorize`). */
function recorder(
  result: () => Promise<Buffer>,
  svg: () => Promise<string> = leafSvg,
): { runners: IconRunners; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    runners: {
      removeBackground: async (model) => {
        calls.push(model)
        return result()
      },
      upscale: async (png, scale) => {
        calls.push(`upscale:${scale}`)
        const { width = 1 } = await sharp(png).metadata()
        return sharp(png)
          .resize(width * scale)
          .png()
          .toBuffer()
      },
      vectorize: async () => {
        calls.push('vectorize')
        return svg()
      },
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
    const { files, steps } = await generateIcons(await opaqueWhiteDisc(), BASE, cutout.runners)

    expect(cutout.calls).toEqual([BASE.cutout_model])
    expect(steps.map((s) => [s.step, s.model, s.cost_usd])).toEqual([
      ['cutout', BASE.cutout_model, 0.01],
    ])
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
    const { files } = await generateIcons(
      await opaqueWhiteDisc(),
      BASE,
      recorder(quirkyCutout).runners,
    )
    for (const name of ['icon-192.png', 'icon-512.png']) {
      const { data, width } = await rgba(files.find((f) => f.name === name)!.bytes)
      expect([name, data[3]]).toEqual([name, 0])
      expect([name, data[(width * (width / 2) + width / 2) * 4 + 3]]).toEqual([name, 255])
    }
  })

  test('opaque targets have no transparent pixels', async () => {
    const { files } = await generateIcons(
      await opaqueWhiteDisc(),
      BASE,
      recorder(quirkyCutout).runners,
    )
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
      recorder(quirkyCutout).runners,
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
    const { files, steps } = await generateIcons(await transparentDisc(), BASE, cutout.runners)
    expect(cutout.calls).toEqual([])
    expect(steps).toEqual([])
    expect(files).toHaveLength(7)
  })

  test('always forces the cutout, never skips it', async () => {
    const forced = recorder(quirkyCutout)
    await generateIcons(await transparentDisc(), { ...BASE, cutout: 'always' }, forced.runners)
    expect(forced.calls).toHaveLength(1)

    const skipped = recorder(quirkyCutout)
    const { steps } = await generateIcons(
      await opaqueWhiteDisc(),
      { ...BASE, cutout: 'never' },
      skipped.runners,
    )
    expect(skipped.calls).toEqual([])
    expect(steps).toEqual([])
  })

  test('the chosen cutout model is passed through', async () => {
    const cutout = recorder(quirkyCutout)
    const { steps } = await generateIcons(
      await opaqueWhiteDisc(),
      { ...BASE, cutout_model: 'bria/remove-background' },
      cutout.runners,
    )
    expect(cutout.calls).toEqual(['bria/remove-background'])
    expect(steps.map((s) => [s.model, s.cost_usd])).toEqual([['bria/remove-background', 0.018]])
  })

  test('rejects garbage bytes and fully transparent images with InputError', async () => {
    const none = recorder(quirkyCutout).runners
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
      recorder(quirkyCutout).runners,
    )
    expect(files).toHaveLength(7)
  })

  test('a non-square subject is centered on a square master', async () => {
    // 600x200 red bar on transparent: trimmed to 600x200, padded to a 600 square.
    const data = Buffer.alloc(SIZE * SIZE * 4)
    for (let y = 200; y < 400; y++)
      for (let x = 0; x < SIZE; x++) data.set([220, 30, 30, 255], (y * SIZE + x) * 4)
    const { files } = await generateIcons(await toPng(data), BASE, recorder(quirkyCutout).runners)
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

/** An opaque white square with a red disc, `size` px on a side. */
async function smallDisc(size: number): Promise<Buffer> {
  const r = size / 3
  const data = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = (x - size / 2) ** 2 + (y - size / 2) ** 2 <= r ** 2
      data.set(inside ? [220, 30, 30, 255] : [255, 255, 255, 255], (y * size + x) * 4)
    }
  }
  return sharp(data, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer()
}

describe('upscale step', () => {
  test('auto upscales a tiny input 8x BEFORE the cutout and records both steps', async () => {
    const fakes = recorder(quirkyCutout)
    const { steps } = await generateIcons(
      await smallDisc(100),
      { ...BASE, upscale: 'auto' },
      fakes.runners,
    )
    expect(fakes.calls).toEqual(['upscale:8', BASE.cutout_model])
    expect(steps.map((s) => [s.step, s.model, s.cost_usd])).toEqual([
      ['upscale', 'nightmareai/real-esrgan', 0.002],
      ['cutout', BASE.cutout_model, 0.01],
    ])
  })

  test('auto upscales 4x from 128 px up to just below 512 px', async () => {
    const fakes = recorder(quirkyCutout)
    await generateIcons(await smallDisc(300), { ...BASE, upscale: 'auto' }, fakes.runners)
    expect(fakes.calls).toEqual(['upscale:4', BASE.cutout_model])
  })

  test('auto leaves a >= 512 px input alone', async () => {
    const fakes = recorder(quirkyCutout)
    await generateIcons(await opaqueWhiteDisc(), { ...BASE, upscale: 'auto' }, fakes.runners)
    expect(fakes.calls).toEqual([BASE.cutout_model])
  })

  test('always upscales even a large-enough input; never lets a tiny one hit the cutout minimum', async () => {
    const forced = recorder(quirkyCutout)
    await generateIcons(await opaqueWhiteDisc(), { ...BASE, upscale: 'always' }, forced.runners)
    expect(forced.calls).toEqual(['upscale:4', BASE.cutout_model])

    // Without the upscale a 100 px master hits the cutout's 256 px minimum - the reason it runs first.
    const skipped = recorder(quirkyCutout)
    await expect(
      generateIcons(await smallDisc(100), { ...BASE, upscale: 'never' }, skipped.runners),
    ).rejects.toThrow(InputError)
    expect(skipped.calls).toEqual([])
  })

  test("always refuses an input beyond real-esrgan's recommended size with InputError", async () => {
    const huge = await sharp({
      create: { width: 1500, height: 1500, channels: 4, background: '#ffffff' },
    })
      .png()
      .toBuffer()
    await expect(
      generateIcons(huge, { ...BASE, upscale: 'always' }, recorder(quirkyCutout).runners),
    ).rejects.toThrow(InputError)
  })

  test('a failing runner becomes a StepFailure naming the step and the steps already done', async () => {
    const fakes = recorder(quirkyCutout)
    const runners: IconRunners = {
      ...fakes.runners,
      removeBackground: async () => {
        throw new Error('boom')
      },
    }
    const err = await generateIcons(
      await smallDisc(100),
      { ...BASE, upscale: 'auto' },
      runners,
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StepFailure)
    const failure = err as StepFailure
    expect(failure.message).toBe('boom')
    expect(failure.failed.step).toBe('cutout')
    expect(failure.failed.model).toBe(BASE.cutout_model)
    expect(failure.completed.map((s) => s.step)).toEqual(['upscale'])
  })
})

const noViewBox = (): Promise<string> =>
  Promise.resolve('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')

describe('svg step', () => {
  const WITH_SVG = { ...BASE, cutout: 'never', svg: 'auto' } as const

  test('auto vectorizes the master and emits a cleaned favicon.svg after the ico', async () => {
    const fakes = recorder(quirkyCutout)
    const { files, steps, svgSkippedReason } = await generateIcons(
      await transparentDisc(),
      WITH_SVG,
      fakes.runners,
    )
    expect(fakes.calls).toEqual(['vectorize'])
    expect(svgSkippedReason).toBeNull()
    expect(steps.map((s) => [s.step, s.model, s.cost_usd])).toEqual([
      ['vectorize', 'recraft-ai/recraft-vectorize', 0.01],
    ])
    expect(files.map((f) => f.name).slice(0, 2)).toEqual(['favicon.ico', 'favicon.svg'])

    const file = files.find((f) => f.name === 'favicon.svg')!
    expect([file.mime, file.width, file.height]).toEqual(['image/svg+xml', 0, 0])
    const svg = file.bytes.toString()
    const root = svg.match(/<svg\b[^>]*>/)?.[0] ?? ''
    expect(root).toContain('viewBox="0 0 2048 2048"')
    for (const attr of ['width=', 'height=', 'style=', 'preserveAspectRatio=']) {
      expect([attr, root.includes(attr)]).toEqual([attr, false])
    }
    expect(svg).not.toContain('translate(0')
    expect(svg).toContain('<path')
  })

  test('the vectorize input is the master on a 1024 canvas with transparent favicon padding', async () => {
    let sent: Buffer | undefined
    const fakes = recorder(quirkyCutout)
    await generateIcons(await transparentDisc(), WITH_SVG, {
      ...fakes.runners,
      vectorize: async (png) => {
        sent = png
        return leafSvg()
      },
    })
    const { data, width, height } = await rgba(sent!)
    expect([width, height]).toEqual([1024, 1024])
    expect(data[3]).toBe(0)
  })

  test('an oversized SVG is omitted with a reason and no link tag', async () => {
    const { files, steps, svgSkippedReason } = await generateIcons(
      await transparentDisc(),
      WITH_SVG,
      recorder(quirkyCutout, bloatedSvg).runners,
    )
    expect(files.map((f) => f.name)).not.toContain('favicon.svg')
    expect(svgSkippedReason).toMatch(/^vectorized SVG is \d+ KB - .*raster favicons only$/)
    // The vectorize call still ran and was billed.
    expect(steps.map((s) => s.step)).toEqual(['vectorize'])
    expect(SVG_MAX_BYTES).toBe(64 * 1024)
  })

  test('never makes no vectorize call', async () => {
    const fakes = recorder(quirkyCutout)
    const { files, steps, svgSkippedReason } = await generateIcons(
      await transparentDisc(),
      { ...WITH_SVG, svg: 'never' },
      fakes.runners,
    )
    expect(fakes.calls).toEqual([])
    expect(steps).toEqual([])
    expect(svgSkippedReason).toBeNull()
    expect(files.map((f) => f.name)).not.toContain('favicon.svg')
  })

  test('an SVG without a viewBox fails the vectorize step', async () => {
    const err = await generateIcons(
      await transparentDisc(),
      WITH_SVG,
      recorder(quirkyCutout, noViewBox).runners,
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StepFailure)
    expect((err as StepFailure).failed.step).toBe('vectorize')
  })
})

describe('web snippets', () => {
  test('html links the web targets, the SVG only when it exists, and the manifest lists all three icons', () => {
    const without = iconsHtml(false)
    expect(without).toContain('href="/favicon.ico"')
    expect(without).toContain('href="/apple-touch-icon.png"')
    expect(without).toContain('href="/manifest.webmanifest"')
    expect(without).not.toContain('favicon.svg')

    const lines = iconsHtml(true).split('\n')
    expect(lines[0]).toBe('<link rel="icon" href="/favicon.ico" sizes="32x32">')
    expect(lines[1]).toBe('<link rel="icon" href="/favicon.svg" type="image/svg+xml">')

    expect(ICONS_MANIFEST.icons.map((i) => i.src)).toEqual([
      '/icon-192.png',
      '/icon-512.png',
      '/icon-mask.png',
    ])
    expect(ICONS_MANIFEST.icons[2]?.purpose).toBe('maskable')
  })
})
