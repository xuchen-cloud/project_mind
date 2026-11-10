import { desktopApi } from "./desktopApi";
import type { AgentWorkspaceBinding } from "../lib/agent-types";

export interface DirectoryChangeTarget {
  binding: AgentWorkspaceBinding;
  projectId: number | null;
  relativePath: string;
}
export interface PreparedDirectoryChange {
  /** CAS digest of the binding, directory identity and all descendant metadata. */
  token: string;
  identityToken: string;
  relativePath: string;
  files: Array<{ fileId: number; revision: number }>;
}
export interface DirectoryChangeResult {
  relativePath: string | null;
  fileIds: number[];
}

export interface ProjectDirectoryEntry {
  name: string;
  relativePath: string;
  kind: "directory" | "file";
  bytes: number;
}

export type ProjectDirectoryPreview =
  | { kind: "text"; text: string; bytes: number }
  | { kind: "image"; mime: string; base64: string; bytes: number }
  | { kind: "open"; reason: "binary" | "tooLarge"; bytes: number };

export const projectDirectoryApi = {
  prepareChange: (target: DirectoryChangeTarget) =>
    desktopApi.fileCommand<PreparedDirectoryChange>("project_directory_change_prepare", { ...target }),
  rename: (input: DirectoryChangeTarget & { token: string; name: string; requestId: string }) =>
    desktopApi.fileCommand<DirectoryChangeResult>("project_directory_rename", { ...input }),
  delete: (input: DirectoryChangeTarget & { token: string; confirmed: true; requestId: string }) =>
    desktopApi.fileCommand<DirectoryChangeResult>("project_directory_delete", { ...input }),
  list: (projectId: number | null, relativePath = "") =>
    desktopApi.command<ProjectDirectoryEntry[]>("project_directory_list", { projectId, relativePath }),
  preview: (projectId: number | null, relativePath: string) =>
    desktopApi.command<ProjectDirectoryPreview>("project_directory_preview", { projectId, relativePath }),
  resolveReference: (projectId: number | null, reference: string) =>
    desktopApi.command<string>("project_directory_resolve_reference", { projectId, reference }),
  open: (projectId: number | null, relativePath: string) =>
    desktopApi.command<void>("project_directory_open", { projectId, relativePath }),
};
