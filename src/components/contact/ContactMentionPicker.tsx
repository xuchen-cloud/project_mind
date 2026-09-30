import "../../ui/components/recommendation.css";
import { useEffect, useState, type RefObject, type CSSProperties } from "react";
import { AnchoredPicker } from "../../ui/components/AnchoredPicker";
import { createPortal } from "react-dom";
import { UserPlus, UserRound } from "lucide-react";

import type { ContactRecord } from "../../lib/types";
import { projectMindApi } from "../../services/projectMindApi";
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
  anchorRef,
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
  anchorRef?: RefObject<HTMLElement | null>;
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
    <div
      className={cn(
        "contact-mention-picker recommendation-panel",
        className,
      )}
      style={style}
    >
      <div
        role="listbox"
        aria-label="联系人选择器"
        className="recommendation-list"
      >
        {loading ? (
          <div className="recommendation-empty">正在搜索联系人...</div>
        ) : (
          <>
            {results.map((contact, index) => (
              <button
                key={`contact:${contact.id}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className="contact-mention-picker__item recommendation-item"
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHoverIndex?.(index)}
                onFocus={() => onHoverIndex?.(index)}
                onClick={() => onSelect(contact)}
              >
                <div className="recommendation-row">
                  <span className="recommendation-icon">
                    <UserRound size={14} />
                  </span>
                  <div className="recommendation-copy">
                    <p
                      className="recommendation-title"
                      title={contact.name}
                    >
                      {contact.name}
                    </p>
                    <p
                      className="recommendation-subtitle"
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
                className="contact-mention-picker__item recommendation-item"
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHoverIndex?.(createIndex)}
                onFocus={() => onHoverIndex?.(createIndex)}
                onClick={() => onCreate?.(query.trim())}
              >
                <div className="recommendation-row">
                  <span className="recommendation-icon">
                    <UserPlus size={14} />
                  </span>
                  <p className="recommendation-title recommendation-copy">
                    新建联系人 “{query.trim()}”
                  </p>
                </div>
              </button>
            ) : null}

            {results.length === 0 && !showCreateRow ? (
              <div className="recommendation-empty">没有匹配的联系人。</div>
            ) : null}
          </>
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

function buildContactSubtitle(contact: ContactRecord) {
  const parts = [contact.role, contact.department, contact.email, contact.employeeId].filter(
    (part) => part.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : "联系人";
}
