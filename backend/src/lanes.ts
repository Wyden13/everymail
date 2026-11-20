import type { Lane } from "./job";

/** The `job_kind` enum. Each kind is added here and to the enum, by migration, together. */
export type JobKind = never;

export const LANES: Record<JobKind, Lane> = {};
