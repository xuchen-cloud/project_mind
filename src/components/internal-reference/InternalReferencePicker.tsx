import { useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { FileText, ListTodo, NotebookPen } from "lucide-react";

import type {
  InternalReferenceContext,
  InternalReferenceSearchResult,
} from "../../lib/types";
import { getInternalReferenceKindLabel } from "../../lib/internalReferences";
import { projectMindApi } from "../../services/projectMindApi";
import { PopoverPanel } from "../../ui/components";
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
  onHoverIndex?: (index: number) => void;
  onSelect: (result: InternalReferenceSearchResult) => void;
}) {
  if (!open) {
    return null;
  }

  const content = (
    <PopoverPanel
      className={cn(
        "internal-reference-picker w-[min(30rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] p-1",
        className,
      )}
      style={style}
    >
      <div
        role="listbox"
        aria-label="内部引用选择器"
        className="grid max-h-72 min-w-[17rem] gap-0.5 overflow-x-hidden overflow-y-auto"
      >
        {loading ? (
          <div className="px-2.5 py-2 text-ui text-text-soft">正在搜索引用...</div>
        ) : results.length > 0 ? (
          results.map((result, index) => (
            <button
              key={`${result.kind}:${result.id}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={cn(
                "internal-reference-picker__item w-full rounded-[var(--radius-6)] px-2.5 py-1.5 text-left transition-colors duration-[var(--duration-standard)] ease-[var(--ease-soft)]",
                index === activeIndex
                  ? "bg-[color-mix(in_srgb,var(--color-accent)_12%,var(--color-bg))]"
                  : "hover:bg-bg-hover",
              )}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHoverIndex?.(index)}
              onFocus={() => onHoverIndex?.(index)}
              onClick={() => onSelect(result)}
            >
              <div className="flex items-start gap-2.5">
                <div className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap pt-0.5 text-[12px] font-medium leading-4 text-text-soft">
                  <span className="shrink-0 text-accent">{renderKindIcon(result.kind)}</span>
                  <span className="whitespace-nowrap">{getInternalReferenceKindLabel(result.kind)}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p
                    className="text-[13px] font-medium leading-4.5 text-text [overflow-wrap:anywhere]"
                    title={result.label}
                  >
                    {result.label}
                  </p>
                  <p
                    className="mt-0.5 text-[11px] leading-4 text-text-soft [overflow-wrap:anywhere]"
                    title={result.subtitle}
                  >
                    {result.subtitle}
                  </p>
                </div>
              </div>
            </button>
          ))
        ) : (
          <div className="px-2.5 py-2 text-ui text-text-soft">没有找到可引用的内容。</div>
        )}
      </div>
    </PopoverPanel>
  );

  if (portal && typeof document !== "undefined") {
    return createPortal(content, document.body);
  }

  return content;
}

function renderKindIcon(kind: InternalReferenceSearchResult["kind"]) {
  switch (kind) {
    case "note":
      return <NotebookPen size={13} />;
    case "todo":
      return <ListTodo size={13} />;
    case "document":
      return <FileText size={13} />;
  }
}
