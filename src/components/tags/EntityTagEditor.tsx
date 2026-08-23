import { useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { Circle, Plus, X } from "lucide-react";

import { tagColorValue } from "../../lib/constants";
import { colorKeyForTagLabel, findTagByLabel } from "../../lib/tags";
import type { DocumentTagRecord, ProjectTagRecord } from "../../lib/types";
import { projectMindApi } from "../../services/projectMindApi";
import { cn } from "../../ui/lib/cn";

interface EntityTagEditorProps {
  projectId?: number | null;
  availableTags: ProjectTagRecord[];
  tags: DocumentTagRecord[];
  busy?: boolean;
  compact?: boolean;
  mode?: "full" | "edit" | "display";
  inputRef?: Ref<HTMLInputElement>;
  onChange: (tagIds: number[]) => Promise<unknown> | void;
  onCreated?: (tag: ProjectTagRecord) => void;
  onPendingChange?: (pending: boolean) => void;
  onCommitSettled?: (error: unknown | null) => void;
  onCommitNavigation?: (reason: "tab" | "enter") => Promise<unknown> | void;
}

export function EntityTagEditor({
  projectId,
  availableTags,
  tags,
  busy = false,
  compact = false,
  mode = "full",
  inputRef,
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
            style={{
              backgroundColor: `color-mix(in srgb, ${tagColorValue(tag.colorKey)} 12%, transparent)`,
              color: tagColorValue(tag.colorKey),
            }}
            disabled={busy}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange(tags.filter((item) => item.id !== tag.id).map((item) => item.id))}
          >
            <Circle
              size={8}
              className="entity-tag-chip__dot shrink-0 fill-current"
              aria-hidden="true"
            />
            <span className="truncate">{tag.label}</span>
            <X size={10} aria-hidden="true" />
          </button>
        ) : (
          <span
            key={tag.id}
            className="entity-tag-chip max-w-[12rem]"
            style={{
              backgroundColor: `color-mix(in srgb, ${tagColorValue(tag.colorKey)} 12%, transparent)`,
              color: tagColorValue(tag.colorKey),
            }}
          >
            <Circle
              size={8}
              className="entity-tag-chip__dot shrink-0 fill-current"
              aria-hidden="true"
            />
            <span className="truncate">{tag.label}</span>
          </span>
        )
      ))}
      {canCreate ? (
        <label
          className={cn(
            "entity-tag-chip entity-tag-chip--input",
            compact ? "max-w-[10rem]" : "max-w-[16rem]",
          )}
        >
          <Plus size={11} aria-hidden="true" />
          <input
            ref={handleInputRef}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-text-soft"
            value={input}
            disabled={busy || creating}
            placeholder="#标签"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              if (query) void commitLabel(query);
            }}
          />
        </label>
      ) : null}
      {canCreate && suggestions.length > 0 && input.trim().length > 0 ? (
        <div className="absolute left-0 top-[calc(100%+4px)] z-30 grid min-w-40 gap-1 rounded-[var(--radius-8)] border border-border bg-bg p-1 shadow-[var(--shadow-md)]">
          {suggestions.map((tag) => (
            <button
              key={tag.id}
              type="button"
              className="entity-tag-chip entity-tag-chip--interactive w-full justify-start text-left"
              style={{
                backgroundColor: `color-mix(in srgb, ${tagColorValue(tag.colorKey)} 12%, transparent)`,
                color: tagColorValue(tag.colorKey),
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void commitLabel(tag.label)}
            >
              <Circle
                size={8}
                className="entity-tag-chip__dot fill-current"
              />
              <span className="truncate">{tag.label}</span>
            </button>
          ))}
        </div>
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
