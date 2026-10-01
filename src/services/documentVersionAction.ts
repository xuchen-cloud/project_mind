import type { DocumentVersionPrepareInput } from "../lib/types";
import { desktopApi } from "./desktopApi";
import { projectMindApi } from "./projectMindApi";

/** Both native GUI entry points freeze the displayed target and preflight
 * bytes. A delayed confirmation never refreshes the baseline and overwrites
 * a concurrent change. Each attempt carries one durable request identity. */
export async function commitDocumentVersion(input: DocumentVersionPrepareInput) {
  const requestId = crypto.randomUUID();
  const prepared = await projectMindApi.documentVersionPrepare(input);
  const { intent } = prepared;
  const registerCurrentBytes = intent.registeredContentHash !== intent.expectedContentHash;
  if (registerCurrentBytes) {
    const message = intent.registeredContentHash === null
      ? "当前旧版本没有已登记的原件校验值。将当前文件登记为新版本？旧版本仍保留为未经核验的内容。"
      : "当前文件在应用外已修改。将当前内容登记为新版本？旧版本的校验值不会改写，修改后的旧内容不能作为原件证据。";
    if (!await desktopApi.confirm(message, "登记文件版本")) return null;
  }
  return projectMindApi.documentAddVersion({ ...prepared, requestId, registerCurrentBytes });
}
