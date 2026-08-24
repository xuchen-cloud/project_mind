import { useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Circle, Hash } from "lucide-react";

import { tagColorValue } from "../../lib/constants";
import type { ProjectTagRecord } from "../../lib/types";
import { projectMindApi } from "../../services/projectMindApi";
import { PopoverPanel } from "../../ui/components";
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
  onHoverIndex?: (index: number) => void;
  onSelect: (tag: ProjectTagRecord) => void;
  onCreate?: (label: string) => void;
}) {
  if (!open) {
    return null;
  }

  const content = (
    <PopoverPanel
      className={cn(
        "tag-mention-picker w-[min(24rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] p-1",
        className,
      )}
      style={style}
    >
      <div
        role="listbox"
        aria-label="标签选择器"
        className="grid max-h-72 min-w-[14rem] gap-0.5 overflow-x-hidden overflow-y-auto"
      >
        {loading ? (
          <div className="px-2.5 py-2 text-ui text-text-soft">正在搜索标签...</div>
        ) : results.length > 0 || canCreate ? (
          <>
            {results.map((tag, index) => (
              <button
                key={`tag:${tag.id}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={cn(
                  "tag-mention-picker__item w-full rounded-[var(--radius-6)] px-2.5 py-1.5 text-left transition-colors duration-[var(--duration-standard)] ease-[var(--ease-soft)]",
                  index === activeIndex
                    ? "bg-[color-mix(in_srgb,var(--color-accent)_12%,var(--color-bg))]"
                    : "hover:bg-bg-hover",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHoverIndex?.(index)}
                onFocus={() => onHoverIndex?.(index)}
                onClick={() => onSelect(tag)}
              >
                <div className="flex items-center gap-2.5">
                  <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium leading-4 text-text-soft">
                    <Hash size={13} className="text-accent" />
                    <Circle
                      size={8}
                      className="fill-current"
                      style={{ color: tagColorValue(tag.colorKey) }}
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className="text-[13px] font-medium leading-4.5 text-text [overflow-wrap:anywhere]"
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
                className={cn(
                  "tag-mention-picker__item w-full rounded-[var(--radius-6)] px-2.5 py-1.5 text-left transition-colors duration-[var(--duration-standard)] ease-[var(--ease-soft)]",
                  activeIndex === results.length
                    ? "bg-[color-mix(in_srgb,var(--color-accent)_12%,var(--color-bg))]"
                    : "hover:bg-bg-hover",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHoverIndex?.(results.length)}
                onFocus={() => onHoverIndex?.(results.length)}
                onClick={() => onCreate?.(query.trim())}
              >
                <div className="flex items-center gap-2.5">
                  <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium leading-4 text-accent">
                    <Hash size={13} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium leading-4.5 text-text [overflow-wrap:anywhere]">
                      新建标签 “{query.trim()}”
                    </p>
                  </div>
                </div>
              </button>
            ) : null}
          </>
        ) : (
          <div className="px-2.5 py-2 text-ui text-text-soft">没有匹配的标签。</div>
        )}
      </div>
    </PopoverPanel>
  );

  if (portal && typeof document !== "undefined") {
    return createPortal(content, document.body);
  }

  return content;
}
