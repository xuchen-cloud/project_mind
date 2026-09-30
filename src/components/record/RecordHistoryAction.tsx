import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { History } from "lucide-react";
import { Button } from "../../ui/components";
import type { AgentWorkspaceBinding } from "../../lib/agent-types";
import type { RecordTarget } from "../../lib/record-document-types";
import type { RichEditorAssetHandlers } from "../rich-editor";
import { recordDocumentApi } from "../../services/recordDocumentApi";

const RecordHistoryDialog = lazy(() => import("./RecordHistoryDialog"));
export function RecordHistoryAction({ binding, target, disabled, assetHandlers, onRestored }: {
  binding: AgentWorkspaceBinding | null; target: RecordTarget; disabled?: boolean;
  assetHandlers?: RichEditorAssetHandlers; onRestored: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opening = useRef(false);
  const mounted = useRef(true);
  const identity = useRef("");
  identity.current = `${binding?.workspaceId}:${binding?.generation}:${JSON.stringify(target)}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function openHistory() {
    if (!binding || opening.current) return;
    const capturedIdentity = identity.current;
    opening.current = true; setBusy(true); setError(null);
    try {
      const state = await recordDocumentApi.editorsFlush(binding,target);
      if (!mounted.current || identity.current !== capturedIdentity) return;
      await recordDocumentApi.checkpoint(binding,{ target, baseRevision: state.head.headRevision, reason: "open_history" });
      if (mounted.current && identity.current === capturedIdentity) setOpen(true);
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { opening.current = false; if (mounted.current) setBusy(false); }
  }
  return <>
    <Button type="button" size="sm" variant="ghost" leadingIcon={<History size={14} />} disabled={disabled || !binding || busy} onClick={() => void openHistory()}>{busy ? "准备历史…" : "版本历史"}</Button>
    {error ? <span role="alert" className="text-ui text-danger">{error}</span> : null}
    {open && binding ? <Suspense fallback={<p role="status" className="text-ui text-text-soft">正在加载版本历史…</p>}>
      <RecordHistoryDialog binding={binding} target={target} assetHandlers={assetHandlers} onClose={() => setOpen(false)} onRestored={onRestored} />
    </Suspense> : null}
  </>;
}
