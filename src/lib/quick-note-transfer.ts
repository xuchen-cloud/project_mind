export type QuickNoteTransferTarget =
  | { kind: "new" }
  | { kind: "append"; recordId: number };

export interface QuickNoteTransferContext { requestId: string }

export interface QuickNoteTransferAdapter<Value, Record> {
  readCommitted: () => Value;
  isEmpty: (value: Value) => boolean;
  persist: (value: Value) => Promise<Value>;
  beforeTransfer?: (context: QuickNoteTransferContext) => Promise<void>;
  /** Writes the Record and clears the persisted QuickNote in one transaction. */
  commit: (value: Value, target: QuickNoteTransferTarget, context: QuickNoteTransferContext) => Promise<Record>;
  clearLocal: () => void;
  setBusy: (busy: boolean) => void;
}

export class QuickNoteTransferSession<Value, Record> {
  private tail: Promise<unknown> = Promise.resolve();
  private transferPromise: Promise<Record> | null = null;
  private epoch = 0;
  private attempt: { valueKey: string; targetKey: string; context: QuickNoteTransferContext; persisted?: { value: Value } } | null = null;

  constructor(private readonly adapter: QuickNoteTransferAdapter<Value, Record>) {}

  save(value: Value): Promise<unknown> {
    const epoch = this.epoch;
    const valueKey = JSON.stringify(value);
    const operation = this.tail.then(() => {
      if (epoch !== this.epoch || (this.attempt?.persisted && this.attempt.valueKey === valueKey)) return;
      return this.adapter.persist(value);
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async flush(): Promise<void> { await this.tail; }

  transfer(target: QuickNoteTransferTarget): Promise<Record> {
    if (this.transferPromise) return this.transferPromise;

    this.adapter.setBusy(true);
    const snapshot = this.adapter.readCommitted();
    if (this.adapter.isEmpty(snapshot)) {
      this.adapter.setBusy(false);
      return Promise.reject(new Error("QuickNote is empty"));
    }

    const valueKey = JSON.stringify(snapshot);
    const targetKey = JSON.stringify(target);
    if (!this.attempt || this.attempt.valueKey !== valueKey || this.attempt.targetKey !== targetKey) {
      this.attempt = { valueKey, targetKey, context: { requestId: crypto.randomUUID() } };
    }
    const attempt = this.attempt;

    const operation = this.tail.then(async () => {
      if (!attempt.persisted) {
        await this.adapter.beforeTransfer?.(attempt.context);
        attempt.persisted = { value: await this.adapter.persist(snapshot) };
      }
      // Invalidate autosaves captured before the attempted atomic transfer,
      // even when its response is lost after storage has already committed.
      this.epoch += 1;
      const record = await this.adapter.commit(attempt.persisted.value, target, attempt.context);
      this.attempt = null;
      this.adapter.clearLocal();
      return record;
    });
    this.tail = operation.catch(() => undefined);
    this.transferPromise = operation.finally(() => {
      this.transferPromise = null;
      this.adapter.setBusy(false);
    });
    return this.transferPromise;
  }
}

const quickNoteFlushers = new Map<string, () => Promise<void>>();

export function registerQuickNoteFlusher(identity: string, flush: () => Promise<void>) {
  quickNoteFlushers.set(identity, flush);
  return () => { if (quickNoteFlushers.get(identity) === flush) quickNoteFlushers.delete(identity); };
}

/** Finish autosaves/publication before changing the active Workspace database. */
export async function flushQuickNotes() {
  await Promise.all([...quickNoteFlushers.values()].map((flush) => flush()));
}
