import { Settings2, Sparkles, Tags } from "lucide-react";
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";

import type { SettingsSection } from "../../state/ui-store";
import { useUiStore } from "../../state/ui-store";
import { Dialog } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import { ActivitySettingsPanel } from "./ActivitySettingsPanel";
import { AiSettingsPanel } from "./AiSettingsPanel";
import { RichTextStylePanel } from "./RichTextStylePanel";

interface SettingsDialogProps {
  open: boolean;
  activeSection: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onClose: () => void;
}

const SETTINGS_SECTIONS: Array<{
  value: SettingsSection;
  label: string;
  description: string;
  icon: typeof Settings2;
}> = [
  {
    value: "activity",
    label: "活动标签",
    description: "活动属性与状态字典、提醒语义",
    icon: Tags,
  },
  {
    value: "ai",
    label: "AI 设置",
    description: "模型接入、能力绑定与安全存储",
    icon: Settings2,
  },
  {
    value: "rich-text",
    label: "富文本样式",
    description: "正文、标题和列表的全局排版",
    icon: Sparkles,
  },
];

export function SettingsDialog({
  open,
  activeSection,
  onSectionChange,
  onClose,
}: SettingsDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="设置"
      description="当前更改只作用于本地 workspace。"
      widthClassName="max-w-6xl"
      bodyClassName="px-0 py-0"
    >
      <div className="grid min-h-[36rem] gap-0 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="border-b border-border bg-bg-subtle/70 p-3 lg:border-b-0 lg:border-r">
          <nav className="grid gap-2" aria-label="设置分区">
            {SETTINGS_SECTIONS.map((section) => {
              const Icon = section.icon;
              const active = section.value === activeSection;

              return (
                <button
                  key={section.value}
                  type="button"
                  className={cn(
                    "rounded-[var(--radius-8)] border px-3 py-3 text-left transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)]",
                    active
                      ? "border-[color-mix(in_srgb,var(--color-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-text"
                      : "border-transparent bg-transparent text-text-muted hover:border-border hover:bg-bg hover:text-text",
                  )}
                  onClick={() => onSectionChange(section.value)}
                >
                  <div className="flex items-center gap-2">
                    <Icon size={14} className={active ? "text-accent" : "text-text-soft"} />
                    <span className="text-body font-medium">{section.label}</span>
                  </div>
                  <p className="mt-1 text-ui leading-5 text-text-soft">{section.description}</p>
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="min-w-0 p-4 sm:p-5">
          <section hidden={activeSection !== "activity"} aria-label="活动标签">
            <ActivitySettingsPanel open={open} />
          </section>
          <section hidden={activeSection !== "ai"} aria-label="AI 设置">
            <AiSettingsPanel open={open} />
          </section>
          <section hidden={activeSection !== "rich-text"} aria-label="富文本样式">
            <RichTextStylePanel open={open} />
          </section>
        </div>
      </div>
    </Dialog>
  );
}

export function SettingsRouteBridge() {
  const navigate = useNavigate();
  const params = useParams();
  const openSettings = useUiStore((state) => state.openSettings);

  useEffect(() => {
    openSettings(normalizeSettingsSection(params.section));
    navigate("/projects", { replace: true });
  }, [navigate, openSettings, params.section]);

  return null;
}

function normalizeSettingsSection(section: string | undefined): SettingsSection {
  if (section === "rich-text") {
    return "rich-text";
  }
  if (section === "ai") {
    return "ai";
  }
  return "activity";
}
