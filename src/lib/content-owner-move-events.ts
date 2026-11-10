import { desktopApi } from "../services/desktopApi";
import type { AgentObjectRef, AgentWorkspaceBinding } from "./agent-types";
import type { ContentOwnerMoveRelease } from "./project-content-lifecycle";

export interface ContentOwnerMoved extends ContentOwnerMoveRelease {
  target: AgentObjectRef;
  oldSessionsClosed: boolean;
}

export interface FileReplaced {
  binding: AgentWorkspaceBinding;
  operationId: string;
  object: AgentObjectRef;
  versionNumber: number;
  contentHash: string;
  noChange: boolean;
  oldSessionsClosed: boolean;
}
const fileReceiptListeners = new Set<(event: FileReplaced) => void>();

/** A successful IPC response confirms the same terminal as the native event.
 * Each instance accepts only operations whose capture it participated in. */
export function publishFileReplacedReceipt(event: FileReplaced) {
  for (const listener of fileReceiptListeners) listener(event);
}
export async function subscribeFileReplaced(listener: (event: FileReplaced) => void) {
  const stop = await desktopApi.listenEvent<FileReplaced>("content:file-replaced", listener);
  fileReceiptListeners.add(listener);
  return () => { fileReceiptListeners.delete(listener); stop(); };
}

export async function subscribeContentOwnerMoveEvents(handlers: {
  moved: (event: ContentOwnerMoved) => void;
  released: (event: ContentOwnerMoveRelease) => void;
}) {
  const stopMoved = await desktopApi.listenEvent("content:owner-moved", handlers.moved);
  try {
    const stopReleased = await desktopApi.listenEvent("content:owner-move-released", handlers.released);
    return () => { stopMoved(); stopReleased(); };
  } catch (failure) { stopMoved(); throw failure; }
}
