import type { JobState } from "./types.js";

const allowedTransitions: Record<JobState, readonly JobState[]> = {
  RECEIVED: ["PLANNING", "FAILED"],
  PLANNING: ["READY", "FAILED"],
  READY: ["WORKER_RUNNING", "FAILED"],
  WORKER_RUNNING: ["CHECKING", "FAILED"],
  CHECKING: ["REVIEWING", "REVISION_REQUIRED", "FAILED"],
  REVIEWING: ["APPROVED", "REVISION_REQUIRED", "FAILED"],
  REVISION_REQUIRED: ["WORKER_RUNNING", "FAILED"],
  APPROVED: [],
  FAILED: [],
};

export function assertTransition(from: JobState, to: JobState): void {
  if (!allowedTransitions[from].includes(to)) {
    throw new Error(`Invalid job state transition: ${from} -> ${to}`);
  }
}
