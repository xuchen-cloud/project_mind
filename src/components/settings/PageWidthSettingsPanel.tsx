import { Columns2, LayoutPanelTop, PanelLeftClose, StretchHorizontal } from "lucide-react";

import { useUiStore, type PageWidthMode } from "../../state/ui-store";
import { cn } from "../../ui/lib/cn";

const PAGE_WIDTH_OPTIONS: Array<{
  value: PageWidthMode;
  label: string;
  description: string;
  icon: typeof Columns2;
}> = [
  {
    value: "adaptive",
    label: "自适应",
    description: "按页面类型使用默认阅读宽度，兼顾信息密度和可读性。",
    icon: PanelLeftClose,
  },
  {
    value: "full",
    label: "全宽",
    description: "尽量铺满内容区域，适合表格、长列表和并排信息。",
    icon: StretchHorizontal,
  },
  {
    value: "wide",
    label: "宽",
    description: "提供更宽的编辑与浏览区域，减少换行。",
    icon: LayoutPanelTop,
  },
  {
    value: "narrow",
    label: "窄",
    description: "使用更收束的页面宽度，适合沉浸式阅读和写作。",
    icon: Columns2,
  },
];

export function PageWidthSettingsPanel() {
  const pageWidthMode = useUiStore((state) => state.pageWidthMode);
  const setPageWidthMode = useUiStore((state) => state.setPageWidthMode);

  return (
    <div className="grid gap-4" data-testid="page-width-settings-panel">
      <div className="grid gap-1">
        <h2 className="text-title font-semibold text-text">页面宽度</h2>
        <p className="text-body leading-6 text-text-soft">
          控制 Workspace、项目页的 QuickNote / Record，以及专注编辑页的内容宽度。
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {PAGE_WIDTH_OPTIONS.map((option) => {
          const Icon = option.icon;
          const active = option.value === pageWidthMode;

          return (
            <button
              key={option.value}
              type="button"
              className={cn(
                "grid gap-2 rounded-[var(--radius-8)] border px-4 py-3 text-left transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)]",
                active
                  ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-text"
                  : "border-border bg-bg text-text-soft hover:border-border-strong hover:bg-bg-hover hover:text-text",
              )}
              aria-pressed={active}
              onClick={() => setPageWidthMode(option.value)}
            >
              <div className="flex items-center gap-2">
                <Icon size={16} className={active ? "text-accent" : "text-text-soft"} />
                <span className="text-body font-medium">{option.label}</span>
              </div>
              <p className="text-ui leading-6 text-text-soft">{option.description}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
