import type { SQL } from "bun";
import type { Lane } from "./job";
import { retention } from "./retention";

/** The `job_kind` enum. Each kind is added here and to the enum, by migration, together. */
export type JobKind = "retention";

export const lanes = (sql: SQL): Record<JobKind, Lane> => ({
	retention: retention(sql),
});
