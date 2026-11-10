import { create } from "zustand";

import type { AiJobSnapshot, AiJobStatus } from "../lib/types";
import type { AgentWorkspaceBinding } from "../lib/agent-types";

export function sameAiJobBinding(a: AgentWorkspaceBinding | null, b: AgentWorkspaceBinding) {
  return a?.workspaceId === b.workspaceId && a.generation === b.generation;
}

interface AiJobStore {
  binding: AgentWorkspaceBinding | null;
  bindWorkspace: (binding: AgentWorkspaceBinding) => void;
  jobsById: Record<number, AiJobSnapshot>;
  latestJobIdByTarget: Record<string, number>;
  upsertJob: (job: AiJobSnapshot) => void;
  upsertJobs: (jobs: AiJobSnapshot[]) => void;
  reset: () => void;
}

const AI_JOB_STATUS_RANK: Record<AiJobStatus, number> = {
  queued: 0,
  running: 1,
  succeeded: 2,
  failed: 2,
  cancelled: 2,
};

function mergeJobSnapshot(previous: AiJobSnapshot | undefined, incoming: AiJobSnapshot) {
  if (!previous) return incoming;
  const previousRank = AI_JOB_STATUS_RANK[previous.status];
  const incomingRank = AI_JOB_STATUS_RANK[incoming.status];
  if (incomingRank < previousRank) return previous;
  if (previousRank === 2 && incoming.status !== previous.status) return previous;
  return {
    ...previous,
    ...incoming,
    streamText: incoming.streamText ?? previous.streamText,
    result: incoming.result ?? previous.result,
  };
}

function mergeJobs(
  currentJobsById: Record<number, AiJobSnapshot>,
  currentLatestByTarget: Record<string, number>,
  incomingJobs: AiJobSnapshot[],
) {
  const jobsById = { ...currentJobsById };
  const latestJobIdByTarget = { ...currentLatestByTarget };

  for (const job of incomingJobs) {
    const previous = jobsById[job.id];
    jobsById[job.id] = mergeJobSnapshot(previous, job);

    const latestJobId = latestJobIdByTarget[job.targetKey];
    const latestJob = latestJobId ? jobsById[latestJobId] : null;
    if (!latestJob || latestJob.id <= job.id) {
      latestJobIdByTarget[job.targetKey] = job.id;
    }
  }

  return { jobsById, latestJobIdByTarget };
}

export const useAiJobStore = create<AiJobStore>((set) => ({
  binding: null,
  jobsById: {},
  latestJobIdByTarget: {},
  bindWorkspace: (binding) => set((state) => sameAiJobBinding(state.binding, binding)
    ? state : { binding, jobsById: {}, latestJobIdByTarget: {} }),
  upsertJob: (job) =>
    set((state) => sameAiJobBinding(state.binding, job.binding)
      ? mergeJobs(state.jobsById, state.latestJobIdByTarget, [job]) : state),
  upsertJobs: (jobs) =>
    set((state) => {
      const current = jobs.filter((job) => sameAiJobBinding(state.binding, job.binding));
      return current.length ? mergeJobs(state.jobsById, state.latestJobIdByTarget, current) : state;
    }),
  reset: () => set({ binding: null, jobsById: {}, latestJobIdByTarget: {} }),
}));
