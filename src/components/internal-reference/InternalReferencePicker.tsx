import "../../ui/components/recommendation.css";
import { useEffect, useState, type RefObject, type CSSProperties } from "react";
import { AnchoredPicker } from "../../ui/components/AnchoredPicker";
import { createPortal } from "react-dom";
import { FileText, ListTodo, NotebookPen } from "lucide-react";

import type {
  InternalReferenceContext,
  InternalReferenceSearchResult,
} from "../../lib/types";
import { getInternalReferenceKindLabel } from "../../lib/internalReferences";
import { HomeSidebarList } from "../home/HomeSidebarList";
import { projectMindApi } from "../../services/projectMindApi";
import { cn } from "../../ui/lib/cn";

interface UseInternalReferenceSearchOptions {
  open: boolean;
  query: string;
  context?: InternalReferenceContext | null;
  limit?: number;
}

export function useInternalReferenceSearch({
  open,
  query,
  context,
  limit = 8,
}: UseInternalReferenceSearchOptions) {
  const [results, setResults] = useState<InternalReferenceSearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !context) {
      setResults((current) => (current.length > 0 ? [] : current));
      setLoading((current) => (current ? false : current));
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const nextResults = await projectMindApi.internalReferenceSearch({
          query,
          projectId: context.projectId ?? null,
          scope: context.scope,
          limit,
        });

        if (!cancelled) {
          setResults(nextResults);
        }
      } catch {
        if (!cancelled) {
          setResults([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [context?.projectId, context?.scope, limit, open, query]);

  return { results, loading };
}

export function InternalReferencePicker({
  open,
  loading,
  results,
  activeIndex,
  className,
  style,
  portal = false,
  anchorRef,
  onHoverIndex,
  onSelect,
}: {
  open: boolean;
  loading: boolean;
  results: InternalReferenceSearchResult[];
  activeIndex: number;
  className?: string;
  style?: CSSProperties;
  portal?: boolean;
  anchorRef?: RefObject<HTMLElement | null>;
  onHoverIndex?: (index: number) => void;
  onSelect: (result: InternalReferenceSearchResult) => void;
}) {
  if (!open) {
    return null;
  }

  const content = (
    <div
      className={cn(
        "internal-reference-picker recommendation-panel",
        className,
      )}
      style={style}
    >
      <HomeSidebarList label="内部引用候选"><div
        role="listbox"
        aria-label="内部引用选择器"
        className="recommendation-list"
      >
        {loading ? (
          <div className="recommendation-empty">正在搜索引用...</div>
        ) : results.length > 0 ? (
          results.map((result, index) => (
            <button
              key={`${result.kind}:${result.id}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              aria-label={`${getInternalReferenceKindLabel(result.kind)} ${result.label} ${result.subtitle}`}
              className="internal-reference-picker__item recommendation-item"
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHoverIndex?.(index)}
              onFocus={() => onHoverIndex?.(index)}
              onClick={() => onSelect(result)}
            >
              <div className="recommendation-row">
                <span className="recommendation-icon">{renderKindIcon(result.kind)}</span>
                <div className="recommendation-copy">
                  <p
                    className="recommendation-title"
                    title={result.label}
                  >
                    {result.label}
                  </p>
                  <p
                    className="recommendation-subtitle"
                    title={result.subtitle}
                  >
                    {getInternalReferenceKindLabel(result.kind)}{result.subtitle ? ` · ${result.subtitle}` : ""}
                  </p>
                </div>
              </div>
            </button>
          ))
        ) : (
          <div className="recommendation-empty">没有找到可引用的内容。</div>
        )}
      </div></HomeSidebarList>
    </div>
  );

  if (anchorRef) return <AnchoredPicker anchorRef={anchorRef}>{content}</AnchoredPicker>;

  if (portal && typeof document !== "undefined") {
    return createPortal(content, document.body);
  }

  return content;
}

function renderKindIcon(kind: InternalReferenceSearchResult["kind"]) {
  switch (kind) {
    case "note":
    case "workspace_record":
      return <NotebookPen size={13} />;
    case "todo":
      return <ListTodo size={13} />;
    case "document":
      return <FileText size={13} />;
  }
}
