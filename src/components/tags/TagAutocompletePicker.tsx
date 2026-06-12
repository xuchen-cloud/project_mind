import { useMemo, useState, type KeyboardEvent } from "react";
import { Circle, Plus, X } from "lucide-react";

import { fileTagColorValue } from "../../lib/constants";
import { colorKeyForTagLabel, findTagByLabel } from "../../lib/tags";
import type { DocumentTagRecord, FileTagRecord } from "../../lib/types";
import { projectMindApi } from "../../services/projectMindApi";
import { cn } from "../../ui/lib/cn";
import { buildTagSuggestions } from "./EntityTagEditor";

interface TagAutocompletePickerProps {
  projectId: number;
  availableTags: FileTagRecord[];
  selectedTagIds: number[];
  busy?: boolean;
  compact?: boolean;
  placeholder?: string;
  onChange: (tagIds: number[]) => Promise<unknown> | void;
  onCreated?: (tag: FileTagRecord) => void;
}

export function TagAutocompletePicker({
  projectId,
  availableTags,
  selectedTagIds,
  busy = false,
  compact = false,
  placeholder = "#标签",
  onChange,
  onCreated,
}: TagAutocompletePickerProps) {
  const [input, setInput] = useState("");
  const [creating, setCreating] = useState(false);
  const selectedIds = useMemo(() => new Set(selectedTagIds), [selectedTagIds]);
  const selectedTags = useMemo(
    () =>
      selectedTagIds
        .map((tagId) => availableTags.find((tag) => tag.id === tagId))
        .filter((tag): tag is FileTagRecord => tag !== undefined)
        .map(
          (tag): DocumentTagRecord => ({
            id: tag.id,
            label: tag.label,
            colorKey: tag.colorKey,
          }),
        ),
    [availableTags, selectedTagIds],
  );
  const query = input.trim().replace(/^#/, "");
  const suggestions = useMemo(
    () => buildTagSuggestions(availableTags, selectedIds, query),
    [availableTags, query, selectedIds],
  );

  const createTag = async (label: string) => {
    try {
      setCreating(true);
      const tag = await projectMindApi.fileTagOptionUpsert({
        projectId,
        label,
        colorKey: colorKeyForTagLabel(label),
      });
      onCreated?.(tag);
      return tag;
    } finally {
      setCreating(false);
    }
  };

  const commitLabel = async (rawLabel: string) => {
    const label = rawLabel.trim().replace(/^#/, "");
    if (!label || busy || creating) return;

    const existing = findTagByLabel(availableTags, label);
    const tag = existing ?? (await createTag(label));
    if (!tag) {
      setInput("");
      return;
    }

    const nextTagIds = selectedIds.has(tag.id)
      ? selectedTagIds.filter((id) => id !== tag.id)
      : [...selectedTagIds, tag.id];
    await onChange(nextTagIds);
    setInput("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitLabel(suggestions[0]?.label ?? query);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setInput("");
    }
  };

  return (
    <div className="relative grid gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {selectedTags.map((tag) => (
          <button
            key={tag.id}
            type="button"
            className="inline-flex max-w-[12rem] items-center gap-1 rounded-[var(--radius-6)] bg-bg-subtle px-1.5 py-0.5 text-caption text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
            disabled={busy}
            onClick={() => onChange(selectedTagIds.filter((id) => id !== tag.id))}
          >
            <Circle
              size={8}
              className="shrink-0 fill-current"
              style={{ color: fileTagColorValue(tag.colorKey) }}
              aria-hidden="true"
            />
            <span className="truncate">{tag.label}</span>
            <X size={10} aria-hidden="true" />
          </button>
        ))}
        <label
          className={cn(
            "inline-flex min-w-[7rem] items-center gap-1 rounded-[var(--radius-6)] border border-transparent bg-transparent px-1.5 py-0.5 text-caption text-text-soft transition-colors focus-within:border-border focus-within:bg-bg",
            compact ? "max-w-[10rem]" : "max-w-full",
          )}
        >
          <Plus size={11} aria-hidden="true" />
          <input
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-text-soft"
            value={input}
            disabled={busy || creating}
            placeholder={placeholder}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              if (query) void commitLabel(query);
            }}
          />
        </label>
      </div>
      {suggestions.length > 0 && input.trim().length > 0 ? (
        <div className="absolute left-0 top-[calc(100%+4px)] z-30 grid min-w-40 gap-1 rounded-[var(--radius-8)] border border-border bg-bg p-1 shadow-[var(--shadow-md)]">
          {suggestions.map((tag) => (
            <button
              key={tag.id}
              type="button"
              className="flex items-center gap-2 rounded-[var(--radius-6)] px-2 py-1 text-left text-ui text-text-muted hover:bg-bg-hover hover:text-text"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void commitLabel(tag.label)}
            >
              <Circle
                size={8}
                className="fill-current"
                style={{ color: fileTagColorValue(tag.colorKey) }}
              />
              <span className="truncate">{tag.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
