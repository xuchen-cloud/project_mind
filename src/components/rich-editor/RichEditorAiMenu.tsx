import { useEffect, useMemo, useRef, useState } from "react";

import { PopoverPanel } from "../../ui/components";

const MENU_WIDTH = 256;
const VIEWPORT_PADDING = 12;

interface RichEditorAiMenuProps {
  x: number;
  y: number;
  disabledReason?: string | null;
  onClose: () => void;
  onSubmitPrompt: (prompt: string) => void;
}

export function RichEditorAiMenu({
  x,
  y,
  disabledReason,
  onClose,
  onSubmitPrompt,
}: RichEditorAiMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    setPrompt("");
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
        Math.max(VIEWPORT_PADDING, window.innerHeight - 124),
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
      className="context-menu__panel rich-editor__ai-menu fixed z-[80] w-64 rounded-[8px] border p-1 outline-none backdrop-blur-[18px]"
      style={position}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="rich-editor__ai-menu-prompt">
        <textarea
          className="rich-editor__ai-menu-input"
          placeholder="使用 AI 编辑"
          value={prompt}
          disabled={Boolean(disabledReason)}
          rows={2}
          autoFocus
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
              onSubmitPrompt(prompt.trim());
            }
          }}
        />
        <div className="rich-editor__ai-menu-footer">
          <span className="rich-editor__ai-menu-hint">
            {disabledReason ?? "Enter 提交，Shift+Enter 换行"}
          </span>
        </div>
      </div>
    </PopoverPanel>
  );
}
