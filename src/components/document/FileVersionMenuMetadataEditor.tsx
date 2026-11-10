import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FileVersionMetadata, FileVersionMetadataTarget, FileVersionMetadataUpdateResult } from "../../lib/file-types";
import { queryKeys } from "../../lib/queryKeys";
import { fileDocumentApi } from "../../services/fileDocumentApi";
import { AgentApiError } from "../../services/agentApi";
import { getErrorMessage } from "../../lib/errors";
import { Button } from "../../ui/components/Button";
import { Dialog } from "../../ui/components/Dialog";
import { FileVersionLabelEditor } from "./FileVersionLabelEditor";

export type EditableFileVersion = Pick<FileVersionMetadata, "id" | "versionNumber" | "displayName" | "isImportant" | "metadataRevision"> & { metadataTarget: FileVersionMetadataTarget };
export function fileVersionMetadataIdentity(version: EditableFileVersion) {
  const { binding, object } = version.metadataTarget;
  return JSON.stringify([binding.workspaceId, binding.generation, object.scope, object.kind, object.id, version.id]);
}

export function FileVersionMenuMetadataEditor({ version, onUpdated, onClose }: {
  version: EditableFileVersion;
  onUpdated: (result: FileVersionMetadataUpdateResult) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [baseline, setBaseline] = useState(version);
  const [conflict, setConflict] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const [refreshed, setRefreshed] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const { binding, object } = version.metadataTarget;
  function close() { if (!pending.current) onClose(); }
  async function refresh() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setRefreshError(undefined);
    try {
      const result = await fileDocumentApi.versionGet(binding, { object, versionId: version.id });
      if (!active.current) return;
      setBaseline({ ...version, ...result.version });
      setConflict(false);
      setRefreshed(true);
      onUpdated({ object, versionId: version.id, displayName: result.version.displayName,
        isImportant: result.version.isImportant, metadataRevision: result.version.metadataRevision });
    } catch (cause) {
      if (active.current) setRefreshError(getErrorMessage(cause, "无法读取最新版本标记"));
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  return <Dialog open title="编辑版本标记" description="为历史版本设置自定义名称和重要标记。" onClose={close}
    footer={<Button type="button" disabled={busy} onClick={close}>完成</Button>}>
    <FileVersionLabelEditor version={version} disabled={busy || conflict} onSave={async values => {
      pending.current = true;
      setBusy(true);
      try {
        const result = await fileDocumentApi.versionMetadataUpdate(binding, { object, versionId: version.id,
          expectedMetadataRevision: baseline.metadataRevision, ...values });
        if (!active.current) return;
        setBaseline({ ...baseline, ...result });
        setRefreshed(false);
        onUpdated(result);
        await queryClient.invalidateQueries({ queryKey: queryKeys.documentVersions(Number(object.id)) });
      } catch (cause) {
        if (active.current && cause instanceof AgentApiError && cause.code === "REVISION_CONFLICT") setConflict(true);
        throw cause;
      } finally {
        pending.current = false;
        if (active.current) setBusy(false);
      }
    }} />
    {conflict ? <div className="mt-3 grid gap-2">
      <p className="text-body text-text-muted">版本标记已变化。请先读取最新标记，再确认是否保存当前输入。</p>
      <Button type="button" disabled={busy} onClick={() => void refresh()}>读取最新标记</Button>
    </div> : null}
    {refreshed ? <p role="status" className="mt-3 text-body text-text-muted">最新名称：{baseline.displayName ?? "无自定义名称"}；{baseline.isImportant ? "重要版本" : "普通版本"}。当前输入已保留，请确认后保存。</p> : null}
    {refreshError ? <p role="alert" className="mt-3 text-body text-danger">{refreshError}</p> : null}
  </Dialog>;
}
