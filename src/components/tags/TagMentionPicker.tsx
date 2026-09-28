import "../../ui/components/recommendation.css";
import { useEffect, useState, type RefObject, type CSSProperties } from "react";
import { AnchoredPicker } from "../../ui/components/AnchoredPicker";
import { createPortal } from "react-dom";

import type { ProjectTagRecord } from "../../lib/types";
import { projectMindApi } from "../../services/projectMindApi";
import { cn } from "../../ui/lib/cn";
import { buildTagSuggestions } from "./EntityTagEditor";

const EMPTY_SELECTED_TAG_IDS: number[] = [];

interface UseTagMentionSearchOptions {
  open: boolean;
  query: string;
  projectId: number | null | undefined;
  availableTags?: ProjectTagRecord[];
  selectedTagIds?: number[];
  limit?: number;
}

export function useTagMentionSearch({
  open,
  query,
  projectId,
  availableTags,
  selectedTagIds = EMPTY_SELECTED_TAG_IDS,
  limit = 8,
}: UseTagMentionSearchOptions) {
  const [results, setResults] = useState<ProjectTagRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const selectedTagIdsKey = selectedTagIds.join(",");

  useEffect(() => {
    if (!open) {
      setResults((current) => (current.length > 0 ? [] : current));
      setLoading((current) => (current ? false : current));
      return;
    }

    if (availableTags) {
      setResults(
        buildTagSuggestions(availableTags, new Set(selectedTagIds), query).slice(0, limit),
      );
      setLoading(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const snapshot =
          typeof projectId === "number"
            ? await projectMindApi.projectTagSettingsGet({ projectId })
            : await projectMindApi.projectTagSettingsGet({});
        const suggestions = buildTagSuggestions(
          snapshot.tags,
          new Set(selectedTagIds),
          query,
        ).slice(0, limit);
        if (!cancelled) {
          setResults(suggestions);
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
  }, [availableTags, limit, open, projectId, query, selectedTagIds, selectedTagIdsKey]);

  return { results, loading };
}

export function TagMentionPicker({
  open,
  loading,
  results,
  activeIndex,
  query,
  canCreate,
  className,
  style,
  portal = false,
  anchorRef,
  onHoverIndex,
  onSelect,
  onCreate,
}: {
  open: boolean;
  loading: boolean;
  results: ProjectTagRecord[];
  activeIndex: number;
  query: string;
  canCreate: boolean;
  className?: string;
  style?: CSSProperties;
  portal?: boolean;
  anchorRef?: RefObject<HTMLElement | null>;
  onHoverIndex?: (index: number) => void;
  onSelect: (tag: ProjectTagRecord) => void;
  onCreate?: (label: string) => void;
}) {
  if (!open) {
    return null;
  }

  const content = (
    <div
      className={cn(
        "tag-mention-picker recommendation-panel",
        className,
      )}
      style={style}
    >
      <div
        role="listbox"
        aria-label="标签选择器"
        className="recommendation-list"
      >
        {loading ? (
          <div className="recommendation-empty">正在搜索标签...</div>
        ) : results.length > 0 || canCreate ? (
          <>
            {results.map((tag, index) => (
              <button
                key={`tag:${tag.id}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className="tag-mention-picker__item recommendation-item"
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHoverIndex?.(index)}
                onFocus={() => onHoverIndex?.(index)}
                onClick={() => onSelect(tag)}
              >
                <div className="recommendation-row">
                  <span className="recommendation-icon" aria-hidden="true">#</span>
                  <div className="recommendation-copy">
                    <p
                      className="recommendation-title"
                      title={tag.label}
                    >
                      {tag.label}
                    </p>
                  </div>
                </div>
              </button>
            ))}
            {canCreate ? (
              <button
                type="button"
                role="option"
                aria-selected={activeIndex === results.length}
                className="tag-mention-picker__item recommendation-item"
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHoverIndex?.(results.length)}
                onFocus={() => onHoverIndex?.(results.length)}
                onClick={() => onCreate?.(query.trim())}
              >
                <div className="recommendation-row">
                  <span className="recommendation-icon" aria-hidden="true">#</span>
                  <div className="recommendation-copy">
                    <p className="recommendation-title">
                      新建标签 “{query.trim()}”
                    </p>
                  </div>
                </div>
              </button>
            ) : null}
          </>
        ) : (
          <div className="recommendation-empty">没有匹配的标签。</div>
        )}
      </div>
    </div>
  );

  if (anchorRef) return <AnchoredPicker anchorRef={anchorRef}>{content}</AnchoredPicker>;

  if (portal && typeof document !== "undefined") {
    return createPortal(content, document.body);
  }

  return content;
}
