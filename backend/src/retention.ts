import type { SQL } from "bun";
import type { Lane } from "./job";

/** Days each kept table holds a row. Transcripts, events and conversation turns join as their tables land. */
export const RETENTION_DAYS = { run_log: 90 } as const;

/** How often a user's retention job runs. */
export const SWEEP_SECONDS = 86_400;

/** Deletes the user's rows past their retention, measured from Postgres `now()`. */
export async function sweep(sql: SQL, userId: string): Promise<void> {
	await sql`DELETE FROM run_log
		WHERE user_id = ${userId}
			AND finished_at < now() - make_interval(days => ${RETENTION_DAYS.run_log})`;
}

/** The retention lane: one job per user, enqueued at sign-up, that runs daily and never gives up. */
export const retention = (sql: SQL): Lane => ({
	concurrency: 1,
	timeoutSeconds: 60,
	retry: {
		maxAttempts: Number.POSITIVE_INFINITY,
		baseSeconds: 60,
		capSeconds: 3600,
	},
	keeps: { to: "nothing" },
	run: async (job) => {
		await sweep(sql, job.userId);
		return { repeatInSeconds: SWEEP_SECONDS };
	},
});
