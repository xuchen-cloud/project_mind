import type { AgentObjectRef, AgentWorkspaceBinding } from "../lib/agent-types";
import type { FileBytesInput, FileBytesResult, NativeFileApplication, ProjectDirectoryFile, ProjectDirectoryScanResult } from "../lib/file-types";
import { desktopApi } from "./desktopApi";

export class ProjectFileError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "ProjectFileError"; }
}
async function command<T>(name: string, payload: Record<string, unknown>): Promise<T> {
  try { return await desktopApi.fileCommand<T>(name, payload); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && "message" in error && typeof error.code === "string" && typeof error.message === "string") {
      throw new ProjectFileError(error.code, error.message);
    }
    throw error;
  }
}

export const projectFileApi = {
  register: (binding: AgentWorkspaceBinding, projectId: number | null, relativePath: string) =>
    command<ProjectDirectoryFile>("project_file_register", { binding, projectId, relativePath }),
  resolve: (binding: AgentWorkspaceBinding, object: AgentObjectRef) =>
    command<ProjectDirectoryFile>("project_file_resolve", { binding, object }),
  openLocal: (binding: AgentWorkspaceBinding, object: AgentObjectRef): Promise<void> =>
    command<void>("project_file_open_local", { binding, object }),
  applications: (binding: AgentWorkspaceBinding, object: AgentObjectRef) =>
    command<NativeFileApplication[]>("project_file_applications", { binding, object }),
  openWith: (binding: AgentWorkspaceBinding, object: AgentObjectRef, applicationId: string) =>
    command<void>("project_file_open_with", { binding, object, applicationId }),
  resolveRelated: (binding: AgentWorkspaceBinding, object: AgentObjectRef, relativeReference: string) =>
    command<ProjectDirectoryFile>("project_file_resolve_related", { binding, object, relativeReference }),
  readBytes: (binding: AgentWorkspaceBinding, input: FileBytesInput) =>
    command<FileBytesResult>("project_file_read_bytes", { binding, input }),
  move: (binding: AgentWorkspaceBinding, object: AgentObjectRef, relativePath: string, expectedVersionNumber: number, expectedContentHash: string) =>
    command<ProjectDirectoryFile>("project_file_move", { binding, object, relativePath, expectedVersionNumber, expectedContentHash }),
  rename: (binding: AgentWorkspaceBinding, object: AgentObjectRef, name: string, expectedVersionNumber: number, expectedContentHash: string) =>
    command<ProjectDirectoryFile>("project_file_rename", { binding, object, name, expectedVersionNumber, expectedContentHash }),
  reconcile: (binding: AgentWorkspaceBinding, object: AgentObjectRef, relativePath: string, expectedVersionNumber: number, expectedContentHash: string, confirmation: "location" | "replacement") =>
    command<ProjectDirectoryFile>("project_file_reconcile", { binding, object, relativePath, expectedVersionNumber, expectedContentHash, confirmation }),
  // A bounded scan page is committed independently. Stop requesting pages to
  // cancel; cancelled=true acknowledges cancellation without losing prior work.
  scan: (binding: AgentWorkspaceBinding, projectId: number | null, cursor: string | null = null, limit = 50, cancelled = false) =>
    command<ProjectDirectoryScanResult>("project_file_scan", { binding, projectId, cursor, limit, cancelled }),
};

export function fileBytes(result: FileBytesResult): Uint8Array {
  return Uint8Array.from(atob(result.base64), (character) => character.charCodeAt(0));
}
