import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";

import { queryKeys } from "./queryKeys";
import type { ProjectPageData } from "./types";
import {
  RecordSaveCoordinator,
  type RecordSaveStatus,
} from "./record-save-coordinator";

const RecordSaveCoordinatorContext = createContext<RecordSaveCoordinator | null>(null);
const RecordSaveFlushBarrierContext = createContext<(() => Promise<void>) | null>(null);

export function RecordSaveCoordinatorProvider({
  coordinator,
  flushBarrier,
  children,
}: {
  coordinator: RecordSaveCoordinator;
  flushBarrier?: () => Promise<void>;
  children: ReactNode;
}) {
  return (
    <RecordSaveCoordinatorContext.Provider value={coordinator}>
      <RecordSaveFlushBarrierContext.Provider
        value={flushBarrier ?? (() => coordinator.flush())}
      >
        {children}
      </RecordSaveFlushBarrierContext.Provider>
    </RecordSaveCoordinatorContext.Provider>
  );
}

export function useRecordSaveCoordinator() {
  return useContext(RecordSaveCoordinatorContext);
}

export function useRecordSaveFlushBarrier() {
  const coordinator = useRecordSaveCoordinator();
  return (
    useContext(RecordSaveFlushBarrierContext) ??
    (() => coordinator?.flush() ?? Promise.resolve())
  );
}

const IDLE_STATUS: RecordSaveStatus = {
  phase: "idle",
  pendingCount: 0,
  failedCount: 0,
  retryableFailedCount: 0,
  lastError: null,
};

export function useRecordSaveStatus(coordinator: RecordSaveCoordinator | null) {
  const [status, setStatus] = useState<RecordSaveStatus>(
    coordinator?.getStatus() ?? IDLE_STATUS,
  );
  useEffect(
    () => coordinator?.subscribe(setStatus) ?? (() => undefined),
    [coordinator],
  );
  return status;
}

export function createProjectRecordSaveCoordinator(options: {
  workspaceKey: string;
  queryClient: QueryClient;
}) {
  return new RecordSaveCoordinator({
    workspaceKey: options.workspaceKey,
    adapter: {
      persist: async (snapshot) => {
        if (snapshot.workspaceKey !== options.workspaceKey) {
          throw new Error("Record 保存任务不属于当前 Workspace");
        }
        const { persistProjectRecordSnapshot } = await import(
          "./record-save-persistence"
        );
        return persistProjectRecordSnapshot(snapshot);
      },
    },
    onLatestSaved: (snapshot, result) => {
      if (!result.record) {
        return;
      }
      options.queryClient.setQueryData<ProjectPageData | undefined>(
        queryKeys.projectPage(snapshot.projectId),
        (current) =>
          current
            ? {
                ...current,
                records: (current.records ?? []).map((record) =>
                  record.id === result.record?.id ? result.record : record,
                ),
              }
            : current,
      );
    },
  });
}
