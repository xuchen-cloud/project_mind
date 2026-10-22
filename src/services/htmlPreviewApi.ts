import type { AgentWorkspaceBinding } from "../lib/agent-types";
import type { FileBytesInput } from "../lib/file-types";
import { desktopApi } from "./desktopApi";

export interface HtmlPreviewSession { id: string; url: string }
export interface HtmlPreviewBounds {
  x: number; y: number; width: number; height: number;
  viewportWidth: number; viewportHeight: number; visible: boolean;
  /** CSS viewport width before native fit zoom; 0 follows the visible bounds. */
  pageWidth: number;
}
export interface HtmlPreviewStatus { url: string; loading: boolean; diagnostics: string[] }
export type HtmlPreviewAction = "back" | "forward" | "reload";

export const htmlPreviewApi = {
  create: (binding: AgentWorkspaceBinding, input: FileBytesInput, historical: boolean) =>
    desktopApi.fileCommand<HtmlPreviewSession>("html_preview_create", { binding, input, historical }),
  layout: (id: string, bounds: HtmlPreviewBounds) =>
    desktopApi.fileCommand<void>("html_preview_layout", { id, bounds }),
  action: (id: string, action: HtmlPreviewAction) =>
    desktopApi.fileCommand<void>("html_preview_action", { id, action }),
  status: (id: string) => desktopApi.fileCommand<HtmlPreviewStatus>("html_preview_status", { id }),
  close: (id: string) => desktopApi.fileCommand<void>("html_preview_close", { id }),
};
