export type CalculationSession = {
  id: number
  started: boolean
  stopped: boolean
  completed: boolean
  resultApplied: boolean
}

/** Observe the existing full-preload calculation; never start another cycle. */
export class InitialCalculationGate {
  private requests = new WeakMap<object, number | null>()
  private closed = false

  expect(workbook: object): void {
    if (!this.closed) this.requests.set(workbook, null)
  }

  begin(workbook: object, previousSession: number): void {
    if (!this.closed && this.requests.has(workbook)) this.requests.set(workbook, previousSession)
  }

  ready(workbook: object & {formulaMode: boolean}, manual: boolean, session: CalculationSession): boolean {
    if (this.closed) return false
    if (manual || !workbook.formulaMode) return true
    const previous = this.requests.get(workbook)
    return previous !== undefined && previous !== null && session.id > previous && session.started &&
      !session.stopped && session.completed && session.resultApplied
  }

  dispose(): void {
    this.closed = true
    this.requests = new WeakMap()
  }
}
