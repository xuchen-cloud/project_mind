import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { z } from 'zod'

const responseSchema = z.discriminatedUnion('ok', [
  z.object({ version: z.literal(1), requestId: z.string(), ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ version: z.literal(1), requestId: z.string(), ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }).strict() }).strict(),
])
/** One operation owns one process. Protocol corruption fails immediately. */
export class Sidecar {
  private child: ChildProcessWithoutNullStreams
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private failure?: Error
  private stopped: Promise<void>
  constructor(binaryPath: string) {
    this.child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let buffered = ''
    let stderr = ''
    this.child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192) })
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        buffered += decoder.decode(chunk, { stream: true })
        if (Buffer.byteLength(buffered) > 16 * 1024 * 1024) throw new Error('Sidecar JSON exceeds 16 MiB')
        let end: number
        while ((end = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, end)
          buffered = buffered.slice(end + 1)
          const parsed = JSON.parse(line)
          validateJsonScalars(parsed)
          const response = responseSchema.parse(parsed)
          const pending = this.pending.get(response.requestId)
          if (!pending) throw new Error('Unrecognized sidecar response')
          this.pending.delete(response.requestId)
          clearTimeout(pending.timer)
          if (response.ok) pending.resolve(response.result)
          else pending.reject(new Error(`${response.error.code}: ${response.error.message}`))
        }
      } catch (cause) { this.fail(new Error('Invalid sidecar UTF-8/JSON protocol', { cause })) }
    })
    this.child.stdout.on('end', () => {
      try { decoder.decode(); if (buffered) throw new Error('Incomplete JSONL frame') }
      catch (cause) { this.fail(new Error('Truncated sidecar protocol', { cause })) }
    })
    this.child.once('error', (error) => this.fail(error))
    this.child.stdin.on('error', (error) => this.fail(error))
    this.stopped = new Promise((resolve) => this.child.once('close', (code) => {
      if (this.pending.size) this.fail(new Error(`XLSX sidecar exited (${code}): ${stderr}`))
      resolve()
    }))
  }
  private fail(error: Error) {
    this.failure = error
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    this.child.kill()
  }
  request(command: Record<string, unknown>): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure)
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('XLSX sidecar request timed out')), 180_000)
      this.pending.set(requestId, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ version: 1, requestId, ...command }) + '\n')
    })
  }
  async stop() { this.child.kill(); await this.stopped }
  open(path: string) { return this.request({ command: 'open', path, locale: 'zh' }) }
  readRange(input: Record<string, unknown>) { return this.request({ command: 'read_range', ...input }) }
  close(sessionId: string) { return this.request({ command: 'close', sessionId }) }
  archiveManifest(path: string) { return this.request({ command: 'archive_manifest', path }) }
  readEntries(input: Record<string, unknown>) { return this.request({ command: 'read_entries', ...input }) }
  scanEntries(input: Record<string, unknown>) { return this.request({ command: 'scan_entries', ...input }) }
  saveArchive(input: Record<string, unknown>) { return this.request({ command: 'save_archive', ...input }) }
  recalcCells(input: Record<string, unknown>) { return this.request({ command: 'recalc_cells', ...input }) }
}

function validateJsonScalars(value: unknown) {
  const pending: unknown[] = [value]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string' && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item)) throw new Error('Invalid Unicode scalar in JSON')
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Non-finite JSON number')
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) pending.push(key, child)
  }
}
