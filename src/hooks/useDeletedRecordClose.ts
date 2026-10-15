import { useCallback, useRef } from "react";
import type { AgentWorkspaceBinding } from "../lib/agent-types";
import type { RecordTarget } from "../lib/record-document-types";
import type { RecordSaveCoordinator } from "../lib/record-save-coordinator";
import { discardDeletedRecordForClose } from "../lib/deleted-record-close";

export function useDeletedRecordClose(options: {
  coordinator: RecordSaveCoordinator;
  recordKey: string;
  target: RecordTarget;
  binding: AgentWorkspaceBinding | null;
  workspaceRoot: string;
  getDraftSignature: () => string;
}) {
  const current = useRef(options);
  current.current = options;
  const discarded = useRef<{ identity: string; signature: string } | null>(null);
  const identity = () => JSON.stringify([current.current.workspaceRoot, current.current.recordKey,
    current.current.binding?.workspaceId, current.current.binding?.generation]);
  const isDiscarded = useCallback(() => discarded.current?.identity === identity()
    && discarded.current.signature === current.current.getDraftSignature(), []);
  const prepareClose = useCallback(async (prepare: () => Promise<void>) => {
    if (isDiscarded()) return;
    try { await prepare(); }
    catch (error) {
      const captured = current.current;
      const capturedIdentity = identity();
      const signature = captured.getDraftSignature();
      await discardDeletedRecordForClose({ ...captured, error,
        isCurrent: () => identity() === capturedIdentity && current.current.getDraftSignature() === signature,
      });
      discarded.current = { identity: capturedIdentity, signature };
    }
  }, [isDiscarded]);
  return { isDiscarded, prepareClose };
}
