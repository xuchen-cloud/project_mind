import {
  Contact,
  Files,
  Pencil,
  RefreshCw,
  Settings2,
  Sparkles,
  StretchHorizontal,
} from "lucide-react";
import { Suspense, lazy, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";

import type { SettingsSection } from "../../state/ui-store";
import { useUiStore } from "../../state/ui-store";
import { Dialog } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import { PageWidthSettingsPanel } from "./PageWidthSettingsPanel";

const AiSettingsPanel = lazy(() =>
  import("./AiSettingsPanel").then((module) => ({ default: module.AiSettingsPanel })),
);
const ContactSettingsPanel = lazy(() =>
  import("./ContactSettingsPanel").then((module) => ({ default: module.ContactSettingsPanel })),
);
const ProjectTagSettingsPanel = lazy(() =>
  import("./ProjectTagSettingsPanel").then((module) => ({ default: module.ProjectTagSettingsPanel })),
);
const RichTextStylePanel = lazy(() =>
  import("./RichTextStylePanel").then((module) => ({ default: module.RichTextStylePanel })),
);
const UpdateSettingsPanel = lazy(() =>
  import("./UpdateSettingsPanel").then((module) => ({ default: module.UpdateSettingsPanel })),
);

interface SettingsDialogProps {
  open: boolean;
  activeSection: SettingsSection;
  projectId: number | null;
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
    value: "page-width",
    label: "页面宽度",
    icon: StretchHorizontal,
  },
  {
    value: "updates",
    label: "应用更新",
    icon: RefreshCw,
  },
  {
    value: "project-tags",
    label: "项目标签",
    icon: Files,
  },
  {
    value: "contacts",
    label: "联系人",
    icon: Contact,
  },
  {
    value: "ai-models",
    label: "AI 模型配置",
    icon: Settings2,
  },
  {
    value: "ai-rewrite",
    label: "AI 技能",
    icon: Pencil,
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
  projectId,
  onSectionChange,
  onUnlockAiSecrets,
  onClose,
}: SettingsDialogProps) {
  const availableSections = SETTINGS_SECTIONS.map((section) =>
    section.value === "project-tags"
      ? { ...section, label: projectId === null ? "Workspace 标签" : "项目标签" }
      : section,
  );

  const activePanel = (() => {
    switch (activeSection) {
      case "page-width":
        return <PageWidthSettingsPanel />;
      case "updates":
        return (
          <Suspense fallback={<SettingsPanelFallback />}>
            <UpdateSettingsPanel />
          </Suspense>
        );
      case "project-tags":
        return (
          <Suspense fallback={<SettingsPanelFallback />}>
            <ProjectTagSettingsPanel open={open} projectId={projectId} />
          </Suspense>
        );
      case "contacts":
        return (
          <Suspense fallback={<SettingsPanelFallback />}>
            <ContactSettingsPanel open={open} />
          </Suspense>
        );
      case "ai-models":
        return (
          <Suspense fallback={<SettingsPanelFallback />}>
            <AiSettingsPanel
              open={open}
              section="models"
              onUnlockAiSecrets={onUnlockAiSecrets}
            />
          </Suspense>
        );
      case "ai-rewrite":
        return (
          <Suspense fallback={<SettingsPanelFallback />}>
            <AiSettingsPanel
              open={open}
              section="rewrite"
              onUnlockAiSecrets={onUnlockAiSecrets}
            />
          </Suspense>
        );
      case "rich-text":
        return (
          <Suspense fallback={<SettingsPanelFallback />}>
            <RichTextStylePanel open={open} />
          </Suspense>
        );
    }
  })();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="设置"
      description={
        activeSection === "project-tags"
          ? projectId === null
            ? "当前更改只作用于这个 Workspace。"
            : "当前更改只作用于这个项目。"
          : activeSection === "updates"
            ? "检查并安装 ProjectMind 桌面版本更新。"
            : "当前更改只作用于本地 workspace。"
      }
      widthClassName="max-w-6xl"
      bodyClassName="px-0 py-0"
    >
      <div className="grid min-h-[34rem] gap-0 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <aside className="border-b border-border bg-bg-subtle/70 p-2.5 lg:border-b-0 lg:border-r">
          <nav className="grid gap-1.5" aria-label="设置分区">
            {availableSections.map((section) => {
              const Icon = section.icon;
              const active = section.value === activeSection;

              return (
                <button
                  key={section.value}
                  type="button"
                  className={cn(
                    "rounded-[var(--radius-8)] border px-3 py-2.5 text-left transition-[border-color,background-color,color] duration-[var(--duration-standard)] ease-[var(--ease-soft)]",
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
          <section
            aria-label={availableSections.find(
              (item) => item.value === activeSection,
            )?.label}
          >
            {activePanel}
          </section>
        </div>
      </div>
    </Dialog>
  );
}

function SettingsPanelFallback() {
  return (
    <div className="grid min-h-48 place-items-center text-sm text-text-muted" role="status">
      正在加载设置…
    </div>
  );
}

export function SettingsRouteBridge() {
  const navigate = useNavigate();
  const params = useParams();
  const openSettings = useUiStore((state) => state.openSettings);

  useEffect(() => {
    openSettings(normalizeSettingsSection(params.section), null);
    navigate("/projects", { replace: true });
  }, [navigate, openSettings, params.section]);

  return null;
}

function normalizeSettingsSection(section: string | undefined): SettingsSection {
  if (section === "updates") {
    return "updates";
  }
  if (section === "page-width") {
    return "page-width";
  }
  if (section === "rich-text") {
    return "rich-text";
  }
  if (section === "project-tags" || section === "file-tags") {
    return "project-tags";
  }
  if (section === "contacts") {
    return "contacts";
  }
  if (section === "ai" || section === "ai-models") {
    return "ai-models";
  }
  if (section === "ai-rewrite") {
    return "ai-rewrite";
  }
  return "page-width";
}
