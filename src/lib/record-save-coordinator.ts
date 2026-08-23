import type { RichEditorValue } from "../components/rich-editor/types";
import type { NoteRecord } from "./types";

export interface CommittedProjectRecordSnapshot {
  workspaceKey: string;
  projectId: number;
  recordId: number;
  activityId: number | null;
  title: string;
  tagIds: number[];
  defaultCodeLanguage: string | null;
  committedContent: RichEditorValue;
}

export function projectRecordSaveKey(projectId: number, recordId: number) {
  return `project:${projectId}:${recordId}`;
}

export interface RecordSaveResult {
  updatedAt: string;
  record?: NoteRecord;
}

export interface RecordSaveAdapter {
  persist(snapshot: Readonly<CommittedProjectRecordSnapshot>): Promise<RecordSaveResult>;
}

export interface RecordSaveReceipt {
  recordKey: string;
  sequence: number;
}

export interface RecordSaveStatus {
  phase: "idle" | "saving" | "error";
  pendingCount: number;
  failedCount: number;
  retryableFailedCount: number;
  lastError: unknown | null;
}

export class RecordSaveFailure extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean }) {
    super(message);
    this.name = "RecordSaveFailure";
    this.retryable = options.retryable;
  }
}

type SaveTaskState = "queued" | "running" | "failed" | "saved";

interface SaveTask {
  snapshot: Readonly<CommittedProjectRecordSnapshot>;
  sequence: number;
  state: SaveTaskState;
  error: unknown | null;
}

type StatusListener = (status: RecordSaveStatus) => void;

function immutableSnapshot(
  snapshot: CommittedProjectRecordSnapshot,
): Readonly<CommittedProjectRecordSnapshot> {
  const committedContent = Object.freeze({ ...snapshot.committedContent });
  return Object.freeze({
    ...snapshot,
    tagIds: Object.freeze([...snapshot.tagIds]) as unknown as number[],
    committedContent,
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function statusForTasks(tasks: readonly SaveTask[]): RecordSaveStatus {
  const pending = tasks.filter((task) => task.state !== "saved");
  const failed = pending.filter((task) => task.state === "failed");
  return {
    phase: failed.length > 0 ? "error" : pending.length > 0 ? "saving" : "idle",
    pendingCount: pending.length,
    failedCount: failed.length,
    retryableFailedCount: failed.filter(
      (task) => !(task.error instanceof RecordSaveFailure) || task.error.retryable,
    ).length,
    lastError: failed[failed.length - 1]?.error ?? null,
  };
}

export class RecordSaveCoordinator {
  readonly workspaceKey: string | null;
  private readonly adapter: RecordSaveAdapter;
  private readonly onLatestSaved?: (
    snapshot: Readonly<CommittedProjectRecordSnapshot>,
    result: RecordSaveResult,
  ) => void;
  private readonly tasksByRecord = new Map<string, SaveTask[]>();
  private readonly latestSequenceByRecord = new Map<string, number>();
  private readonly listeners = new Set<StatusListener>();
  private nextSequence = 1;

  constructor(options: {
    adapter: RecordSaveAdapter;
    workspaceKey?: string;
    onLatestSaved?: (
      snapshot: Readonly<CommittedProjectRecordSnapshot>,
      result: RecordSaveResult,
    ) => void;
  }) {
    this.adapter = options.adapter;
    this.workspaceKey = options.workspaceKey ?? null;
    this.onLatestSaved = options.onLatestSaved;
  }

  submit(snapshot: CommittedProjectRecordSnapshot): RecordSaveReceipt {
    const captured = immutableSnapshot(snapshot);
    const recordKey = projectRecordSaveKey(captured.projectId, captured.recordId);
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    const task: SaveTask = {
      snapshot: captured,
      sequence,
      state: "queued",
      error: null,
    };
    const tasks = this.tasksByRecord.get(recordKey) ?? [];
    tasks.push(task);
    this.tasksByRecord.set(recordKey, tasks);
    this.latestSequenceByRecord.set(recordKey, sequence);
    this.emit();
    this.scheduleRecord(recordKey);
    return { recordKey, sequence };
  }

  getStatus(): RecordSaveStatus {
    return statusForTasks(Array.from(this.tasksByRecord.values()).flat());
  }

  subscribe(listener: StatusListener) {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.listeners.delete(listener);
    };
  }

  retryFailed(recordKey?: string) {
    for (const [key, tasks] of this.tasksByRecord) {
      if (recordKey && key !== recordKey) {
        continue;
      }
      for (const task of tasks) {
        if (task.state === "failed") {
          if (task.error instanceof RecordSaveFailure && !task.error.retryable) {
            continue;
          }
          task.state = "queued";
          task.error = null;
          break;
        }
      }
      this.scheduleRecord(key);
    }
    this.emit();
  }

  flush(): Promise<void> {
    const initialStatus = this.getStatus();
    if (initialStatus.phase === "idle") {
      return Promise.resolve();
    }
    if (initialStatus.phase === "error") {
      return Promise.reject(new Error(errorMessage(initialStatus.lastError)));
    }

    return new Promise<void>((resolve, reject) => {
      let unsubscribe: () => void = () => undefined;
      const check = () => {
        const status = this.getStatus();
        if (status.phase === "error") {
          unsubscribe();
          reject(new Error(errorMessage(status.lastError)));
          return;
        }
        if (status.phase === "idle") {
          unsubscribe();
          resolve();
        }
      };
      unsubscribe = this.subscribe(check);
      check();
    });
  }

  getLatestSnapshot(recordKey: string) {
    const tasks = this.tasksByRecord.get(recordKey) ?? [];
    return [...tasks].reverse().find((task) => task.state !== "saved")?.snapshot ?? null;
  }

  getRecordStatus(recordKey: string): RecordSaveStatus {
    return statusForTasks(this.tasksByRecord.get(recordKey) ?? []);
  }

  private async runRecord(recordKey: string) {
    const tasks = this.tasksByRecord.get(recordKey) ?? [];
    if (tasks.some((task) => task.state === "running")) {
      return;
    }
    const task = tasks.find((candidate) => candidate.state !== "saved");
    if (!task || task.state === "failed") {
      return;
    }

    task.state = "running";
    this.emit();
    let result: RecordSaveResult;
    try {
      result = await this.adapter.persist(task.snapshot);
    } catch (error) {
      task.state = "failed";
      task.error = error;
      this.emit();
      return;
    }
    task.state = "saved";
    if (this.latestSequenceByRecord.get(recordKey) === task.sequence) {
      try {
        this.onLatestSaved?.(task.snapshot, result);
      } catch {
        // Persistence already succeeded; a cache observer must not enqueue a duplicate write.
      }
    }
    this.emit();
    while (tasks[0]?.state === "saved") {
      tasks.shift();
    }
    if (tasks.length === 0) {
      this.tasksByRecord.delete(recordKey);
      this.latestSequenceByRecord.delete(recordKey);
      return;
    }
    void this.runRecord(recordKey);
  }

  private scheduleRecord(recordKey: string) {
    queueMicrotask(() => {
      void this.runRecord(recordKey);
    });
  }

  private emit() {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      listener(status);
    }
  }
}
