export type QuickNoteTransferTarget =
  | { kind: "new" }
  | { kind: "append"; recordId: number };

export interface QuickNoteTransferAdapter<Value, Record> {
  readCommitted: () => Value;
  isEmpty: (value: Value) => boolean;
  persist: (value: Value) => Promise<Value>;
  /** Writes the Record and clears the persisted QuickNote in one transaction. */
  commit: (value: Value, target: QuickNoteTransferTarget) => Promise<Record>;
  clearLocal: () => void;
  setBusy: (busy: boolean) => void;
}

export class QuickNoteTransferSession<Value, Record> {
  private tail: Promise<unknown> = Promise.resolve();
  private transferPromise: Promise<Record> | null = null;
  private epoch = 0;

  constructor(private readonly adapter: QuickNoteTransferAdapter<Value, Record>) {}

  save(value: Value): Promise<unknown> {
    const epoch = this.epoch;
    const operation = this.tail.then(() =>
      epoch === this.epoch ? this.adapter.persist(value) : undefined,
    );
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

    const operation = this.tail.then(async () => {
      const persisted = await this.adapter.persist(snapshot);
      const record = await this.adapter.commit(persisted, target);
      this.epoch += 1;
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
