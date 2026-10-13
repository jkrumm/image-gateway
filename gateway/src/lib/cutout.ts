import sharp from 'sharp'
import { CUTOUT_LIMITS } from '@image-gateway/shared'

const isPng = (bytes: Uint8Array): boolean =>
  bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47

/** A caller-fixable problem with the supplied image — routes map it to a 400. */
export class InputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputError'
  }
}

/**
 * Normalise an uploaded image into the PNG the cutout models are sent, enforcing recraft's
 * documented limits (<=5 MB, <=16 MP, sides 256-4096 px) so a violation is a clear 400 instead of
 * an opaque upstream failure. A PNG that already fits is passed through byte-for-byte; anything
 * else (or anything above `maxEdge`) is re-encoded, with EXIF orientation applied.
 */
export async function prepareCutoutInput(
  bytes: Uint8Array,
  options: { maxEdge?: number } = {},
): Promise<Buffer> {
  try {
    const meta = await sharp(bytes).metadata()
    if (!meta.width || !meta.height) throw new InputError('unreadable image')
    const swapped = (meta.orientation ?? 1) >= 5
    const width = swapped ? meta.height : meta.width
    const height = swapped ? meta.width : meta.height

    const longEdge = Math.max(width, height)
    const scale = options.maxEdge && longEdge > options.maxEdge ? options.maxEdge / longEdge : 1
    const outWidth = Math.round(width * scale)
    const outHeight = Math.round(height * scale)

    if (Math.min(outWidth, outHeight) < CUTOUT_LIMITS.minEdge) {
      throw new InputError(`image sides must be at least ${CUTOUT_LIMITS.minEdge}px for cutout`)
    }
    if (Math.max(outWidth, outHeight) > CUTOUT_LIMITS.maxEdge) {
      throw new InputError(`image sides must be at most ${CUTOUT_LIMITS.maxEdge}px for cutout`)
    }
    if (outWidth * outHeight > CUTOUT_LIMITS.maxPixels) {
      throw new InputError(`image must be at most ${CUTOUT_LIMITS.maxPixels} pixels for cutout`)
    }

    const passthrough = scale === 1 && swapped === false && isPng(bytes)
    const png = passthrough
      ? Buffer.from(bytes)
      : await sharp(bytes)
          .rotate()
          .resize(outWidth, outHeight)
          .png({ compressionLevel: 9 })
          .toBuffer()
    if (png.byteLength > CUTOUT_LIMITS.maxImageBytes) {
      throw new InputError(`image must be at most ${CUTOUT_LIMITS.maxImageBytes} bytes for cutout`)
    }
    return png
  } catch (err) {
    if (err instanceof InputError) throw err
    throw new InputError(`unreadable image: ${err instanceof Error ? err.message : String(err)}`)
  }
}
