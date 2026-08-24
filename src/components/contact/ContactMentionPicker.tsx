import { useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { UserPlus, UserRound } from "lucide-react";

import type { ContactRecord } from "../../lib/types";
import { projectMindApi } from "../../services/projectMindApi";
import { PopoverPanel } from "../../ui/components";
import { cn } from "../../ui/lib/cn";

interface UseContactMentionSearchOptions {
  open: boolean;
  query: string;
  limit?: number;
}

export function useContactMentionSearch({
  open,
  query,
  limit = 8,
}: UseContactMentionSearchOptions) {
  const [results, setResults] = useState<ContactRecord[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setResults((current) => (current.length > 0 ? [] : current));
      setLoading((current) => (current ? false : current));
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const nextResults = await projectMindApi.contactSearch({ query, limit });
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
  }, [limit, open, query]);

  return { results, loading };
}

export function ContactMentionPicker({
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
  results: ContactRecord[];
  activeIndex: number;
  query: string;
  canCreate: boolean;
  className?: string;
  style?: CSSProperties;
  portal?: boolean;
  onHoverIndex?: (index: number) => void;
  onSelect: (contact: ContactRecord) => void;
  onCreate?: (name: string) => void;
}) {
  if (!open) {
    return null;
  }

  // The create row, when shown, occupies the index just past the search hits so
  // keyboard navigation can reach it as a normal option.
  const createIndex = results.length;
  const showCreateRow = canCreate && Boolean(onCreate);

  const content = (
    <PopoverPanel
      className={cn(
        "contact-mention-picker w-[min(26rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] p-1",
        className,
      )}
      style={style}
    >
      <div
        role="listbox"
        aria-label="联系人选择器"
        className="grid max-h-72 min-w-[15rem] gap-0.5 overflow-x-hidden overflow-y-auto"
      >
        {loading ? (
          <div className="px-2.5 py-2 text-ui text-text-soft">正在搜索联系人...</div>
        ) : (
          <>
            {results.map((contact, index) => (
              <button
                key={`contact:${contact.id}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={cn(
                  "contact-mention-picker__item w-full rounded-[var(--radius-6)] px-2.5 py-1.5 text-left transition-colors duration-[var(--duration-standard)] ease-[var(--ease-soft)]",
                  index === activeIndex
                    ? "bg-[color-mix(in_srgb,var(--color-accent)_12%,var(--color-bg))]"
                    : "hover:bg-bg-hover",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHoverIndex?.(index)}
                onFocus={() => onHoverIndex?.(index)}
                onClick={() => onSelect(contact)}
              >
                <div className="flex items-start gap-2.5">
                  <span className="shrink-0 pt-0.5 text-accent">
                    <UserRound size={14} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className="text-[13px] font-medium leading-4.5 text-text [overflow-wrap:anywhere]"
                      title={contact.name}
                    >
                      {contact.name}
                    </p>
                    <p
                      className="mt-0.5 text-[11px] leading-4 text-text-soft [overflow-wrap:anywhere]"
                      title={buildContactSubtitle(contact)}
                    >
                      {buildContactSubtitle(contact)}
                    </p>
                  </div>
                </div>
              </button>
            ))}

            {showCreateRow ? (
              <button
                type="button"
                role="option"
                aria-selected={createIndex === activeIndex}
                className={cn(
                  "contact-mention-picker__item w-full rounded-[var(--radius-6)] px-2.5 py-1.5 text-left transition-colors duration-[var(--duration-standard)] ease-[var(--ease-soft)]",
                  createIndex === activeIndex
                    ? "bg-[color-mix(in_srgb,var(--color-accent)_12%,var(--color-bg))]"
                    : "hover:bg-bg-hover",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHoverIndex?.(createIndex)}
                onFocus={() => onHoverIndex?.(createIndex)}
                onClick={() => onCreate?.(query.trim())}
              >
                <div className="flex items-center gap-2.5">
                  <span className="shrink-0 text-accent">
                    <UserPlus size={14} />
                  </span>
                  <p className="min-w-0 flex-1 text-[13px] leading-4.5 text-text">
                    新建联系人 “{query.trim()}”
                  </p>
                </div>
              </button>
            ) : null}

            {results.length === 0 && !showCreateRow ? (
              <div className="px-2.5 py-2 text-ui text-text-soft">没有匹配的联系人。</div>
            ) : null}
          </>
        )}
      </div>
    </PopoverPanel>
  );

  if (portal && typeof document !== "undefined") {
    return createPortal(content, document.body);
  }

  return content;
}

function buildContactSubtitle(contact: ContactRecord) {
  const parts = [contact.role, contact.department, contact.email, contact.employeeId].filter(
    (part) => part.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : "联系人";
}
