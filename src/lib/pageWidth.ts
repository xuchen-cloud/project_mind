import type { PageWidthMode } from "../state/ui-store";
import { cn } from "../ui/lib/cn";

type PageWidthPreset = "overview" | "history" | "focus";

const PAGE_WIDTH_CLASS_MAP: Record<PageWidthPreset, Record<PageWidthMode, string>> = {
  overview: {
    adaptive: "max-w-6xl",
    narrow: "max-w-4xl",
    wide: "max-w-[88rem]",
    full: "max-w-none",
  },
  history: {
    adaptive: "project-overview-focus__page--history-adaptive",
    narrow: "project-overview-focus__page--history-narrow",
    wide: "project-overview-focus__page--history-wide",
    full: "project-overview-focus__page--full",
  },
  focus: {
    adaptive: "project-overview-focus__page--adaptive",
    narrow: "project-overview-focus__page--narrow",
    wide: "project-overview-focus__page--wide",
    full: "project-overview-focus__page--full",
  },
};

export function pageWidthContainerClass(mode: PageWidthMode, preset: PageWidthPreset) {
  return PAGE_WIDTH_CLASS_MAP[preset][mode];
}

export function withPageWidthClass(
  baseClassName: string,
  mode: PageWidthMode,
  preset: PageWidthPreset,
) {
  return cn(baseClassName, pageWidthContainerClass(mode, preset));
}
