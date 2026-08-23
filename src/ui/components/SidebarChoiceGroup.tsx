import { useRef, type CSSProperties, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { getRovingTabTargetIndex } from "../rovingTabs";

type ChoiceValue = string | number;

export interface SidebarChoice<TValue extends ChoiceValue> {
  value: TValue;
  label: ReactNode;
}

interface SidebarTabsProps<TValue extends ChoiceValue> {
  ariaLabel: string;
  value: TValue;
  options: ReadonlyArray<SidebarChoice<TValue>>;
  onValueChange: (value: TValue) => void;
}

export function SidebarTabs<TValue extends ChoiceValue>({
  ariaLabel,
  value,
  options,
  onValueChange,
}: SidebarTabsProps<TValue>) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function selectAndFocus(index: number) {
    const option = options[index];
    if (!option) return;

    onValueChange(option.value);
    tabRefs.current[index]?.focus();
  }

  return (
    <div
      className="grid shrink-0 grid-cols-[repeat(var(--sidebar-tab-count),minmax(0,1fr))] rounded-[var(--radius-8)] bg-bg p-1"
      style={{ "--sidebar-tab-count": options.length } as CSSProperties}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
    >
      {options.map((option, index) => {
        const selected = option.value === value;

        return (
          <button
            key={option.value}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={cn(
              "rounded-[var(--radius-6)] px-2 py-1.5 text-ui font-medium",
              selected
                ? "bg-bg-subtle text-text shadow-[var(--shadow-sm)]"
                : "text-text-soft hover:text-text",
            )}
            onClick={() => onValueChange(option.value)}
            onKeyDown={(event) => {
              const nextIndex = getRovingTabTargetIndex({
                key: event.key,
                currentIndex: index,
                itemCount: options.length,
              });

              if (nextIndex === null) return;
              event.preventDefault();
              selectAndFocus(nextIndex);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

interface SidebarFiltersProps<TValue extends ChoiceValue> {
  ariaLabel: string;
  value: TValue | null;
  options: ReadonlyArray<SidebarChoice<TValue>>;
  onValueChange: (value: TValue | null) => void;
}

export function SidebarFilters<TValue extends ChoiceValue>({
  ariaLabel,
  value,
  options,
  onValueChange,
}: SidebarFiltersProps<TValue>) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={ariaLabel}>
      <SidebarFilterButton
        selected={value === null}
        onClick={() => onValueChange(null)}
      >
        全部
      </SidebarFilterButton>
      {options.map((option) => {
        const selected = option.value === value;

        return (
          <SidebarFilterButton
            key={option.value}
            selected={selected}
            onClick={() => onValueChange(selected ? null : option.value)}
          >
            {option.label}
          </SidebarFilterButton>
        );
      })}
    </div>
  );
}

function SidebarFilterButton({
  children,
  selected,
  onClick,
}: {
  children: ReactNode;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "rounded-[var(--radius-6)] border px-2 py-1 text-caption transition-colors",
        selected
          ? "border-border-strong bg-bg text-text"
          : "border-transparent text-text-soft hover:border-border hover:bg-bg-hover hover:text-text",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
