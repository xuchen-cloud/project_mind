import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AiEditorSkillInput,
  AiEditorSkillResult,
  AiJobEnqueueInput,
  AiJobIdentity,
  AiJobSnapshot,
  AiJobStatus,
  AiProfileTestInput,
  AiProfileTestResult,
  AiRecordMetadataResult,
} from "./types";
import { projectMindApi } from "../services/projectMindApi";
import { sameAiJobBinding, useAiJobStore } from "../state/ai-job-store";
import type { AgentWorkspaceBinding } from "./agent-types";

const AI_JOB_EVENT = "ai-job-updated";

interface AiJobSync {
  promise: Promise<AgentWorkspaceBinding | null>;
  abort: AbortController;
  unlisten?: UnlistenFn;
}
let aiJobSync: AiJobSync | null = null;

function workspaceChanged() {
  return new Error("工作区已切换，AI 请求已停止等待");
}

function awaitInSync<T>(sync: AiJobSync, operation: Promise<T>): Promise<T> {
  if (sync.abort.signal.aborted) return Promise.reject(workspaceChanged());
  return new Promise((resolve, reject) => {
    const aborted = () => reject(workspaceChanged());
    sync.abort.signal.addEventListener("abort", aborted, { once: true });
    void operation.then(resolve, reject).finally(() => {
      sync.abort.signal.removeEventListener("abort", aborted);
    });
  });
}

export function aiProfileTestJobTargetKey(profileId?: number | null) {
  return `profile-test:${profileId ?? "draft"}`;
}

export function aiEditorSkillJobTargetKey(seed: string) {
  return `editor-skill:${seed}`;
}

export function isAiJobActive(job: AiJobSnapshot | null | undefined) {
  return job ? job.status === "queued" || job.status === "running" : false;
}

export function isAiJobTerminal(job: AiJobSnapshot | null | undefined) {
  return job ? job.status === "succeeded" || job.status === "failed" || job.status === "cancelled" : false;
}

export function aiJobStatusLabel(status: AiJobStatus) {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
      return "生成中";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return "处理中";
  }
}

export function ensureAiJobSync(): Promise<AgentWorkspaceBinding | null> {
  if (!aiJobSync) {
    const sync: AiJobSync = { promise: Promise.resolve(null), abort: new AbortController() };
    aiJobSync = sync;
    sync.promise = (async () => {
      const binding = await projectMindApi.aiJobBindingGet();
      if (aiJobSync !== sync) return null;
      useAiJobStore.getState().bindWorkspace(binding);
      const unlisten = await listen<AiJobSnapshot>(AI_JOB_EVENT, (event) => {
        if (aiJobSync === sync && event.payload) {
          useAiJobStore.getState().upsertJob(event.payload);
        }
      });
      if (aiJobSync !== sync) {
        unlisten();
        return null;
      }
      sync.unlisten = unlisten;
      const activeJobs = await projectMindApi.aiJobsListActive(binding);
      if (aiJobSync !== sync) return null;
      useAiJobStore.getState().upsertJobs(activeJobs);
      return binding;
    })().catch((error) => {
      if (aiJobSync !== sync) return null;
      resetAiJobSync();
      throw error;
    });
  }
  return aiJobSync.promise;
}

export function resetAiJobSync() {
  const sync = aiJobSync;
  aiJobSync = null;
  sync?.abort.abort();
  sync?.unlisten?.();
  useAiJobStore.getState().reset();
}

export async function enqueueAiJob(input: AiJobEnqueueInput, expectedBinding?: AgentWorkspaceBinding) {
  const ready = ensureAiJobSync();
  const sync = aiJobSync!;
  const binding = await awaitInSync(sync, ready);
  if (aiJobSync !== sync || !binding || (expectedBinding && !sameAiJobBinding(binding, expectedBinding))) {
    throw workspaceChanged();
  }
  const snapshot = await awaitInSync(sync, projectMindApi.aiJobEnqueue(input, binding));
  if (!sameAiJobBinding(binding, snapshot.binding)) throw workspaceChanged();
  useAiJobStore.getState().upsertJob(snapshot);
  return snapshot;
}

export async function cancelAiJob(identity: AiJobIdentity) {
  const sync = aiJobSync;
  const snapshot = await projectMindApi.aiJobCancel(identity);
  if (sync && aiJobSync === sync && snapshot) useAiJobStore.getState().upsertJob(snapshot);
  return snapshot;
}

export async function enqueueAndWait(input: AiJobEnqueueInput, expectedBinding?: AgentWorkspaceBinding) {
  const queued = enqueueAiJob(input, expectedBinding);
  const sync = aiJobSync!;
  const snapshot = await queued;
  return waitForAiJob(sync, snapshot);
}

export function useAiJobTarget(targetKey: string) {
  return useAiJobStore((state) => {
    const jobId = state.latestJobIdByTarget[targetKey];
    return jobId ? state.jobsById[jobId] ?? null : null;
  });
}

export function profileTestJobInput(input: AiProfileTestInput): AiJobEnqueueInput {
  return {
    kind: "profile_test",
    targetKey: aiProfileTestJobTargetKey(input.id),
    input,
  };
}

export function editorSkillJobInput(
  targetKey: string,
  input: AiEditorSkillInput,
): AiJobEnqueueInput {
  return {
    kind: "editor_skill",
    targetKey,
    input,
  };
}

export function readProfileTestJobResult(job: AiJobSnapshot): AiProfileTestResult {
  if (job.result?.kind !== "profile_test") {
    throw new Error("AI profile test job did not return a test result");
  }

  return job.result.testResult;
}

export function readEditorSkillJobResult(job: AiJobSnapshot): AiEditorSkillResult {
  if (job.result?.kind !== "editor_skill") {
    throw new Error("AI editor rewrite job did not return a rewrite result");
  }

  return job.result.rewrite;
}

export function readRecordMetadataJobResult(job: AiJobSnapshot): AiRecordMetadataResult {
  if (job.result?.kind !== "record_metadata") {
    throw new Error("AI Record metadata job did not return metadata");
  }

  return job.result.metadata;
}

function waitForAiJob(sync: AiJobSync, identity: AiJobIdentity): Promise<AiJobSnapshot> {
  if (sync.abort.signal.aborted) return Promise.reject(workspaceChanged());
  const current = useAiJobStore.getState().jobsById[identity.id];
  if (isAiJobTerminal(current)) return Promise.resolve(current);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      unsubscribe();
      sync.abort.signal.removeEventListener("abort", aborted);
    };
    const aborted = () => { cleanup(); reject(workspaceChanged()); };
    const check = () => {
      const next = useAiJobStore.getState().jobsById[identity.id];
      if (!isAiJobTerminal(next)) return;
      cleanup();
      resolve(next);
    };
    const unsubscribe = useAiJobStore.subscribe(check);
    sync.abort.signal.addEventListener("abort", aborted, { once: true });
    check();
    void projectMindApi.aiJobGet(identity).then((snapshot) => {
      if (aiJobSync === sync && snapshot) useAiJobStore.getState().upsertJob(snapshot);
    }).catch((error) => { cleanup(); reject(error); });
  });
}
