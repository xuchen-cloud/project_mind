import { useMemo } from "react";
import type { JSONContent } from "@tiptap/core";
import type { RecordEditorState } from "../../lib/record-document-types";
import type { ProjectTagRecord } from "../../lib/types";
import { compareRecordDocuments } from "../../lib/record-version-compare";
import { recordBlockDescriptions } from "../../lib/record-block-descriptions";
import { Button, Dialog } from "../../ui/components";
import { HomeSidebarList } from "../home/HomeSidebarList";
import { RichEditor, type RichEditorAssetHandlers } from "../rich-editor";
import type { RecordConflictDraft, RecordConflictMode } from "./RecordConflictActions";
import "./record-history.css";

function portableForComparison(document: JSONContent, workspaceRoot: string) {
  const copy = structuredClone(document);
  const root = workspaceRoot.replaceAll("\\", "/").replace(/\/$/u, "");
  const visit = (node: JSONContent) => {
    if ((node.type === "image" || node.type === "attachment") && typeof node.attrs?.path === "string") {
      const path = node.attrs.path.replaceAll("\\", "/");
      node.attrs = { ...node.attrs, path: root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path,
        [node.type === "image" ? "src" : "href"]: null };
    }
    node.content?.forEach(visit);
  };
  visit(copy);
  return copy;
}
export default function RecordConflictDialog({ mode, draft, incoming, workspaceRoot, availableTags, assetHandlers, busy, error, onClose, onConfirm }: {
  mode: RecordConflictMode; draft: RecordConflictDraft; incoming: RecordEditorState; workspaceRoot: string;
  availableTags: ProjectTagRecord[]; assetHandlers?: RichEditorAssetHandlers; busy: boolean; error: string | null;
  onClose: () => void; onConfirm: () => void;
}) {
  const difference = useMemo(() => compareRecordDocuments(incoming.head.projection.document, portableForComparison(draft.document, workspaceRoot)), [incoming, draft, workspaceRoot]);
  const labels = new Map([...availableTags, ...(incoming.record.tags ?? [])].map((tag) => [tag.id, tag.label]));
  const before = recordBlockDescriptions(incoming.head.projection.document);
  const after = recordBlockDescriptions(draft.document);
  const tagText = (ids: number[]) => ids.map((id) => labels.get(id) ?? `#${id}`).join("、") || "无标签";
  return <Dialog open title={mode === "compare" ? "记录差异" : mode === "reload" ? "重载已保存记录" : "另存当前草稿"}
    description={mode === "reload" ? "重载会放弃当前正文、标题、标签及代码语言草稿，读取最新保存的记录。" : mode === "copy" ? "当前已确认草稿会成为同一位置的一条新记录；原记录的已保存内容会保留。" : "左侧是最新已保存内容，右侧是本地已确认草稿；待确认 AI 预览不参与比较。"}
    onClose={onClose} widthClassName="max-w-5xl" bodyClassName="overflow-hidden"
    footer={<><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{mode === "compare" ? "关闭" : "取消"}</Button>
      {mode !== "compare" ? <Button type="button" variant="primary" disabled={busy} onClick={onConfirm}>{busy ? "处理中…" : mode === "reload" ? "确认放弃草稿并重载" : "确认另存 Record"}</Button> : null}</>}>
    {error ? <p role="alert" className="mb-3 text-ui text-danger">{error}</p> : null}
    <p className="mb-3 text-ui text-text-soft">本地草稿相较已保存内容：新增 {difference.added.length} 块 · 删除 {difference.deleted.length} 块 · 修改 {difference.modified.length} 块 · 移动 {difference.moved.length} 块</p>
    <div className="record-history__columns">
      <div className="record-history__preview"><HomeSidebarList label="最新已保存记录">
        <p className="font-medium">最新已保存</p><p className="mt-2 text-body">{incoming.metadata.title || "未命名记录"}</p>
        <p className="mb-3 text-ui text-text-soft">{tagText(incoming.metadata.tagIds)} · 代码语言 {incoming.head.projection.codeLanguage || "自动"}</p>
        <RichEditor key={`${incoming.head.headRevision}:${incoming.metadata.revision}`} readOnly showToolbar={false} variant="bare" defaultHtml={incoming.record.contentHtml} defaultCodeLanguage={incoming.head.projection.codeLanguage} assetHandlers={assetHandlers} />
      </HomeSidebarList></div>
      <div className="record-history__preview"><HomeSidebarList label="本地已确认草稿">
        <p className="font-medium">本地草稿</p><p className="mt-2 text-body">{draft.title || "未命名记录"}</p>
        <p className="mb-3 text-ui text-text-soft">{tagText(draft.tagIds)} · 代码语言 {draft.codeLanguage || "自动"}</p>
        <div className="mb-3 grid gap-2 text-ui">
          {([['added','新增'],['deleted','删除'],['modified','修改'],['moved','移动']] as const).map(([kind,label]) => <details key={kind}><summary>{label} {difference[kind].length} 块</summary>
            <ul className="grid gap-2 py-2">{difference[kind].map((id) => <li key={id} className="rounded-[var(--radius-6)] bg-bg-subtle p-2">
              {kind === "modified" ? <><p className="text-text-soft">已保存：{before.get(id) || "空块"}</p><p>草稿：{after.get(id) || "空块"}</p></> : <p>{(kind === "deleted" ? before : after).get(id) || "空块"}</p>}
            </li>)}</ul>
          </details>)}
        </div>
        <RichEditor readOnly showToolbar={false} variant="bare" defaultHtml={draft.html} defaultCodeLanguage={draft.codeLanguage} assetHandlers={assetHandlers} />
      </HomeSidebarList></div>
    </div>
  </Dialog>;
}
