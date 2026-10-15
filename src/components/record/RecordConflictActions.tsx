import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/core";
import type { AgentWorkspaceBinding } from "../../lib/agent-types";
import type { RecordEditorState, RecordTarget } from "../../lib/record-document-types";
import type { ProjectTagRecord } from "../../lib/types";
import type { RichEditorAssetHandlers } from "../rich-editor";
import { Button } from "../../ui/components";
import { CanonicalRecordCreation } from "../../lib/canonical-record-creation";
import { recordDocumentApi } from "../../services/recordDocumentApi";

const RecordConflictDialog = lazy(() => import("./RecordConflictDialog"));
export interface RecordConflictDraft {
  title: string; tagIds: number[]; document: JSONContent; html: string; codeLanguage: string | null;
}
export type RecordConflictMode = "compare" | "reload" | "copy";

export function RecordConflictActions({ visible = true, binding, target, incoming, workspaceRoot, availableTags, assetHandlers, getDraft, pendingReviewCount, onReload, onSavedAs }: {
  visible?: boolean;
  binding: AgentWorkspaceBinding; target: RecordTarget; incoming: RecordEditorState; workspaceRoot: string;
  availableTags: ProjectTagRecord[]; assetHandlers?: RichEditorAssetHandlers;
  getDraft: () => RecordConflictDraft; pendingReviewCount: () => number;
  onReload: () => void; onSavedAs: (state: RecordEditorState) => void | Promise<void>;
}) {
  const [mode, setMode] = useState<RecordConflictMode | null>(null);
  const [draft, setDraft] = useState<RecordConflictDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creation = useRef(new CanonicalRecordCreation());
  const active = useRef(false);
  const mounted = useRef(true);
  const visibility = useRef({ visible, revision: 0 });
  if (visibility.current.visible !== visible) visibility.current = { visible, revision: visibility.current.revision + 1 };
  const identity = useRef("");
  identity.current = `${binding.workspaceId}:${binding.generation}:${JSON.stringify(target)}:${visibility.current.revision}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!visible) { setMode(null); setDraft(null); setError(null); } }, [visible]);
  function open(next: RecordConflictMode) {
    try { setDraft(structuredClone(getDraft())); setError(null); setMode(next); }
    catch (failure) { setError(String(failure)); }
  }
  async function confirm() {
    if (!visible || active.current || mode === "compare" || !mode) return;
    const capturedIdentity = identity.current;
    active.current = true; setBusy(true); setError(null);
    try {
      if (pendingReviewCount() > 0) throw new Error("请先接受或取消待确认的 AI 内容，候选和草稿都已保留");
      if (mode === "reload") {
        // Check availability before the user's explicit draft discard.
        await recordDocumentApi.editorGet(binding, target);
        if (!mounted.current || capturedIdentity !== identity.current) return;
        if (pendingReviewCount() > 0) throw new Error("请先接受或取消待确认的 AI 内容");
        onReload();
      } else {
        const current = structuredClone(getDraft());
        const saved = await creation.current.create(workspaceRoot, {
          scope: target.scope, title: current.title.trim() || null, tagIds: current.tagIds,
          document: current.document, codeLanguage: current.codeLanguage,
        }, binding);
        if (!mounted.current || capturedIdentity !== identity.current) return;
        if (pendingReviewCount() > 0) throw new Error("请先接受或取消待确认的 AI 内容，另存结果已保留");
        await onSavedAs(saved);
      }
      if (mounted.current && capturedIdentity === identity.current) setMode(null);
    } catch (failure) { if (mounted.current && capturedIdentity === identity.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { active.current = false; if (mounted.current) setBusy(false); }
  }
  if (!visible) return null;
  return <div className="rounded-[var(--radius-8)] border border-border p-3">
    <p role="alert" className="text-body text-text-muted">这条记录已在别处更新。当前草稿已保留，保存队列不会覆盖新内容。</p>
    <div className="mt-2 flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="ghost" onClick={() => open("compare")}>查看差异</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => open("reload")}>重载</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => open("copy")}>另存 Record</Button>
    </div>
    {!mode && error ? <p role="alert" className="mt-2 text-ui text-danger">{error}</p> : null}
    {mode && draft ? <Suspense fallback={<p role="status" className="mt-2 text-ui text-text-soft">正在准备差异…</p>}>
      <RecordConflictDialog mode={mode} draft={draft} incoming={incoming} workspaceRoot={workspaceRoot} availableTags={availableTags} assetHandlers={assetHandlers}
        busy={busy} error={error} onClose={() => { if (!active.current) setMode(null); }} onConfirm={() => void confirm()} />
    </Suspense> : null}
  </div>;
}
