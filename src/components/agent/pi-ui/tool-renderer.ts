import { html } from "lit";
import type { PiToolResultMessage } from "./types";
// Names match the registered Host descriptions (tools.rs/record_write_tools.rs/file_tools.rs).
const labels: Record<string, string> = {
  mind_context_get: "整理上下文", mind_context_overview_get: "查看工作概览",
  mind_knowledge_search: "查找知识", mind_knowledge_get: "读取知识",
  mind_source_search: "查找来源", mind_source_read: "读取来源",
  mind_record_blocks_get: "读取记录", mind_todo_get: "读取待办",
  mind_output_stage: "准备操作建议", mind_output_get: "读取操作结果", mind_output_list: "查看操作结果", mind_output_commit: "执行操作",
  mind_operation_get: "读取操作记录", mind_operation_list: "查看操作记录", mind_operation_undo: "撤销操作", mind_operation_restore_created: "恢复对象",
  mind_file_source_read: "读取文件原文", mind_file_versions_list: "查看文件历史", mind_file_versions_get: "读取文件版本",
  mind_file_content_begin: "准备文件内容", mind_file_content_chunk: "接收文件内容", mind_file_content_complete: "校验文件内容", mind_file_content_status: "查看文件准备状态",
};
export function renderTool(name: string, params: unknown, result: PiToolResultMessage | undefined, streaming: boolean, aborted = false) {
  const label = labels[name] ?? "处理请求";
  const summary = aborted ? `${label}已停止，未完成` : result?.isError ? `${label}失败` : result ? `${label}完成` : streaming ? `正在${label}` : label;
  const text = result?.content.map(part => part.type === "text" ? part.text : JSON.stringify(part)).join("\n") ?? "尚无工具结果。";
  return { isCustom: true, content: html`<div class="pi-tool-result">
    ${result?.isError ? html`<p class="pi-tool-error" role="alert">${summary}，请查看详情。</p>` : ""}
    <details><summary>${summary}</summary>
      <p class="pi-tool-name">${name || "历史工具结果"}</p>
      ${params !== undefined ? html`<pre class="pi-tool-text">${JSON.stringify(params, null, 2)}</pre>` : ""}
      <pre class="pi-tool-text">${text}</pre>
    </details>
    ${result ? html`<div data-pi-source-message=${result.id}></div>` : ""}
  </div>` };
}
