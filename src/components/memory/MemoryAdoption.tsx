import { useEffect, useId, useState } from "react";
import { memoryApi, type MemoryAdoption as Adoption } from "../../services/memoryApi";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { getErrorMessage } from "../../lib/errors";
import { HomeSidebarList } from "../home/HomeSidebarList";
import "./memory.css";

type Props = { workspaceRoot: string; projectId: number | null; sessionId: string; turn: number };
/** Identity changes remount the disclosure before any old answer data can render. */
export function MemoryAdoption(props: Props) {
  return <AnswerMemory key={JSON.stringify([props.workspaceRoot, props.projectId, props.sessionId, props.turn])} {...props} />;
}
function AnswerMemory({ workspaceRoot, projectId, sessionId, turn }: Props) {
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  const [adoptions, setAdoptions] = useState<Adoption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setLoading(true); setError(null);
    void recordDocumentApi.bindingGet(workspaceRoot).then(binding => memoryApi.adoption(binding,
      projectId === null ? { kind: "workspace" } : { kind: "project", projectId }, sessionId, turn))
      .then(value => { if (!cancelled) setAdoptions(value); })
      .catch(reason => { if (!cancelled) setError(getErrorMessage(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [expanded, workspaceRoot, projectId, sessionId, turn]);
  return <div className="memory-adoption">
    <button type="button" className="memory-adoption__toggle text-caption text-text-secondary" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>这次回答使用的记忆</button>
    <div id={contentId} className="memory-adoption__disclosure" data-expanded={expanded} aria-hidden={!expanded} inert={!expanded}>
    <div className="memory-adoption__content">
    {(expanded || adoptions !== null) && (loading ? <p role="status">正在读取…</p> : error ? <p role="alert">{error}</p> : adoptions?.length ? <HomeSidebarList label="这次回答的记忆" variant="todo">
      {adoptions.map(adoption => <section key={adoption.requestId}>
        <p className="text-caption text-text-secondary">步骤 {adoption.snapshot.step} · {new Date(adoption.adoptedAt).toLocaleTimeString()}</p>
        {adoption.snapshot.facts.map(fact => <p key={fact.id} className="text-ui">{fact.content}{fact.condition && <span className="text-text-secondary">（{fact.condition}）</span>}</p>)}
        {adoption.snapshot.facts.length === 0 && <p className="text-ui text-text-secondary">此步骤没有装入记忆</p>}
        <p className="text-caption text-text-secondary">{adoption.snapshot.omittedIds.length} 条因本次预算未装入，保存的记忆未变。</p>
      </section>)}
    </HomeSidebarList> : <p className="text-caption text-text-secondary">这次回答暂无记忆使用记录</p>)}
    </div>
    </div>
  </div>;
}
