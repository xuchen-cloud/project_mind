import { create } from "zustand";

import type { AiJobSnapshot, AiJobStatus } from "../lib/types";

interface AiJobStore {
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
  jobsById: {},
  latestJobIdByTarget: {},
  upsertJob: (job) =>
    set((state) => mergeJobs(state.jobsById, state.latestJobIdByTarget, [job])),
  upsertJobs: (jobs) =>
    set((state) => mergeJobs(state.jobsById, state.latestJobIdByTarget, jobs)),
  reset: () => set({ jobsById: {}, latestJobIdByTarget: {} }),
}));
