import { Check, Clipboard, LoaderCircle, RotateCcw, Sparkles, X } from "lucide-react";

interface RichEditorRewriteWidgetProps {
  skillName: string;
  resultMode: "modify" | "answer" | "auto";
  status: "queued" | "running" | "succeeded" | "failed";
  answer?: string | null;
  answerHtml?: string | null;
  errorMessage?: string | null;
  hasModifyPreview?: boolean;
  showingOriginal?: boolean;
  onAccept: () => void;
  onReject: () => void;
  onCompareDown: () => void;
  onCompareUp: () => void;
  onRetry: () => void;
  onCopyAnswer: () => void;
  onInsertAnswer: () => void;
  onPreserveViewport: () => void;
  onClose: () => void;
  onOpenAiSettings?: () => void;
  resolvedModel?: string | null;
  resolvedProfileName?: string | null;
  usedDefaultFallback?: boolean;
  contextStale?: boolean;
  parseError?: string | null;
}

export function RichEditorRewriteWidget({
  skillName,
  resultMode,
  status,
  answer,
  answerHtml,
  errorMessage,
  hasModifyPreview = false,
  showingOriginal = false,
  onAccept,
  onReject,
  onCompareDown,
  onCompareUp,
  onRetry,
  onCopyAnswer,
  onInsertAnswer,
  onPreserveViewport,
  onClose,
  onOpenAiSettings,
  resolvedModel,
  resolvedProfileName,
  usedDefaultFallback = false,
  contextStale = false,
  parseError,
}: RichEditorRewriteWidgetProps) {
  const isPending = status === "queued" || status === "running";
  const isFailed = status === "failed";

  if (isPending && !(resultMode === "answer" && answer) && !hasModifyPreview) {
    if (resultMode !== "answer") {
      return (
        <div className="rich-editor__rewrite-widget rich-editor__rewrite-widget--modify rich-editor__rewrite-widget--loading">
          <div className="rich-editor__rewrite-widget-card rich-editor__rewrite-widget-card--line">
            <div className="rich-editor__rewrite-widget-status">
              <AiBadge loading />
              <span>{resultMode === "auto" ? "AI 正在处理..." : "AI 正在修改..."}</span>
              <span className="rich-editor__rewrite-widget-compat-text">AI 正在处理...</span>
            </div>
            <button
              type="button"
              className="rich-editor__rewrite-widget-icon-button"
              aria-label="关闭 AI"
              title="关闭 AI"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onClose}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="rich-editor__rewrite-widget rich-editor__rewrite-widget--answer rich-editor__rewrite-widget--loading">
        <div className="rich-editor__rewrite-widget-card rich-editor__rewrite-widget-card--line">
          <div className="rich-editor__rewrite-widget-status rich-editor__rewrite-widget-answer-stack">
            <span className="rich-editor__rewrite-widget-status-line">
              <AiBadge loading />
              <span>AI 正在处理...</span>
            </span>
          </div>
          <button
            type="button"
            className="rich-editor__rewrite-widget-icon-button"
            aria-label="关闭 AI"
            title="关闭 AI"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
      </div>
    );
  }

  if (isFailed) {
    if (resultMode !== "answer") {
      return (
        <div className="rich-editor__rewrite-widget rich-editor__rewrite-widget--modify rich-editor__rewrite-widget--error">
          <div className="rich-editor__rewrite-widget-card rich-editor__rewrite-widget-card--line">
            <div className="rich-editor__rewrite-widget-status">
              <AiBadge />
              <span>修改失败，请重试</span>
            </div>
            <div className="rich-editor__rewrite-widget-actions rich-editor__rewrite-widget-actions--row">
              <button type="button" className="rich-editor__rewrite-widget-action" onMouseDown={(event) => event.preventDefault()} onClick={onRetry}>
                <RotateCcw size={13} />
                重试
              </button>
              {onOpenAiSettings ? (
                <button type="button" className="rich-editor__rewrite-widget-action" onMouseDown={(event) => event.preventDefault()} onClick={onOpenAiSettings}>
                  打开设置
                </button>
              ) : null}
              <button type="button" className="rich-editor__rewrite-widget-action" onMouseDown={(event) => event.preventDefault()} onClick={onClose}>
                关闭
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="rich-editor__rewrite-widget rich-editor__rewrite-widget--answer rich-editor__rewrite-widget--error">
        <div className="rich-editor__rewrite-widget-card">
          <AiBadge />
          <div className="rich-editor__rewrite-widget-answer-stack">
            <div className="rich-editor__rewrite-widget-answer rich-editor__surface">
              <p>处理失败，请重试</p>
              {errorMessage ? <p className="rich-editor__rewrite-widget-error-detail">{errorMessage}</p> : null}
            </div>
            <div className="rich-editor__rewrite-widget-actions rich-editor__rewrite-widget-actions--row">
              <button type="button" className="rich-editor__rewrite-widget-action" onMouseDown={(event) => event.preventDefault()} onClick={onRetry}>
                <RotateCcw size={13} />
                重试
              </button>
              {onOpenAiSettings ? (
                <button type="button" className="rich-editor__rewrite-widget-action" onMouseDown={(event) => event.preventDefault()} onClick={onOpenAiSettings}>
                  打开设置
                </button>
              ) : null}
              <button type="button" className="rich-editor__rewrite-widget-action" onMouseDown={(event) => event.preventDefault()} onClick={onClose}>
                关闭
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (answer && !hasModifyPreview) {
    return (
      <div className="rich-editor__rewrite-widget rich-editor__rewrite-widget--answer">
        <div className="rich-editor__rewrite-widget-card">
          <AiBadge />
          <div className="rich-editor__rewrite-widget-answer-stack">
            <div className="rich-editor__rewrite-widget-meta">
              {skillName}{resolvedModel ? ` · ${resolvedProfileName ? `${resolvedProfileName} / ` : ""}${resolvedModel}` : ""}
              {usedDefaultFallback ? " · 技能模型不可用，已使用默认模型" : ""}
              {contextStale ? " · 附近内容已变化，请复核结果" : ""}
            </div>
            {parseError ? <p className="rich-editor__rewrite-widget-error-detail">响应格式无法解析，只能复制原始内容，不能写入正文。</p> : null}
            <div
              className="rich-editor__rewrite-widget-answer rich-editor__surface"
              dangerouslySetInnerHTML={{ __html: answerHtml || "" }}
            />
            <div className="rich-editor__rewrite-widget-actions rich-editor__rewrite-widget-actions--row">
              <button type="button" className="rich-editor__rewrite-widget-action" onMouseDown={(event) => event.preventDefault()} onClick={onCopyAnswer}>
                <Clipboard size={13} />
                复制
              </button>
              <button
                type="button"
                className="rich-editor__rewrite-widget-action is-accept"
                disabled={isPending || Boolean(parseError)}
                onPointerDown={onPreserveViewport}
                onMouseDown={(event) => event.preventDefault()}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") onPreserveViewport();
                }}
                onClick={onInsertAnswer}
              >
                <Check size={13} />
                {isPending ? "生成中" : "插入"}
              </button>
              <button type="button" className="rich-editor__rewrite-widget-action" onMouseDown={(event) => event.preventDefault()} onClick={onClose}>
                关闭
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!hasModifyPreview) {
    return null;
  }

  return (
    <div className="rich-editor__rewrite-widget rich-editor__rewrite-widget--modify">
      <div
        className={[
          "rich-editor__rewrite-widget-card",
          "rich-editor__rewrite-widget-card--line",
          answer ? "rich-editor__rewrite-widget-card--combined" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="rich-editor__rewrite-widget-status">
          <AiBadge />
          <span>
            {isPending ? "AI 正在修改..." : "我已完成更新。"}
            {!isPending && resolvedModel ? ` · ${resolvedProfileName ? `${resolvedProfileName} / ` : ""}${resolvedModel}` : ""}
            {!isPending && usedDefaultFallback ? " · 已回退默认模型" : ""}
            {contextStale ? " · 附近内容已变化，请复核结果" : ""}
          </span>
        </div>
        {answer ? (
          <div
            className="rich-editor__rewrite-widget-combined-answer rich-editor__surface"
            dangerouslySetInnerHTML={{ __html: answerHtml || "" }}
          />
        ) : null}
        <div className="rich-editor__rewrite-widget-actions rich-editor__rewrite-widget-actions--row">
          {answer ? (
            <button type="button" className="rich-editor__rewrite-widget-action" onMouseDown={(event) => event.preventDefault()} onClick={onCopyAnswer}>
              <Clipboard size={13} />
              复制回答
            </button>
          ) : null}
          <button
            type="button"
            className={["rich-editor__rewrite-widget-action", showingOriginal ? "is-active" : ""].filter(Boolean).join(" ")}
            aria-pressed={showingOriginal}
            title={showingOriginal ? "正在显示原文" : "按住显示原文"}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture?.(event.pointerId);
              onCompareDown();
            }}
            onPointerUp={(event) => {
              event.preventDefault();
              event.currentTarget.releasePointerCapture?.(event.pointerId);
              onCompareUp();
            }}
            onPointerCancel={(event) => {
              event.currentTarget.releasePointerCapture?.(event.pointerId);
              onCompareUp();
            }}
            onPointerLeave={(event) => {
              if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) {
                onCompareUp();
              }
            }}
          >
            {showingOriginal ? "原文" : "对比"}
          </button>
          <button type="button" className="rich-editor__rewrite-widget-action" onMouseDown={(event) => event.preventDefault()} onClick={onReject}>
            <X size={13} />
            撤销
          </button>
          <button
            type="button"
            className="rich-editor__rewrite-widget-action is-accept"
            disabled={isPending}
            onPointerDown={onPreserveViewport}
            onMouseDown={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") onPreserveViewport();
            }}
            onClick={onAccept}
          >
            <Check size={13} />
            {isPending ? "生成中" : "接受"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AiBadge({ loading = false }: { loading?: boolean }) {
  return (
    <span className="rich-editor__rewrite-widget-badge" aria-hidden="true">
      {loading ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}
    </span>
  );
}
