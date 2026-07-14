import { Circle } from "lucide-react";

import { tagColorValue } from "../../lib/constants";
import type { TagColorKey } from "../../lib/types";
import { cn } from "../../ui/lib/cn";

export interface TagFilterOption {
  id: number;
  label: string;
  colorKey: TagColorKey;
  count: number;
}

interface TagFilterBarProps {
  tags: TagFilterOption[];
  selectedTagIds: number[];
  onToggleTag: (tagId: number) => void;
  onClear: () => void;
}

export function TagFilterBar({
  tags,
  selectedTagIds,
  onToggleTag,
  onClear,
}: TagFilterBarProps) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <button
          type="button"
          className={cn(
            "rounded-[var(--radius-6)] border px-2.5 py-1 text-ui transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)]",
            selectedTagIds.length === 0
              ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg))] text-accent"
              : "border-border bg-bg text-text-muted hover:border-border-strong hover:bg-bg-hover hover:text-text",
          )}
          onClick={onClear}
        >
          全部
        </button>

        {tags.map((tag) => {
          const selected = selectedTagIds.includes(tag.id);
          return (
            <button
              key={tag.id}
              type="button"
              className={cn(
                "inline-flex items-center gap-2 rounded-[var(--radius-6)] border px-2.5 py-1 text-ui transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)]",
                selected
                  ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-bg))] text-text"
                  : "border-border bg-bg text-text-muted hover:border-border-strong hover:bg-bg-hover hover:text-text",
              )}
              onClick={() => onToggleTag(tag.id)}
            >
              <Circle
                size={10}
                className="fill-current"
                style={{ color: tagColorValue(tag.colorKey) }}
                aria-hidden="true"
              />
              <span>{tag.label}</span>
              <span className="text-text-soft">{tag.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
