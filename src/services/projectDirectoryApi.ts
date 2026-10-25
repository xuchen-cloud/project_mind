import { desktopApi } from "./desktopApi";

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
  list: (projectId: number | null, relativePath = "") =>
    desktopApi.command<ProjectDirectoryEntry[]>("project_directory_list", { projectId, relativePath }),
  preview: (projectId: number | null, relativePath: string) =>
    desktopApi.command<ProjectDirectoryPreview>("project_directory_preview", { projectId, relativePath }),
  resolveReference: (projectId: number | null, reference: string) =>
    desktopApi.command<string>("project_directory_resolve_reference", { projectId, reference }),
  open: (projectId: number | null, relativePath: string) =>
    desktopApi.command<void>("project_directory_open", { projectId, relativePath }),
};
