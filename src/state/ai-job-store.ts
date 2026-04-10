import { create } from "zustand";

import type { AiJobSnapshot } from "../lib/types";

interface AiJobStore {
  jobsById: Record<number, AiJobSnapshot>;
  latestJobIdByTarget: Record<string, number>;
  upsertJob: (job: AiJobSnapshot) => void;
  upsertJobs: (jobs: AiJobSnapshot[]) => void;
  reset: () => void;
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
    jobsById[job.id] = previous ? { ...previous, ...job } : job;

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
