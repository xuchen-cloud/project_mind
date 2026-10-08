import { create } from "zustand";
import { revealAgentObjectPage } from "../lib/agent-panel-navigation";

export interface FilePreviewRequest {
  workspaceRoot: string;
  projectId: number;
  documentId: number;
  title: string;
  /** Omitted follows the latest committed version; supplied pins history. */
  versionNumber?: number;
}
export function isHtmlPreviewFile(file: { name?: string; baseName?: string; mimeType?: string | null }) {
  return /\.html?$/iu.test(file.baseName ?? "") || /\.html?$/iu.test(file.name ?? "")
    || file.mimeType?.split(";", 1)[0].trim().toLowerCase() === "text/html";
}
interface FilePreviewState {
  request: FilePreviewRequest | null;
  openPreview: (request: FilePreviewRequest) => void;
  closePreview: () => void;
}
export const useFilePreviewStore = create<FilePreviewState>(set => ({
  request: null,
  openPreview: request => {
    set({ request: { ...request } });
    revealAgentObjectPage();
  },
  closePreview: () => set({ request: null }),
}));
export function openFilePreview(request: FilePreviewRequest) { useFilePreviewStore.getState().openPreview(request); }
export function closeFilePreview() { useFilePreviewStore.getState().closePreview(); }
