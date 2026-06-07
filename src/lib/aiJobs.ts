import { listen } from "@tauri-apps/api/event";

import type {
  AiEditorRewriteInput,
  AiEditorRewriteResult,
  AiAnswerQuestionInput,
  AiAnswerResult,
  AiAnswerScope,
  AiArtifactGetInput,
  AiArtifactRecord,
  AiGenerateInput,
  AiJobEnqueueInput,
  AiJobSnapshot,
  AiJobStatus,
  AiProfileTestInput,
  AiProfileTestResult,
  AiSuggestionRecord,
} from "./types";
import { projectMindApi } from "../services/projectMindApi";
import { useAiJobStore } from "../state/ai-job-store";

const AI_JOB_EVENT = "ai-job-updated";

let aiJobSyncPromise: Promise<void> | null = null;

export function aiArtifactJobTargetKey(input: AiArtifactGetInput) {
  return `artifact:${input.kind}:${input.projectId ?? "workspace"}:${input.artifactDate ?? "none"}`;
}

export function aiAskJobTargetKey(
  scope: AiAnswerScope,
  projectId: number | null,
) {
  return `ask:${scope}:${projectId ?? "workspace"}`;
}

export function aiNoteSuggestionsJobTargetKey(noteId: number) {
  return `note-suggestions:${noteId}`;
}

export function aiProfileTestJobTargetKey(profileId?: number | null) {
  return `profile-test:${profileId ?? "draft"}`;
}

export function aiEditorRewriteJobTargetKey(seed: string) {
  return `editor-rewrite:${seed}`;
}

export function isAiJobActive(job: AiJobSnapshot | null | undefined) {
  return job ? job.status === "queued" || job.status === "running" : false;
}

export function isAiJobTerminal(job: AiJobSnapshot | null | undefined) {
  return job ? job.status === "succeeded" || job.status === "failed" : false;
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
    default:
      return "处理中";
  }
}

export async function ensureAiJobSync() {
  if (!aiJobSyncPromise) {
    aiJobSyncPromise = (async () => {
      await listen<AiJobSnapshot>(AI_JOB_EVENT, (event) => {
        if (event.payload) {
          useAiJobStore.getState().upsertJob(event.payload);
        }
      });

      const activeJobs = await projectMindApi.aiJobsListActive();
      useAiJobStore.getState().upsertJobs(activeJobs);
    })().catch((error) => {
      aiJobSyncPromise = null;
      throw error;
    });
  }

  return aiJobSyncPromise;
}

export function resetAiJobSync() {
  aiJobSyncPromise = null;
  useAiJobStore.getState().reset();
}

export async function enqueueAndWait(input: AiJobEnqueueInput) {
  await ensureAiJobSync();
  const snapshot = await projectMindApi.aiJobEnqueue(input);
  useAiJobStore.getState().upsertJob(snapshot);
  return waitForAiJob(snapshot.id);
}

export function useAiJobTarget(targetKey: string) {
  return useAiJobStore((state) => {
    const jobId = state.latestJobIdByTarget[targetKey];
    return jobId ? state.jobsById[jobId] ?? null : null;
  });
}

export function artifactRefreshJobInput(input: AiArtifactGetInput): AiJobEnqueueInput {
  return {
    kind: "artifact_refresh",
    targetKey: aiArtifactJobTargetKey(input),
    input,
  };
}

export function answerQuestionJobInput(
  input: AiAnswerQuestionInput,
  projectId: number | null,
): AiJobEnqueueInput {
  return {
    kind: "answer_question",
    targetKey: aiAskJobTargetKey(input.scope, projectId),
    input,
  };
}

export function noteSuggestionsJobInput(input: AiGenerateInput): AiJobEnqueueInput {
  return {
    kind: "note_suggestions",
    targetKey: aiNoteSuggestionsJobTargetKey(input.noteId as number),
    input,
  };
}

export function profileTestJobInput(input: AiProfileTestInput): AiJobEnqueueInput {
  return {
    kind: "profile_test",
    targetKey: aiProfileTestJobTargetKey(input.id),
    input,
  };
}

export function editorRewriteJobInput(
  targetKey: string,
  input: AiEditorRewriteInput,
): AiJobEnqueueInput {
  return {
    kind: "editor_rewrite",
    targetKey,
    input,
  };
}

export function readArtifactJobResult(job: AiJobSnapshot): AiArtifactRecord {
  if (job.result?.kind !== "artifact_refresh") {
    throw new Error("AI artifact job did not return an artifact result");
  }

  return job.result.artifact;
}

export function readAnswerJobResult(job: AiJobSnapshot): AiAnswerResult {
  if (job.result?.kind !== "answer_question") {
    throw new Error("AI answer job did not return an answer result");
  }

  return job.result.answer;
}

export function readNoteSuggestionsJobResult(job: AiJobSnapshot): AiSuggestionRecord[] {
  if (job.result?.kind !== "note_suggestions") {
    throw new Error("AI suggestions job did not return suggestions");
  }

  return job.result.suggestions;
}

export function readProfileTestJobResult(job: AiJobSnapshot): AiProfileTestResult {
  if (job.result?.kind !== "profile_test") {
    throw new Error("AI profile test job did not return a test result");
  }

  return job.result.testResult;
}

export function readEditorRewriteJobResult(job: AiJobSnapshot): AiEditorRewriteResult {
  if (job.result?.kind !== "editor_rewrite") {
    throw new Error("AI editor rewrite job did not return a rewrite result");
  }

  return job.result.rewrite;
}

async function waitForAiJob(jobId: number) {
  const current = useAiJobStore.getState().jobsById[jobId];
  if (isAiJobTerminal(current)) {
    return current;
  }

  return new Promise<AiJobSnapshot>((resolve) => {
    const unsubscribe = useAiJobStore.subscribe((state) => {
      const next = state.jobsById[jobId];
      if (!isAiJobTerminal(next)) {
        return;
      }

      unsubscribe();
      resolve(next);
    });

    const latest = useAiJobStore.getState().jobsById[jobId];
    if (isAiJobTerminal(latest)) {
      unsubscribe();
      resolve(latest);
      return;
    }

    void projectMindApi.aiJobGet(jobId).then((snapshot) => {
      if (snapshot) {
        useAiJobStore.getState().upsertJob(snapshot);
      }
    });
  });
}
