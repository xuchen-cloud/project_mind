import type { AgentObjectRef, AgentWorkspaceBinding } from "./agent-types";
import type { FileSourcePage } from "./file-types";
import { fileDocumentApi } from "../services/fileDocumentApi";

export interface CompleteFileSourceInput {
  object: AgentObjectRef;
  versionNumber: number;
  expectedContentHash: string;
}

function invalidPage(): never {
  throw new Error("文件源码分页不一致，请重新读取该版本。");
}

function sameObject(actual: AgentObjectRef, expected: AgentObjectRef) {
  return actual?.workspaceId === expected.workspaceId && actual.kind === expected.kind && actual.id === expected.id
    && actual.scope?.kind === expected.scope.kind
    && (expected.scope.kind === "workspace" || (actual.scope.kind === "project" && actual.scope.projectId === expected.scope.projectId));
}

// Aborting stops this reader immediately. Tauri owns an already dispatched IPC;
// its eventual response is ignored and cannot initiate another page request.
function cancellable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Read one registered version completely; partial source is never a result. */
export async function readCompleteFileSource(
  binding: AgentWorkspaceBinding,
  input: CompleteFileSourceInput,
  signal?: AbortSignal,
): Promise<FileSourcePage> {
  const bound = { ...binding };
  const object = { ...input.object, scope: { ...input.object.scope } };
  const versionNumber = input.versionNumber;
  const expectedContentHash = input.expectedContentHash;
  let cursor: string | null = null;
  let offset = 0;
  let baseline: FileSourcePage | null = null;
  const parts: string[] = [];
  const cursors = new Set<string>();
  while (true) {
    signal?.throwIfAborted();
    const page: FileSourcePage = await cancellable(fileDocumentApi.sourceRead(bound, {
      object, versionNumber, expectedContentHash, cursor, budgetChars: 24000,
    }), signal);
    signal?.throwIfAborted();
    if (!page || !sameObject(page.object, object) || page.versionNumber !== versionNumber
      || page.contentHash !== expectedContentHash || typeof page.text !== "string"
      || typeof page.title !== "string" || !["text", "markdown", "html"].includes(page.format)
      || !Number.isSafeInteger(page.byteLength) || page.byteLength < 0
      || ![page.startChar, page.endChar, page.totalChars].every(value => Number.isSafeInteger(value) && value >= 0)
      || page.startChar !== offset || page.endChar < page.startChar || page.endChar > page.totalChars
      || Array.from(page.text).length !== page.endChar - page.startChar
      || typeof page.complete !== "boolean") invalidPage();
    if (baseline && (page.totalChars !== baseline.totalChars || page.byteLength !== baseline.byteLength
      || page.format !== baseline.format || page.title !== baseline.title)) invalidPage();
    if (page.complete) {
      if (page.nextCursor !== null || page.endChar !== page.totalChars) invalidPage();
    } else if (typeof page.nextCursor !== "string" || !page.nextCursor || cursors.has(page.nextCursor)
      || page.endChar <= offset || page.endChar >= page.totalChars) invalidPage();
    baseline ??= page;
    parts.push(page.text);
    offset = page.endChar;
    if (page.complete) {
      const text = parts.join("");
      if (new TextEncoder().encode(text).byteLength !== baseline.byteLength) invalidPage();
      return { ...baseline, text, startChar: 0, endChar: offset, nextCursor: null, complete: true };
    }
    cursor = page.nextCursor;
    cursors.add(cursor!);
  }
}
