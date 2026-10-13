import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { InputError, prepareCutoutInput } from './cutout.js'

const solid = (width: number, height: number, format: 'png' | 'jpeg' | 'webp'): Promise<Buffer> => {
  const image = sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
  return image.toFormat(format).toBuffer()
}

describe('prepareCutoutInput', () => {
  test('passes a conforming PNG through byte-for-byte', async () => {
    const png = await solid(300, 300, 'png')
    expect((await prepareCutoutInput(png)).equals(png)).toBe(true)
  })

  test('converts jpeg and webp to PNG', async () => {
    for (const format of ['jpeg', 'webp'] as const) {
      const out = await prepareCutoutInput(await solid(300, 300, format))
      expect([format, (await sharp(out).metadata()).format]).toEqual([format, 'png'])
    }
  })

  test('downscales to maxEdge, keeping the aspect ratio', async () => {
    const out = await prepareCutoutInput(await solid(2000, 1000, 'png'), { maxEdge: 1000 })
    const meta = await sharp(out).metadata()
    expect([meta.width, meta.height]).toEqual([1000, 500])
  })

  test('rejects sides under 256, over 4096, and unreadable bytes with InputError', async () => {
    await expect(prepareCutoutInput(await solid(255, 400, 'png'))).rejects.toThrow(InputError)
    await expect(prepareCutoutInput(await solid(4097, 300, 'png'))).rejects.toThrow(InputError)
    await expect(prepareCutoutInput(new Uint8Array([1, 2, 3]))).rejects.toThrow(InputError)
  })

  test('rejects images above 16 megapixels', async () => {
    await expect(prepareCutoutInput(await solid(4096, 4000, 'png'))).rejects.toThrow(
      /16000000 pixels/,
    )
  })
})
