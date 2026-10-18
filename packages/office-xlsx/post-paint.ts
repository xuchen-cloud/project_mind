type PaintClock = Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame' | 'setTimeout' | 'clearTimeout'>

/** Yield a paint opportunity after Rendered, then initialize every Steady feature. */
export function schedulePostPaint(run: () => void, clock: PaintClock = window): () => void {
  let cancelled = false
  let timer: number | undefined
  let frame = clock.requestAnimationFrame(() => {
    frame = clock.requestAnimationFrame(() => {
      timer = clock.setTimeout(() => { if (!cancelled) run() }, 0)
    })
  })
  return () => {
    cancelled = true
    clock.cancelAnimationFrame(frame)
    if (timer !== undefined) clock.clearTimeout(timer)
  }
}
