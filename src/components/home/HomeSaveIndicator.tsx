import { LoaderCircle } from "lucide-react";
import type { RichEditorPersistState } from "../rich-editor";

/** Keep successful/idle saves quiet; show activity and optional inline failure. */
export function HomeSaveIndicator({ state, showError = true }: {
  state: RichEditorPersistState;
  showError?: boolean;
}) {
  if (state === "saving") {
    return <span role="status" aria-label="正在保存"><LoaderCircle size={14} className="spin text-text-soft" aria-hidden="true" /></span>;
  }
  return state === "error" && showError ? <span className="text-caption text-danger">保存失败</span> : null;
}
