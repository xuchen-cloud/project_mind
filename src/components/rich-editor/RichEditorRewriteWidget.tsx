import { Check, LoaderCircle, Sparkles, X } from "lucide-react";

interface RichEditorRewriteWidgetProps {
  actionLabel: string;
  status: "queued" | "running" | "succeeded" | "failed";
  previewHtml: string;
  errorMessage?: string | null;
  onAccept: () => void;
  onClose: () => void;
  onOpenAiSettings?: () => void;
}

export function RichEditorRewriteWidget({
  actionLabel,
  status,
  previewHtml,
  errorMessage,
  onAccept,
  onClose,
  onOpenAiSettings,
}: RichEditorRewriteWidgetProps) {
  const isPending = status === "queued" || status === "running";
  const isFailed = status === "failed";
  const hasPreview = previewHtml.trim().length > 0;

  if (isPending && !hasPreview) {
    return (
      <div className="rich-editor__rewrite-widget rich-editor__rewrite-widget--thinking">
        <div className="rich-editor__rewrite-widget-thinking">
          <div className="rich-editor__rewrite-widget-thinking-copy">
            <span className="rich-editor__rewrite-widget-thinking-icon">
              <LoaderCircle className="spin" size={16} />
            </span>
            <span>{`AI 正在${actionLabel}…`}</span>
          </div>
          <button
            type="button"
            className="rich-editor__rewrite-widget-icon-button"
            aria-label="关闭 AI 建议"
            title="关闭 AI 建议"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rich-editor__rewrite-widget">
      <div className="rich-editor__rewrite-widget-shell">
        <div className="rich-editor__rewrite-widget-header">
          <div className="rich-editor__rewrite-widget-brand">
            <span className="rich-editor__rewrite-widget-badge">
              <Sparkles size={16} />
            </span>
            <div className="rich-editor__rewrite-widget-copy">
              <p className="rich-editor__rewrite-widget-title">
                {isFailed
                  ? `AI ${actionLabel}失败`
                  : isPending
                    ? `AI 正在${actionLabel}…`
                    : "我已完成更新。"}
              </p>
              <p className="rich-editor__rewrite-widget-subtitle">
                {isFailed
                  ? "原文保持不变，关闭后可以继续编辑。"
                  : "原文保留在上方，接受后才会真正写回。"}
              </p>
            </div>
          </div>
          <div className="rich-editor__rewrite-widget-actions">
            <button
              type="button"
              className="rich-editor__rewrite-widget-icon-button"
              aria-label="关闭 AI 建议"
              title="关闭 AI 建议"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onClose}
            >
              <X size={16} />
            </button>
            <button
              type="button"
              className={[
                "rich-editor__rewrite-widget-icon-button",
                "is-accept",
              ].join(" ")}
              aria-label="接受 AI 建议"
              title="接受 AI 建议"
              disabled={status !== "succeeded"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onAccept}
            >
              <Check size={16} />
            </button>
          </div>
        </div>

        {isFailed ? (
          <div className="rich-editor__rewrite-widget-error">
            <p>{errorMessage ?? "AI 改写失败"}</p>
            {onOpenAiSettings ? (
              <button
                type="button"
                className="rich-editor__rewrite-widget-link"
                onMouseDown={(event) => event.preventDefault()}
                onClick={onOpenAiSettings}
              >
                打开 AI 设置
              </button>
            ) : null}
          </div>
        ) : hasPreview ? (
          <div
            className="rich-editor__rewrite-widget-preview rich-editor__surface ProseMirror"
            contentEditable={false}
            suppressContentEditableWarning
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        ) : (
          <div className="rich-editor__rewrite-widget-empty">
            正在整理富文本结果…
          </div>
        )}
      </div>
    </div>
  );
}
