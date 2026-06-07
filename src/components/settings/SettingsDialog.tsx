import { Contact, FileText, Files, Settings2, Sparkles } from "lucide-react";
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";

import type { SettingsSection } from "../../state/ui-store";
import { useUiStore } from "../../state/ui-store";
import { Dialog } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import { AiSettingsPanel } from "./AiSettingsPanel";
import { ContactSettingsPanel } from "./ContactSettingsPanel";
import { FileTagSettingsPanel } from "./FileTagSettingsPanel";
import { RecordTypeSettingsPanel } from "./RecordTypeSettingsPanel";
import { RichTextStylePanel } from "./RichTextStylePanel";

interface SettingsDialogProps {
  open: boolean;
  activeSection: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onUnlockAiSecrets: () => Promise<boolean>;
  onClose: () => void;
}

const SETTINGS_SECTIONS: Array<{
  value: SettingsSection;
  label: string;
  icon: typeof Settings2;
}> = [
  {
    value: "file-tags",
    label: "项目标签",
    icon: Files,
  },
  {
    value: "record-types",
    label: "记录类型",
    icon: FileText,
  },
  {
    value: "contacts",
    label: "联系人",
    icon: Contact,
  },
  {
    value: "ai",
    label: "AI 设置",
    icon: Settings2,
  },
  {
    value: "rich-text",
    label: "富文本样式",
    icon: Sparkles,
  },
];

export function SettingsDialog({
  open,
  activeSection,
  onSectionChange,
  onUnlockAiSecrets,
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
      <div className="grid min-h-[34rem] gap-0 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <aside className="border-b border-border bg-bg-subtle/70 p-2.5 lg:border-b-0 lg:border-r">
          <nav className="grid gap-1.5" aria-label="设置分区">
            {SETTINGS_SECTIONS.map((section) => {
              const Icon = section.icon;
              const active = section.value === activeSection;

              return (
                <button
                  key={section.value}
                  type="button"
                  className={cn(
                    "rounded-[var(--radius-8)] border px-3 py-2.5 text-left transition-[border-color,background-color,color] duration-[160ms] ease-[var(--ease-soft)]",
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
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="min-w-0 p-3.5 sm:p-4">
          <section hidden={activeSection !== "file-tags"} aria-label="项目标签">
            <FileTagSettingsPanel open={open} />
          </section>
          <section hidden={activeSection !== "record-types"} aria-label="记录类型">
            <RecordTypeSettingsPanel open={open} />
          </section>
          <section hidden={activeSection !== "contacts"} aria-label="联系人">
            <ContactSettingsPanel open={open} />
          </section>
          <section hidden={activeSection !== "ai"} aria-label="AI 设置">
            <AiSettingsPanel open={open} onUnlockAiSecrets={onUnlockAiSecrets} />
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
  if (section === "file-tags") {
    return "file-tags";
  }
  if (section === "record-types") {
    return "record-types";
  }
  if (section === "contacts") {
    return "contacts";
  }
  if (section === "ai") {
    return "ai";
  }
  return "file-tags";
}
