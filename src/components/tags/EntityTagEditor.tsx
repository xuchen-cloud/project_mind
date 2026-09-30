import "./entity-tags.css";
import "../../ui/components/recommendation.css";
import { useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { X } from "lucide-react";

import { colorKeyForTagLabel, findTagByLabel } from "../../lib/tags";
import type { DocumentTagRecord, ProjectTagRecord } from "../../lib/types";
import { projectMindApi } from "../../services/projectMindApi";
import { AnchoredPicker } from "../../ui/components/AnchoredPicker";
import { cn } from "../../ui/lib/cn";

interface EntityTagEditorProps {
  revealInput?: boolean;
  projectId?: number | null;
  availableTags: ProjectTagRecord[];
  tags: DocumentTagRecord[];
  busy?: boolean;
  compact?: boolean;
  mode?: "full" | "edit" | "display";
  inputRef?: Ref<HTMLInputElement>;
  inputPlaceholder?: string;
  onChange: (tagIds: number[]) => Promise<unknown> | void;
  onCreated?: (tag: ProjectTagRecord) => void;
  onPendingChange?: (pending: boolean) => void;
  onCommitSettled?: (error: unknown | null) => void;
  onCommitNavigation?: (reason: "tab" | "enter") => Promise<unknown> | void;
}

export function EntityTagEditor({
  revealInput = false,
  projectId,
  availableTags,
  tags,
  busy = false,
  compact = false,
  mode = "full",
  inputRef,
  inputPlaceholder = "新增标签",
  onChange,
  onCreated,
  onPendingChange,
  onCommitSettled,
  onCommitNavigation,
}: EntityTagEditorProps) {
  const [input, setInput] = useState("");
  const [creating, setCreating] = useState(false);
  const localInputRef = useRef<HTMLInputElement | null>(null);
  const selectedIds = useMemo(() => new Set(tags.map((tag) => tag.id)), [tags]);
  const query = input.trim().replace(/^#/, "");
  const canRemove = mode !== "display";
  const canCreate = mode === "full";
  const suggestions = useMemo(
    () => buildTagSuggestions(availableTags, selectedIds, query),
    [availableTags, query, selectedIds],
  );

  const commitLabel = async (rawLabel: string) => {
    const label = rawLabel.trim().replace(/^#/, "");
    if (!label || busy || creating) return false;

    setCreating(true);
    onPendingChange?.(true);
    let commitError: unknown | null = null;
    try {
      const existing = findTagByLabel(availableTags, label);
      const tag = existing ?? await createTag(label);
      if (!tag || selectedIds.has(tag.id)) {
        setInput("");
        return true;
      }

      await onChange([...tags.map((item) => item.id), tag.id]);
      setInput("");
      return true;
    } catch (error) {
      commitError = error;
      return false;
    } finally {
      setCreating(false);
      onPendingChange?.(false);
      onCommitSettled?.(commitError);
    }
  };

  const handleInputRef = (node: HTMLInputElement | null) => {
    localInputRef.current = node;
    setRef(inputRef, node);
  };

  const createTag = async (label: string) => {
    const tag = await projectMindApi.projectTagUpsert({
      projectId: projectId ?? null,
      label,
      colorKey: colorKeyForTagLabel(label),
    });
    onCreated?.(tag);
    return tag;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitLabel(suggestions[0]?.label ?? query).then((committed) => {
        if (committed) onCommitNavigation?.("enter");
      });
      return;
    }

    if (event.key === "Tab" && query) {
      event.preventDefault();
      void commitLabel(suggestions[0]?.label ?? query).then((committed) => {
        if (committed) {
          localInputRef.current?.focus();
          onCommitNavigation?.("tab");
        }
      });
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setInput("");
    }
  };

  return (
    <div className="relative entity-tag-list min-w-0 items-center">
      {tags.map((tag) => (
        canRemove ? (
          <button
            key={tag.id}
            type="button"
            aria-label={`移除标签 ${tag.label}`}
            className="entity-tag-chip entity-tag-chip--interactive max-w-[12rem]"
            disabled={busy}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange(tags.filter((item) => item.id !== tag.id).map((item) => item.id))}
          >
            <span aria-hidden="true">#</span>
            <span className="truncate">{tag.label}</span>
            <X size={10} aria-hidden="true" />
          </button>
        ) : (
          <span
            key={tag.id}
            className="entity-tag-chip max-w-[12rem]"
          >
            <span aria-hidden="true">#</span>
            <span className="truncate">{tag.label}</span>
          </span>
        )
      ))}
      {canCreate ? (
        <span className={revealInput ? "entity-tag-input-slot" : "contents"}>
        <label
          data-has-input={input.length > 0 || undefined}
          className={cn(
            "entity-tag-chip entity-tag-chip--input",
            revealInput && "entity-tag-chip--reveal",
            compact ? "max-w-[10rem]" : "max-w-[16rem]",
          )}
        >
          <span aria-hidden="true">#</span>
          <input
            ref={handleInputRef}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-text-soft"
            value={input}
            disabled={busy || creating}
            aria-label="新增标签"
            placeholder={inputPlaceholder.replace(/^#\s*/, "")}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              if (query) void commitLabel(query);
            }}
          />
        </label>
        </span>
      ) : null}
      {canCreate && suggestions.length > 0 && input.trim().length > 0 ? (
        <AnchoredPicker anchorRef={localInputRef}>
        <div className="tag-mention-picker recommendation-panel">
          {suggestions.map((tag) => (
            <button
              key={tag.id}
              type="button"
              className="recommendation-item"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void commitLabel(tag.label)}
            >
              <span className="recommendation-row">
                <span className="recommendation-icon" aria-hidden="true">#</span>
                <span className="recommendation-title recommendation-copy">{tag.label}</span>
              </span>
            </button>
          ))}
        </div>
        </AnchoredPicker>
      ) : null}
    </div>
  );
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) {
    return;
  }

  if (typeof ref === "function") {
    ref(value);
    return;
  }

  ref.current = value;
}

export function buildTagSuggestions(
  availableTags: ProjectTagRecord[],
  selectedIds: Set<number>,
  query: string,
) {
  if (!query) {
    return availableTags.filter((tag) => !selectedIds.has(tag.id)).slice(0, 5);
  }
  const normalized = query.toLocaleLowerCase("zh-Hans-CN");
  return availableTags
    .filter((tag) => !selectedIds.has(tag.id))
    .filter((tag) => tag.label.toLocaleLowerCase("zh-Hans-CN").includes(normalized))
    .slice(0, 5);
}
