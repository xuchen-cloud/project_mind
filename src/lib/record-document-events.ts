import { desktopApi } from "../services/desktopApi";
import type { AgentWorkspaceBinding } from "./agent-types";
import type { RecordTarget } from "./record-document-types";

export interface RecordHeadChanged {
  binding: AgentWorkspaceBinding;
  target: RecordTarget;
  requestId: string;
  headRevision: number | null;
  metadataRevision: string | null;
}
export function subscribeRecordHeadChanges(listener: (change: RecordHeadChanged) => void) {
  return desktopApi.listenEvent<RecordHeadChanged>("record:head-changed", listener);
}
