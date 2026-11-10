import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useFileDropTarget } from "../../hooks/useFileDropTarget";
import { useWindowFileDrop } from "../../hooks/useWindowFileDrop";
import { extractDroppedFilePaths } from "../../lib/document-drop";
import { planFileDrop } from "../../lib/file-drop-plan";
import { getErrorMessage } from "../../lib/errors";
import { queryKeys } from "../../lib/queryKeys";
import { notifyProjectFilesChanged } from "../../lib/project-file-navigation";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { createFileDropBatch, type FileDropInput } from "../../services/fileDropApi";
import { useFeedbackStore } from "../../state/feedback-store";

export interface FileDropRow {
  id: number; name: string; documentId: number; projectId: number | null;
  managedPath: string; expectedVersionNumber: number;
}
export interface FileDropSurfaceProps {
  workspaceRoot?: string; fileRootPath?: string; projectId: number | null;
  elementRef?: RefObject<HTMLElement | null>;
  /** Main content excludes the sidebar, which has its own surface. */
  main?: boolean; onActiveChange?: (active: boolean) => void;
}
const editors = '.rich-editor, .office-file-content, .markdown-file-content, .cm-editor, [contenteditable="true"], [data-content-object^="record:"]';
const fileContent = '.project-file-content, .project-content__file-page, .project-content__empty';
const blocked = '[role="dialog"], [role="menu"], [aria-modal="true"], .context-menu__panel';
function visible(element: HTMLElement) {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden || node.inert || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true"
      || getComputedStyle(node).display === "none" || getComputedStyle(node).visibility === "hidden") return false;
  }
  return document.visibilityState !== "hidden";
}

/** DOM and native drags share one policy and one CSS-pixel hit test. */
export function FileDropSurface({ workspaceRoot, fileRootPath, projectId, elementRef, main = false, onActiveChange }: FileDropSurfaceProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useFeedbackStore();
  const scopeKey = JSON.stringify([workspaceRoot, fileRootPath, projectId]);
  const target = useFileDropTarget<FileDropRow>({ enabled: true, scopeKey });
  const [active, setActive] = useState(false);
  const hoveredRow = useRef<HTMLElement | null>(null);
  const delivered = useRef(false);
  const generation = useRef(0);
  const root = () => elementRef?.current ?? (main ? document.querySelector<HTMLElement>(".workspace-content-main") : null);
  const accepts = (element: Element | null): element is HTMLElement => {
    const region = root();
    return element instanceof HTMLElement && !!region && region.contains(element) && visible(element)
      && !element.closest(blocked) && !element.closest(editors)
      && (!main || (!!element.closest(fileContent) && !element.closest("[data-file-drop-sidebar]")));
  };
  const hit = (position: { x: number; y: number }) => document.elementFromPoint(position.x, position.y);
  const clear = () => { hoveredRow.current = null; target.leave(); };
  const hover = (element: Element | null) => {
    if (!accepts(element)) { clear(); setActive(false); onActiveChange?.(false); return; }
    const row = element.closest<HTMLElement>("[data-file-drop-target]");
    if (row !== hoveredRow.current) target.leave();
    hoveredRow.current = row;
    const baseline: FileDropRow | null = row ? JSON.parse(row.dataset.fileDropTarget!) : null;
    target.hover(baseline?.projectId === projectId ? baseline : null);
    setActive(true);
    onActiveChange?.(true);
  };
  const handleDrop = async (paths: string[], element: Element | null) => {
    if (!accepts(element)) { clear(); setActive(false); onActiveChange?.(false); return; }
    // Re-hit on drop, before consuming and before any asynchronous work.
    hover(element);
    const plan = planFileDrop(paths, target.consume());
    hoveredRow.current = null;
    setActive(false);
    onActiveChange?.(false);
    if (plan.kind === "reject") { pushToast({ tone: "error", title: "无法拖入文件", detail: plan.message }); return; }
    if (!workspaceRoot) { pushToast({ tone: "error", title: "无法拖入文件", detail: "工作区信息尚未就绪。" }); return; }
    const current = generation.current;
    try {
      const binding = await recordDocumentApi.bindingGet(workspaceRoot);
      if (current !== generation.current) return;
      const inputs: FileDropInput[] = plan.kind === "update"
        ? [{ sourcePath: plan.sourcePath, target: { kind: "update", documentId: plan.target.documentId,
            projectId: plan.target.projectId, managedPath: plan.target.managedPath, expectedVersionNumber: plan.target.expectedVersionNumber } }]
        : plan.paths.map(sourcePath => ({ sourcePath, target: { kind: "new", owner: projectId, name: sourcePath.split(/[\\/]/).pop()! } }));
      const batch = createFileDropBatch(binding, inputs);
      const confirm = async () => {
        const outcomes = await batch.run();
        // Every outcome survives a partial failure. A retry uses this same batch.
        for (const outcome of outcomes) {
          if (outcome.releaseError) pushToast({ tone: "error", title: "文件保存屏障释放失败", detail: getErrorMessage(outcome.releaseError),
            action: { label: outcome.status === "error" && outcome.uncertain ? "确认结果并释放" : "重试释放", onClick: () => { void confirm(); } } });
          if (outcome.status === "success") {
            pushToast({ tone: "success", title: outcome.result.noChange ? `内容未变化，保留 v${outcome.result.versionNumber}` : `文件已拖入 · v${outcome.result.versionNumber}`,
              detail: `${outcome.sourcePath}${outcome.result.cleanupWarning ? `：${outcome.result.cleanupWarning}` : ""}` });
          } else pushToast({ tone: "error", title: outcome.uncertain ? "拖入结果待确认" : "拖入文件失败",
            detail: `${outcome.sourcePath}：${getErrorMessage(outcome.error)}`,
            ...(outcome.uncertain ? { action: { label: "重试确认", onClick: () => { void confirm(); } } } : {}) });
        }
        if (outcomes.some(outcome => outcome.status === "success")) {
          notifyProjectFilesChanged(projectId, workspaceRoot);
          try { await Promise.all([
            queryClient.invalidateQueries({ queryKey: projectId === null ? queryKeys.workspacePage : queryKeys.projectPage(projectId) }),
            queryClient.invalidateQueries({ queryKey: ["project-directory"],
              predicate: query => query.queryKey[2] === projectId && (!fileRootPath || query.queryKey[1] === fileRootPath) }),
          ]); } catch (error) { pushToast({ tone: "error", title: "文件已移入，列表刷新失败", detail: getErrorMessage(error) }); }
        }
      };
      await confirm();
    } catch (error) { pushToast({ tone: "error", title: "无法开始拖入", detail: getErrorMessage(error) }); }
  };
  const native = useWindowFileDrop({
    isPositionActive: position => accepts(hit(position)),
    onHoverPosition: position => position ? hover(hit(position)) : clear(),
    onHoverChange: active => { if (!active) { clear(); setActive(false); onActiveChange?.(false); } },
    onDrop: (paths, position) => handleDrop(paths, position ? hit(position) : null),
  });
  // Keep event handlers current without resubscribing during a drag/hint commit.
  const handlers = useRef({ hover, clear, accepts, handleDrop, onActiveChange, native: native.nativeWindowFileDrop });
  useLayoutEffect(() => { handlers.current = { hover, clear, accepts, handleDrop, onActiveChange, native: native.nativeWindowFileDrop }; });
  useLayoutEffect(() => {
    generation.current++;
    setActive(false);
    delivered.current = false;
    const fileDrag = (event: DragEvent) => !!event.dataTransfer && (Array.from(event.dataTransfer.types).some(type => type === "Files" || type === "text/uri-list") || event.dataTransfer.files.length > 0);
    const over = (event: DragEvent) => {
      const h = handlers.current;
      if (h.native || !fileDrag(event)) return;
      if (!h.accepts(event.target as Element)) { h.clear(); setActive(false); return; }
      event.preventDefault(); event.stopPropagation();
      delivered.current = false;
      h.hover(event.target as Element);
    };
    const drop = (event: DragEvent) => {
      const h = handlers.current;
      if (h.native || !fileDrag(event) || !h.accepts(event.target as Element)) return;
      event.preventDefault(); event.stopPropagation();
      if (delivered.current) return;
      delivered.current = true;
      void h.handleDrop(extractDroppedFilePaths(event.dataTransfer!), event.target as Element);
    };
    const leave = (event: DragEvent) => {
      const h = handlers.current;
      if (h.native) return;
      if (!h.accepts(event.relatedTarget as Element)) { h.clear(); setActive(false); h.onActiveChange?.(false); }
      else h.hover(event.relatedTarget as Element);
    };
    const reset = () => handlers.current.clear();
    const visibility = () => { reset(); if (!root() || !visible(root()!)) setActive(false); };
    const scroll = (event: Event) => { if (event.target === document || root()?.contains(event.target as Node)) reset(); };
    const observer = new ResizeObserver(reset);
    const region = root();
    if (region) observer.observe(region);
    const mutations = new MutationObserver(() => {
      // DOM insertions/reordering/visibility can move a row without resizing it.
      if (hoveredRow.current) reset();
      if (region && !visible(region)) setActive(false);
    });
    if (region) mutations.observe(region, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "inert", "style", "class"] });
    for (let node = region?.parentElement; node; node = node.parentElement) {
      mutations.observe(node, { attributes: true, attributeFilter: ["hidden", "inert", "style", "class", "aria-hidden"] });
    }
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("dragenter", over, true); document.addEventListener("dragover", over, true);
    document.addEventListener("drop", drop, true); document.addEventListener("dragleave", leave, true);
    document.addEventListener("scroll", scroll, true); window.addEventListener("resize", reset);
    return () => {
      generation.current++; reset(); observer.disconnect(); mutations.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("dragenter", over, true); document.removeEventListener("dragover", over, true);
      document.removeEventListener("drop", drop, true); document.removeEventListener("dragleave", leave, true);
      document.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", reset);
    };
  }, [scopeKey, main, elementRef]);
  return active ? createPortal(<div role="status" data-file-drop-hint className="pointer-events-none fixed bottom-6 left-1/2 z-[100] max-w-[calc(100vw-2rem)] -translate-x-1/2 break-words rounded-lg border border-border bg-bg px-4 py-2 text-ui text-text shadow-lg">
    {target.readyTarget ? `更新此文件版本 · ${target.readyTarget.name} · v${target.readyTarget.expectedVersionNumber}；成功后原文件移至回收站` : "松手移入文件，成功后原文件移至回收站"}
  </div>, document.body) : null;
}
