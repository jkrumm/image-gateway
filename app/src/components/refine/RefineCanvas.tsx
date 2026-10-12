/** The Refine workbench's canvas stage: draws whichever `RgbaImage` the current preview mode
 * resolves to, and either turns clicks into seed points ('picks' background mode) or turns drags
 * into transform pan ('picks' mode off) — the two are mutually exclusive by construction so they
 * never fight over the same gesture, see `Refine.tsx`'s `panInteractive`. Coordinate mapping goes
 * through `pointToPixel` (the pure helper extracted from `Edit.tsx`'s `MaskCanvas.pointFromEvent`),
 * so this component owns no pointer math of its own. */
import { Box, Center, Text } from '@mantine/core'
import { VX } from 'basalt-ui/tokens'
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { pointToPixel, toImageData } from '../../lib/imaging/dom'
import type { Transform } from '../../lib/imaging/transform'
import type { RgbaImage } from '../../lib/imaging/types'

export type PreviewMode = 'checkerboard' | 'matte' | 'mask' | 'original'

export type SeedPoint = { x: number; y: number }

type RefineCanvasProps = {
  displayImage: RgbaImage | null
  mode: PreviewMode
  matteColor: string
  interactive: boolean
  seeds: readonly SeedPoint[]
  onAddSeed: (point: SeedPoint) => void
  onRemoveSeedNear: (point: SeedPoint) => void
  /** Whether drag-to-pan is currently armed (mutually exclusive with `interactive` seed-picking). */
  panInteractive: boolean
  transform: Transform
  onTransformChange: (patch: Partial<Transform>) => void
}

function clampOffset(v: number): number {
  return Math.min(Math.max(v, -1), 1)
}

export function RefineCanvas({
  displayImage,
  mode,
  matteColor,
  interactive,
  seeds,
  onAddSeed,
  onRemoveSeedNear,
  panInteractive,
  transform,
  onTransformChange,
}: RefineCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const panStartRef = useRef<{
    clientX: number
    clientY: number
    offsetX: number
    offsetY: number
  } | null>(null)
  const [isPanning, setIsPanning] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !displayImage) return
    canvas.width = displayImage.width
    canvas.height = displayImage.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.putImageData(toImageData(displayImage), 0, 0)
  }, [displayImage])

  function handleClick(event: ReactMouseEvent<HTMLCanvasElement>): void {
    if (!interactive || !displayImage) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const pixel = pointToPixel(rect, canvas, { x: event.clientX, y: event.clientY })
    const point: SeedPoint = {
      x: Math.min(Math.max(pixel.x / displayImage.width, 0), 1),
      y: Math.min(Math.max(pixel.y / displayImage.height, 0), 1),
    }
    if (event.altKey) onRemoveSeedNear(point)
    else onAddSeed(point)
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>): void {
    if (!panInteractive || !displayImage) return
    event.currentTarget.setPointerCapture(event.pointerId)
    panStartRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: transform.offsetX,
      offsetY: transform.offsetY,
    }
    setIsPanning(true)
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const start = panStartRef.current
    const canvas = canvasRef.current
    if (!start || !canvas || !displayImage) return
    const rect = canvas.getBoundingClientRect()
    // Reuse `pointToPixel` for both ends of the drag rather than hand-rolling a CSS-to-backing-
    // store scale factor again — `Edit.tsx`'s inline version is the cautionary tale.
    const from = pointToPixel(rect, canvas, { x: start.clientX, y: start.clientY })
    const to = pointToPixel(rect, canvas, { x: event.clientX, y: event.clientY })
    const dxFraction = (to.x - from.x) / displayImage.width
    const dyFraction = (to.y - from.y) / displayImage.height
    onTransformChange({
      offsetX: clampOffset(start.offsetX + dxFraction),
      offsetY: clampOffset(start.offsetY + dyFraction),
    })
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLCanvasElement>): void {
    if (!panStartRef.current) return
    panStartRef.current = null
    setIsPanning(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const wrapperStyle: CSSProperties = {
    position: 'relative',
    width: '100%',
    maxWidth: 512,
    borderRadius: VX.radiusCard,
    overflow: 'hidden',
    ...(displayImage
      ? { aspectRatio: `${displayImage.width} / ${displayImage.height}` }
      : { minHeight: 280 }),
    ...(mode === 'matte' ? { backgroundColor: matteColor } : {}),
  }

  const cursor = interactive
    ? 'crosshair'
    : panInteractive
      ? isPanning
        ? 'grabbing'
        : 'grab'
      : 'default'

  return (
    <Box
      className={mode === 'checkerboard' ? 'image-gateway-checkerboard' : undefined}
      style={wrapperStyle}
    >
      {displayImage ? (
        <>
          <canvas
            ref={canvasRef}
            onClick={handleClick}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            aria-label="Refine preview"
            style={{
              width: '100%',
              height: '100%',
              display: 'block',
              cursor,
              touchAction: interactive || panInteractive ? 'none' : undefined,
            }}
          />
          {interactive &&
            seeds.map((seed, index) => (
              <Center
                // eslint-disable-next-line react/no-array-index-key -- seeds have no stable id, only insertion order
                key={index}
                w={18}
                h={18}
                fz={VX.text.micro}
                fw={600}
                style={{
                  position: 'absolute',
                  left: `${seed.x * 100}%`,
                  top: `${seed.y * 100}%`,
                  transform: 'translate(-50%, -50%)',
                  borderRadius: VX.radiusPill,
                  background: VX.accentFill,
                  color: VX.onAccent,
                  pointerEvents: 'none',
                  border: `2px solid ${VX.onAccent}`,
                }}
              >
                {index + 1}
              </Center>
            ))}
        </>
      ) : (
        <Center h={280}>
          <Text c="dimmed" size="sm">
            Load an image to begin
          </Text>
        </Center>
      )}
    </Box>
  )
}
