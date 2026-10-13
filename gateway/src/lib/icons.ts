import sharp from 'sharp'
import { optimize } from 'svgo'
import {
  CUTOUT_PRICE_USD,
  UPSCALE_MODEL,
  UPSCALE_PRICE_USD,
  VECTORIZE_MODEL,
  VECTORIZE_PRICE_USD,
  type CutoutModel,
  type IconStep,
  type IconsManifest,
  type IconsRequest,
} from '@image-gateway/shared'
import { prepareCutoutInput, InputError } from './cutout.js'
import { encodeIco, encodeIcns, ICNS_SIZES, ICNS_TYPES } from './icon-containers.js'

/**
 * The icon-set pipeline: master artwork in, every web + macOS + store icon out. Pure aside from
 * the injected Replicate `runners`, so it is testable without a network. Order: upscale -> cutout
 * -> clean/trim/master -> raster outputs -> vectorize. Upscaling comes first because recraft's
 * cutout and vectorize both reject inputs under 256 px.
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

/** `upscale: auto` runs when the long edge is under this; real-esrgan then makes it 4x (8x under 128). */
const UPSCALE_BELOW_EDGE = 512
const UPSCALE_X8_BELOW_EDGE = 128

/** real-esrgan's recommended maximum input (~1440p); `upscale: always` refuses anything larger. */
const UPSCALE_MAX_INPUT_EDGE = 1440

/** The master is rendered at this size (with favicon padding) as the vectorize input. */
const VECTORIZE_SIZE = 1024

/** A larger SVG is omitted: browsers prefer the SVG icon, so a bloated one is worse than none. */
export const SVG_MAX_BYTES = 64 * 1024

const FAVICON_SIZES = [16, 32, 48] as const

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 }

/**
 * The ICO keeps `sizes="32x32"`: without it Chrome prefers the ICO over the SVG icon. The SVG link
 * exists only when `favicon.svg` was actually emitted.
 */
export const iconsHtml = (withSvg: boolean): string =>
  [
    '<link rel="icon" href="/favicon.ico" sizes="32x32">',
    ...(withSvg ? ['<link rel="icon" href="/favicon.svg" type="image/svg+xml">'] : []),
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

/** The Replicate calls the pipeline makes, injected so it needs no network. */
export interface IconRunners {
  removeBackground: (model: CutoutModel, png: Buffer) => Promise<Buffer>
  upscale: (png: Buffer, scale: number) => Promise<Buffer>
  vectorize: (png: Buffer) => Promise<string>
}

/**
 * A runner failed. Carries which step and model (for telemetry), the steps that had already
 * succeeded (their spend is real), and how long the failing call ran.
 */
export class StepFailure extends Error {
  constructor(
    readonly failed: Pick<IconStep, 'step' | 'model' | 'latency_ms'>,
    readonly completed: IconStep[],
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'StepFailure'
  }
}

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

const encodePng = (rgba: Rgba): Promise<Buffer> =>
  sharp(rgba.data, { raw: { width: rgba.width, height: rgba.height, channels: 4 } })
    .png()
    .toBuffer()

/** The scale to upscale by, or null to skip. `always` is refused above real-esrgan's input limit. */
function upscaleScale(mode: IconsRequest['upscale'], { width, height }: Rgba): number | null {
  if (mode === 'never') return null
  const longEdge = Math.max(width, height)
  if (mode === 'auto' && longEdge >= UPSCALE_BELOW_EDGE) return null
  if (longEdge > UPSCALE_MAX_INPUT_EDGE) {
    throw new InputError(
      `image long edge is ${longEdge}px; upscaling accepts at most ${UPSCALE_MAX_INPUT_EDGE}px (use upscale: never)`,
    )
  }
  return longEdge < UPSCALE_X8_BELOW_EDGE ? 8 : 4
}

/** Run one Replicate step, timing it and recording it; a failure becomes a `StepFailure`. */
async function runStep<T>(
  steps: IconStep[],
  step: IconStep['step'],
  model: string,
  costUsd: number,
  run: () => Promise<T>,
): Promise<T> {
  const t0 = performance.now()
  try {
    const out = await run()
    steps.push({
      step,
      model,
      cost_usd: costUsd,
      latency_ms: Math.round(performance.now() - t0),
    })
    return out
  } catch (err) {
    throw new StepFailure(
      { step, model, latency_ms: Math.round(performance.now() - t0) },
      [...steps],
      err,
    )
  }
}

/**
 * recraft-vectorize emits a fixed `width`/`height`/`style` on the root and a no-op
 * `translate(0,0)` per path. Strip them (keep `viewBox`, so the icon scales), then let svgo shrink
 * the rest. Throws when the result has no viewBox - it would not scale as an icon.
 */
function cleanVectorized(svg: string): string {
  const stripped = svg
    .replace(/<svg\b[^>]*>/, (root) =>
      root.replace(/\s(?:width|height|style|preserveAspectRatio)=(?:"[^"]*"|'[^']*')/g, ''),
    )
    .replace(/\s+transform="translate\(0,\s*0\)"/g, '')
  const optimized = optimize(stripped, { multipass: true }).data
  if (!/<svg\b[^>]*\sviewBox=/.test(optimized)) throw new Error('vectorized SVG has no viewBox')
  return optimized
}

export async function generateIcons(
  input: Uint8Array,
  options: Pick<IconsRequest, 'background' | 'cutout' | 'cutout_model' | 'upscale' | 'svg'>,
  runners: IconRunners,
): Promise<{ files: IconAsset[]; steps: IconStep[]; svgSkippedReason: string | null }> {
  const steps: IconStep[] = []
  let bytes: Uint8Array = input
  let source = await decodeRgba(input)

  const scale = upscaleScale(options.upscale, source)
  if (scale) {
    const sent = await encodePng(source)
    bytes = await runStep(steps, 'upscale', UPSCALE_MODEL, UPSCALE_PRICE_USD, () =>
      runners.upscale(sent, scale),
    )
    source = await decodeRgba(bytes)
  }

  const cutOut =
    options.cutout === 'always' || (options.cutout === 'auto' && lacksTransparency(source.data))
  if (cutOut) {
    const cutoutInput = await prepareCutoutInput(bytes, { maxEdge: CUTOUT_INPUT_MAX_EDGE })
    const model = options.cutout_model
    source = await decodeRgba(
      await runStep(steps, 'cutout', model, CUTOUT_PRICE_USD[model], () =>
        runners.removeBackground(model, cutoutInput),
      ),
    )
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

  let faviconSvg: IconAsset | null = null
  let svgSkippedReason: string | null = null
  if (options.svg === 'auto') {
    const render = await renderIcon(master, VECTORIZE_SIZE, boxFor(VECTORIZE_SIZE, PADDING.favicon))
    const svg = Buffer.from(
      await runStep(steps, 'vectorize', VECTORIZE_MODEL, VECTORIZE_PRICE_USD, async () =>
        cleanVectorized(await runners.vectorize(render)),
      ),
    )
    if (svg.byteLength > SVG_MAX_BYTES) {
      svgSkippedReason = `vectorized SVG is ${Math.round(svg.byteLength / 1024)} KB - art with gradients/photo detail does not vectorize well; raster favicons only`
    } else {
      // 0x0: an SVG has no intrinsic pixel size (its viewBox is vectorize's own coordinate space).
      faviconSvg = { name: 'favicon.svg', mime: 'image/svg+xml', width: 0, height: 0, bytes: svg }
    }
  }

  const files: IconAsset[] = [
    {
      name: 'favicon.ico',
      mime: 'image/x-icon',
      width: 48,
      height: 48,
      bytes: encodeIco(icoFrames),
    },
    ...(faviconSvg ? [faviconSvg] : []),
    icon192,
    icon512,
    mask,
    apple,
    store,
    { name: 'AppIcon.icns', mime: 'image/icns', width: 1024, height: 1024, bytes: icns },
  ]
  return { files, steps, svgSkippedReason }
}
