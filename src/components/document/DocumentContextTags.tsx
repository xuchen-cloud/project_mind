import type { DocumentTagRecord, ProjectTagRecord } from "../../lib/types";
import { EntityTagEditor } from "../tags/EntityTagEditor";

/** The same compact chips and portaled recommendations used by records and todos. */
export function DocumentContextTags({ projectId, availableTags, tags, loading, onChange }: {
  projectId: number | null;
  availableTags: ProjectTagRecord[];
  tags: DocumentTagRecord[];
  loading: boolean;
  onChange: (tagIds: number[]) => Promise<unknown> | void;
}) {
  return <div className="mt-2 border-t border-border px-2 pt-2 pb-1"
    data-document-interactive="true"
    onPointerDown={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}>
    {loading ? <p className="text-ui text-text-soft">标签加载中...</p> :
      <EntityTagEditor projectId={projectId} availableTags={availableTags} tags={tags}
        compact revealInput inputPlaceholder="新增标签" onChange={onChange} />}
  </div>;
}
