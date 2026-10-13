import sharp from 'sharp'
import type { CutoutModel, IconsManifest, IconsRequest } from '@image-gateway/shared'
import { prepareCutoutInput, InputError } from './cutout.js'
import { encodeIco, encodeIcns, ICNS_SIZES, ICNS_TYPES } from './icon-containers.js'

/**
 * The icon-set pipeline: master artwork in, every web + macOS + store icon out. Pure aside from
 * the injected `runCutout`, so it is testable without a network.
 *
 * Padding is the empty margin on each side as a fraction of the canvas, tuned per target: tight
 * for browser chrome, looser where the OS crops or frames the icon. All of it lives here.
 */
export const PADDING = {
  favicon: 0.04,
  pwa: 0.06,
  appleTouch: 0.12,
  appStore: 0.1,
  icns: 0.1,
} as const

/** The maskable safe zone: a centered 409px box (80%) inside the 512px icon-mask canvas. */
export const MASKABLE_BOX = 409

/** Cutout input is downscaled to this long edge first — the icons never need more resolution. */
const CUTOUT_INPUT_MAX_EDGE = 1536

/** Below this alpha a pixel is treated as fully transparent (recraft's "transparent" is alpha=1). */
const ALPHA_FLOOR = 8

/** `auto` treats an image as already cut out when ANY pixel is below this alpha. */
const OPAQUE_ALPHA = 250

const FAVICON_SIZES = [16, 32, 48] as const

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 }

// No SVG icon link: we have no vector source, and a raster wrapped in <svg> is not an SVG icon.
export const ICONS_HTML = [
  '<link rel="icon" href="/favicon.ico" sizes="32x32">',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
  '<link rel="manifest" href="/manifest.webmanifest">',
].join('\n')

export const ICONS_MANIFEST: IconsManifest = {
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icon-mask.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}

export interface IconAsset {
  name: string
  mime: string
  width: number
  height: number
  bytes: Buffer
}

export type CutoutRunner = (model: CutoutModel, png: Buffer) => Promise<Buffer>

interface Rgba {
  data: Buffer
  width: number
  height: number
}

async function decodeRgba(bytes: Uint8Array): Promise<Rgba> {
  try {
    const { data, info } = await sharp(bytes)
      .rotate()
      .toColourspace('srgb')
      .ensureAlpha()
      .raw({ depth: 'uchar' })
      .toBuffer({ resolveWithObject: true })
    if (info.channels !== 4) throw new Error(`expected 4 channels, got ${info.channels}`)
    return { data, width: info.width, height: info.height }
  } catch (err) {
    throw new InputError(`unreadable image: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** True when the image carries no real transparency (no alpha channel, or all alpha >= 250). */
export function lacksTransparency(rgba: Buffer): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if ((rgba[i] ?? 255) < OPAQUE_ALPHA) return false
  }
  return true
}

/**
 * Zero near-transparent pixels in place (and their colour, so resampling can't bleed it), and
 * return the bounding box of what is left, or null when nothing is visible.
 */
function cleanAlphaAndBounds(
  rgba: Rgba,
): { left: number; top: number; width: number; height: number } | null {
  const { data, width, height } = rgba
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if ((data[i + 3] ?? 0) < ALPHA_FLOOR) {
        data[i] = 0
        data[i + 1] = 0
        data[i + 2] = 0
        data[i + 3] = 0
        continue
      }
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/** The trimmed subject centered on a square transparent canvas. */
async function buildMaster(rgba: Rgba): Promise<Buffer> {
  const bounds = cleanAlphaAndBounds(rgba)
  if (!bounds) throw new InputError('image has no visible content')

  const trimmed = await sharp(rgba.data, {
    raw: { width: rgba.width, height: rgba.height, channels: 4 },
  })
    .extract(bounds)
    .png()
    .toBuffer()

  const side = Math.max(bounds.width, bounds.height)
  const left = Math.floor((side - bounds.width) / 2)
  const top = Math.floor((side - bounds.height) / 2)
  return sharp(trimmed)
    .extend({
      top,
      bottom: side - bounds.height - top,
      left,
      right: side - bounds.width - left,
      background: TRANSPARENT,
    })
    .png()
    .toBuffer()
}

/**
 * Render the square master into a `size` canvas with the subject fit inside a centered
 * `box`x`box` square. With a `background` the result is flattened and fully opaque; without one
 * the margin stays transparent.
 */
async function renderIcon(
  master: Buffer,
  size: number,
  box: number,
  background?: string,
): Promise<Buffer> {
  const offset = Math.floor((size - box) / 2)
  const rest = size - box - offset
  let pipeline = sharp(master).resize(box, box)
  if (background) pipeline = pipeline.flatten({ background })
  return pipeline
    .extend({
      top: offset,
      bottom: rest,
      left: offset,
      right: rest,
      background: background ?? TRANSPARENT,
    })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

const boxFor = (size: number, padding: number): number => Math.round(size * (1 - 2 * padding))

async function pngAsset(
  name: string,
  master: Buffer,
  size: number,
  box: number,
  background?: string,
): Promise<IconAsset> {
  return {
    name,
    mime: 'image/png',
    width: size,
    height: size,
    bytes: await renderIcon(master, size, box, background),
  }
}

export async function generateIcons(
  input: Uint8Array,
  options: Pick<IconsRequest, 'background' | 'cutout' | 'cutout_model'>,
  runCutout: CutoutRunner,
): Promise<{ files: IconAsset[]; cutoutModel: CutoutModel | null }> {
  let source = await decodeRgba(input)
  const cutOut =
    options.cutout === 'always' || (options.cutout === 'auto' && lacksTransparency(source.data))
  if (cutOut) {
    const cutoutInput = await prepareCutoutInput(input, { maxEdge: CUTOUT_INPUT_MAX_EDGE })
    source = await decodeRgba(await runCutout(options.cutout_model, cutoutInput))
  }

  const master = await buildMaster(source)
  const bg = options.background

  const [icoFrames, icnsPngs, icon192, icon512, mask, apple, store] = await Promise.all([
    Promise.all(
      FAVICON_SIZES.map(async (size) => ({
        size,
        png: await renderIcon(master, size, boxFor(size, PADDING.favicon)),
      })),
    ),
    Promise.all(
      ICNS_SIZES.map(
        async (size) => [size, await renderIcon(master, size, boxFor(size, PADDING.icns))] as const,
      ),
    ),
    pngAsset('icon-192.png', master, 192, boxFor(192, PADDING.pwa)),
    pngAsset('icon-512.png', master, 512, boxFor(512, PADDING.pwa)),
    pngAsset('icon-mask.png', master, 512, MASKABLE_BOX, bg),
    pngAsset('apple-touch-icon.png', master, 180, boxFor(180, PADDING.appleTouch), bg),
    pngAsset('icon-1024.png', master, 1024, boxFor(1024, PADDING.appStore), bg),
  ])

  const icnsBySize = new Map(icnsPngs)
  const icns = encodeIcns(
    ICNS_TYPES.map(({ type, size }) => ({ type, png: icnsBySize.get(size) as Buffer })),
  )

  const files: IconAsset[] = [
    {
      name: 'favicon.ico',
      mime: 'image/x-icon',
      width: 48,
      height: 48,
      bytes: encodeIco(icoFrames),
    },
    icon192,
    icon512,
    mask,
    apple,
    store,
    { name: 'AppIcon.icns', mime: 'image/icns', width: 1024, height: 1024, bytes: icns },
  ]
  return { files, cutoutModel: cutOut ? options.cutout_model : null }
}
