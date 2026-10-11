import { getErrorMessage } from "./errors";
import { AgentApiError } from "../services/agentApi";

export function agentFailureMessage(error: unknown): string {
  const code = error instanceof AgentApiError ? error.code
    : error && typeof error === "object" && "code" in error ? String(error.code) : null;
  const messages: Record<string, string> = {
    RUN_BUSY: "工作区已有正在运行的助手，请先停止或等待完成。",
    TOOL_CALL_UNSUPPORTED: "当前模型或服务不支持此次工具调用，请到模型设置更换兼容模型。",
    PROFILE_UNAVAILABLE: "当前模型配置不可用，请在模型设置中检查通用模型配置。",
    SECRETS_LOCKED: "请先解锁 AI 密钥，再使用助手。",
    WORKSPACE_CHANGED: "工作区已切换，请重新打开助手。",
    RUNTIME_UNAVAILABLE: "内置助手运行资源不可用，请检查应用安装。",
    BUDGET_EXCEEDED: "本次运行已达到上限，已保存的消息仍可阅读，可发送新的问题继续。",
    TIMED_OUT: "助手响应超时，已保存的消息仍可阅读；可稍后发送新问题继续。",
    SOURCE_NOT_READY: "资料尚未准备好，请打开知识页查看资料处理状态。",
    SOURCE_CHANGED: "资料已变化，请刷新后继续提问。",
    IO_FAILED: "助手读取或保存会话失败，请刷新后重试。",
    INVALID_ARGUMENT: "助手请求格式不兼容（INVALID_ARGUMENT），请重新打开助手；持续失败时请检查应用版本。",
    INVALID_RUN_TRANSITION: "运行状态已变化，请刷新会话后继续。",
    RUNTIME_INCOMPATIBLE: "助手运行资源与应用版本不匹配，请检查应用安装。",
    WORKSPACE_NOT_OPEN: "请先打开工作区。",
    SCOPE_DENIED: "当前操作不在授权范围内，请检查工作区助手设置。",
    REVISION_CONFLICT: "内容或助手设置已变化，请刷新后重试。",
    UNDO_CONFLICT: "记录在保存后已有其他修改，无法撤销；后续内容已保留。请打开记录核对。",
    EDITOR_REVIEW_PENDING: "该记录还有待确认的编辑，请先处理编辑器中的修改。",
    EDITOR_BUSY: "该记录正在保存，请等待编辑器完成后重试。",
    INVALID_PATCH: "候选修改未通过记录校验，请重新生成成果。",
    AMBIGUOUS_MATCH: "无法确定候选修改对应的记录块，请重新生成成果。",
    OUTPUT_COMMIT_FAILED: "成果保存失败，请刷新状态后重试。",
    OBJECT_WITHDRAWN: "内容已撤回，可在会话中恢复。",
    RATE_LIMITED: "模型服务请求过于频繁，请稍后重试。",
    CANCELLED: "运行已停止。",
  };
  if (code === "SOURCE_NOT_READY" && error && typeof error === "object" && "details" in error) {
    const details = error.details;
    if (details && typeof details === "object" && "recovery" in details) {
      const recovery = details.recovery;
      if (recovery && typeof recovery === "object" && "message" in recovery && typeof recovery.message === "string") return recovery.message;
    }
  }
  if (code && messages[code]) return messages[code];
  if (code && error && typeof error === "object" && !("message" in error)) return `助手运行失败（${code}），可刷新后发送新问题继续。`;
  return getErrorMessage(error, "助手操作失败，请重试。");
}
