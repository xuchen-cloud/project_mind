import { useCallback, useEffect, useRef, useState } from "react";

import { Button, Dialog } from "../../ui/components";
import type { RecordExportRequest, RecordExportResult, RecordExportStage } from "./recordExport";
import type { RecordExportTarget } from "./recordExportTarget";

type Format = RecordExportRequest["format"];

export function RecordExportDialog({
  open,
  hasImages,
  onClose,
  chooseTarget,
  exportTo,
  onOpenFile,
  onRevealFile,
}: {
  open: boolean;
  hasImages: boolean;
  onClose: () => void;
  chooseTarget: (format: Format, includeImages: boolean) => Promise<RecordExportTarget | null>;
  exportTo: (request: RecordExportRequest) => Promise<RecordExportResult>;
  onOpenFile: (path: string) => void | Promise<void>;
  onRevealFile: (path: string) => void | Promise<void>;
}) {
  const [format, setFormat] = useState<Format>("markdown");
  const [includeImages, setIncludeImages] = useState(true);
  const [state, setState] = useState<"idle" | "running" | "missing" | "success" | "error" | "cancelled">("idle");
  const [stage, setStage] = useState<RecordExportStage>("preparing");
  const [showProgress, setShowProgress] = useState(false);
  const [missing, setMissing] = useState<Array<{ label: string; reason: string }>>([]);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Extract<RecordExportResult, { kind: "success" }> | null>(null);
  const targetRef = useRef<RecordExportTarget | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const progressTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setFormat("markdown");
    setIncludeImages(true);
    setState("idle");
    setError("");
    setMissing([]);
    setResult(null);
    targetRef.current = null;
  }, [open]);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (progressTimerRef.current !== null) window.clearTimeout(progressTimerRef.current);
  }, []);

  const finishProgress = () => {
    if (progressTimerRef.current !== null) window.clearTimeout(progressTimerRef.current);
    progressTimerRef.current = null;
    setShowProgress(false);
  };

  const run = useCallback(async (behavior: "ask" | "placeholder" = "ask") => {
    let target = targetRef.current;
    if (!target) {
      target = await chooseTarget(format, includeImages);
      if (!target) return;
      targetRef.current = target;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setState("running");
    setError("");
    setShowProgress(false);
    progressTimerRef.current = window.setTimeout(() => setShowProgress(true), 250);
    try {
      const next = await exportTo({
        format,
        includeImages: format === "markdown" ? includeImages : true,
        missingImageBehavior: behavior,
        targetPath: target.path,
        overwrite: target.overwrite,
        signal: controller.signal,
        onProgress: ({ stage: nextStage }) => setStage(nextStage),
      });
      finishProgress();
      if (next.kind === "missing-images") {
        setMissing(next.missing);
        setState("missing");
      } else {
        setResult(next);
        setState("success");
      }
    } catch (nextError) {
      finishProgress();
      if (controller.signal.aborted || (nextError instanceof DOMException && nextError.name === "AbortError")) {
        setState("cancelled");
      } else {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
        setState("error");
      }
    } finally {
      abortRef.current = null;
    }
  }, [chooseTarget, exportTo, format, includeImages]);

  const close = () => {
    if (state === "running" && stage === "writing") return;
    abortRef.current?.abort();
    onClose();
  };

  return (
    <Dialog open={open} title="导出 Record" description="从保存后的记录内容生成可携带文档。" onClose={close}
      footer={state === "success" && result ? (
        <>
          <Button onClick={() => void onRevealFile(result.path)}>在文件管理器中显示</Button>
          <Button variant="primary" onClick={() => void onOpenFile(result.path)}>打开文件</Button>
          <Button variant="ghost" onClick={close}>完成</Button>
        </>
      ) : state === "missing" ? (
        <>
          <Button onClick={() => { targetRef.current = null; setState("idle"); }}>取消导出</Button>
          <Button variant="primary" onClick={() => void run("placeholder")}>继续生成占位版本</Button>
        </>
      ) : (
        <>
          <Button onClick={close}>{state === "running" ? "关闭" : "取消"}</Button>
          {state === "running" ? (
            <Button variant="danger" disabled={stage === "writing"} onClick={() => abortRef.current?.abort()}>
              {stage === "writing" ? "正在完成写入" : "取消导出"}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void run()}>{state === "error" || state === "cancelled" ? "重试" : "导出"}</Button>
          )}
        </>
      )}
    >
      {state === "idle" || state === "error" || state === "cancelled" ? (
        <div className="grid gap-4">
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-ui font-medium text-text">格式</legend>
            {(["markdown", "docx", "pdf"] as const).map((value) => (
              <label key={value} className="flex items-center gap-2 text-body text-text">
                <input type="radio" name="record-export-format" value={value} checked={format === value}
                  onChange={() => { setFormat(value); targetRef.current = null; }} />
                {value === "markdown" ? "Markdown" : value === "docx" ? "Word (.docx)" : "PDF"}
              </label>
            ))}
          </fieldset>
          {format === "markdown" && hasImages ? (
            <label className="flex items-center gap-2 text-body text-text">
              <input type="checkbox" checked={includeImages} onChange={(event) => { setIncludeImages(event.target.checked); targetRef.current = null; }} />
              包含图片（导出为 ZIP）
            </label>
          ) : null}
          {state === "error" ? <p role="alert" className="text-body text-danger">导出失败：{error}</p> : null}
          {state === "cancelled" ? <p role="status" className="text-body text-text-muted">导出已取消，未写入目标文件。</p> : null}
        </div>
      ) : null}
      {state === "running" ? (
        <div aria-live="polite" className="grid gap-2">
          {showProgress ? <p className="text-body text-text">{stageLabel(stage)}</p> : <p className="sr-only">正在导出</p>}
        </div>
      ) : null}
      {state === "missing" ? (
        <div className="grid gap-3">
          <p className="text-body text-text">以下图片无法读取。你可以取消，或继续生成带占位提示的文档：</p>
          <ul className="grid gap-1 text-body text-text-muted">{missing.map((item, index) => <li key={`${item.label}-${index}`}>{item.label}：{item.reason}</li>)}</ul>
        </div>
      ) : null}
      {state === "success" && result ? (
        <div className="grid gap-2">
          <p className="text-body text-text">导出完成</p>
          <p className="break-all text-caption text-text-muted">{result.path}</p>
          {result.warnings.map((warning) => <p key={warning} className="text-caption text-warning">{warning}</p>)}
        </div>
      ) : null}
    </Dialog>
  );
}

function stageLabel(stage: RecordExportStage) {
  if (stage === "preparing") return "正在保存并准备内容…";
  if (stage === "images") return "正在处理图片与批注…";
  if (stage === "generating") return "正在生成文档…";
  if (stage === "writing") return "正在安全写入文件…";
  return "导出完成";
}
