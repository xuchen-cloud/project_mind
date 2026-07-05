import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { MoreHorizontal, Settings2 } from "lucide-react";

import { PopoverPanel } from "../../ui/components";

const MENU_WIDTH = 332;
const VIEWPORT_PADDING = 12;

export interface RichEditorAiMenuIconAction {
  key: string;
  label: string;
  icon: LucideIcon;
  active?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface RichEditorAiMenuTextAction {
  key: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

export interface RichEditorAiMenuSkillAction {
  id: string;
  label: string;
  icon?: string | null;
  disabled?: boolean;
  onSelect: () => void;
}

interface RichEditorAiMenuProps {
  x: number;
  y: number;
  primaryActions: RichEditorAiMenuIconAction[];
  moreActions: RichEditorAiMenuTextAction[];
  skills: RichEditorAiMenuSkillAction[];
  disabledReason?: string | null;
  onClose: () => void;
  onOpenSettings?: () => void;
  onSubmitPrompt: (prompt: string, resultMode: "modify" | "answer") => void;
}

export function RichEditorAiMenu({
  x,
  y,
  primaryActions,
  moreActions,
  skills,
  disabledReason,
  onClose,
  onOpenSettings,
  onSubmitPrompt,
}: RichEditorAiMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [prompt, setPrompt] = useState("");
  const [resultMode, setResultMode] = useState<"modify" | "answer">("modify");
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    setPrompt("");
    setResultMode("modify");
    setMoreOpen(false);
  }, [x, y]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const position = useMemo(() => {
    if (typeof window === "undefined") {
      return { left: x, top: y };
    }

    return {
      left: Math.min(
        Math.max(VIEWPORT_PADDING, x),
        Math.max(VIEWPORT_PADDING, window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING),
      ),
      top: Math.min(
        Math.max(VIEWPORT_PADDING, y),
        Math.max(VIEWPORT_PADDING, window.innerHeight - 420),
      ),
    };
  }, [x, y]);

  const submitDisabled =
    Boolean(disabledReason) || prompt.trim().length === 0;

  return (
    <PopoverPanel
      ref={rootRef}
      role="dialog"
      aria-label="AI 编辑菜单"
      className="rich-editor__ai-menu fixed z-[80] w-[20.75rem] p-0"
      style={position}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="rich-editor__ai-menu-toolbar" role="toolbar" aria-label="文本格式">
        {primaryActions.map((action) => (
          <button
            key={action.key}
            type="button"
            className={[
              "rich-editor__ai-menu-tool",
              action.active ? "is-active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-label={action.label}
            title={action.label}
            disabled={action.disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              action.onSelect();
            }}
          >
            <action.icon size={17} />
          </button>
        ))}
        <div className="rich-editor__ai-menu-more">
          <button
            type="button"
            className={[
              "rich-editor__ai-menu-tool",
              moreOpen ? "is-active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-label="更多格式操作"
            title="更多格式操作"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setMoreOpen((current) => !current)}
          >
            <MoreHorizontal size={17} />
          </button>
          {moreOpen ? (
            <PopoverPanel className="rich-editor__ai-menu-more-panel absolute right-0 top-[calc(100%+0.5rem)] z-[81] w-48 p-1.5">
              <div className="grid gap-1">
                {moreActions.map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    className="rich-editor__ai-menu-more-action"
                    disabled={action.disabled}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      action.onSelect();
                      setMoreOpen(false);
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            </PopoverPanel>
          ) : null}
        </div>
      </div>

      <div className="rich-editor__ai-menu-section">
        <div className="rich-editor__ai-menu-section-header">
          <span>技能</span>
          <button
            type="button"
            className="rich-editor__ai-menu-settings"
            aria-label="打开 AI 设置"
            title="打开 AI 设置"
            disabled={!onOpenSettings}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onOpenSettings?.()}
          >
            <Settings2 size={16} />
          </button>
        </div>
        <div className="rich-editor__ai-menu-skills" role="list" aria-label="AI 技能列表">
          {skills.length > 0 ? (
            skills.map((skill) => (
              <button
                key={skill.id}
                type="button"
                className="rich-editor__ai-menu-skill"
                disabled={skill.disabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => skill.onSelect()}
              >
                <span className="rich-editor__ai-menu-skill-icon" aria-hidden="true">
                  {skill.icon?.trim() || "✦"}
                </span>
                {skill.label}
              </button>
            ))
          ) : (
            <div className="rich-editor__ai-menu-empty">
              还没有启用中的 AI 技能，可以直接在下面输入指令。
            </div>
          )}
        </div>
      </div>

      <div className="rich-editor__ai-menu-prompt">
        <textarea
          className="rich-editor__ai-menu-input"
          placeholder="使用 AI 编辑"
          value={prompt}
          disabled={Boolean(disabledReason)}
          rows={2}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
              return;
            }

            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (submitDisabled) {
                return;
              }
              onSubmitPrompt(prompt.trim(), resultMode);
            }
          }}
        />
        <div className="rich-editor__ai-menu-footer">
          <div className="rich-editor__ai-menu-mode" role="group" aria-label="AI 结果模式">
            <button
              type="button"
              className={resultMode === "modify" ? "is-active" : ""}
              disabled={Boolean(disabledReason)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setResultMode("modify")}
            >
              修改原文
            </button>
            <button
              type="button"
              className={resultMode === "answer" ? "is-active" : ""}
              disabled={Boolean(disabledReason)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setResultMode("answer")}
            >
              生成回答
            </button>
          </div>
          <span className="rich-editor__ai-menu-hint">
            {disabledReason ?? "Enter 提交，Shift+Enter 换行"}
          </span>
          {disabledReason && onOpenSettings ? (
            <button
              type="button"
              className="rich-editor__ai-menu-link"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onOpenSettings()}
            >
              打开设置
            </button>
          ) : null}
        </div>
      </div>
    </PopoverPanel>
  );
}
