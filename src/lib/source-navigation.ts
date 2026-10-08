import type { Editor } from "@tiptap/core";

export interface SourceNavigationRequest {
  key: string;
  requested: boolean;
  blockId: string | null;
  revision: number | null;
  timeMs: number | null;
  error: string | null;
}

export interface SourceBlockNavigation { blockId: string; key: string }

export function parseSourceNavigation(params: URLSearchParams): SourceNavigationRequest {
  const blockId = params.get("sourceBlock");
  const revisionRaw = params.get("sourceRevision");
  const timeRaw = params.get("sourceTimeMs");
  const requested = blockId !== null || revisionRaw !== null || timeRaw !== null;
  const revision = revisionRaw !== null && /^\d+$/.test(revisionRaw) ? Number(revisionRaw) : null;
  const timeMs = timeRaw !== null && /^\d+(?:\.\d+)?$/.test(timeRaw) ? Number(timeRaw) : null;
  const invalid = (blockId !== null && !/^[0-9a-f]{32}$/.test(blockId))
    || (revisionRaw !== null && (revision === null || !Number.isSafeInteger(revision)))
    || (timeRaw !== null && (timeMs === null || !Number.isFinite(timeMs)))
    || (requested && blockId === null && timeRaw === null);
  return { key: JSON.stringify([blockId, revisionRaw, timeRaw]), requested, blockId, revision, timeMs,
    error: invalid ? "来源定位信息无效，无法定位引用位置。" : null };
}

/** Resolve the exact canonical PM node, then scroll its rendered DOM. No
 * selection/content transaction, text matching, or editor persistence occurs. */
export function revealSourceBlock(editor: Pick<Editor, "state" | "view">, blockId: string): boolean {
  let position: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (position !== null) return false;
    if (node.attrs.blockId === blockId) { position = pos; return false; }
    return true;
  });
  if (position === null) return false;
  const element = editor.view.nodeDOM(position);
  if (!(element instanceof Element)) return false;
  element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  return true;
}

export function sourceBlockNavigationState(request: SourceNavigationRequest, visible: boolean,
  ready: boolean, currentRevision: number | null): { navigation: SourceBlockNavigation | null; message: string | null } {
  if (!visible || !request.requested) return { navigation: null, message: null };
  if (request.error) return { navigation: null, message: request.error };
  if (!request.blockId) return { navigation: null, message: null };
  if (!ready || currentRevision === null) return { navigation: null, message: "正在准备来源定位…" };
  if (request.revision !== null && request.revision !== currentRevision) {
    return { navigation: null, message: "引用版本已变化，无法在当前正文中准确定位来源。" };
  }
  return { navigation: { blockId: request.blockId, key: request.key }, message: null };
}
