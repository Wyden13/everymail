import type { SQL } from "bun";
import type { Lane } from "./job";

/** Days each kept table holds a row. Transcripts, events and conversation turns join as their tables land. */
export const RETENTION_DAYS = { run_log: 90 } as const;

/** How often a user's retention job runs. */
export const SWEEP_SECONDS = 86_400;

/** Rows one delete statement removes, so a backlog never holds one long statement past the lane's timeout. */
const BATCH = 5_000;

/** Gives every user without a retention job one, due a sweep from now. Runs at boot, for users and rows that
 * predate it, and in every sign-in transaction; a second sign-in of a new user waits on the users upsert, so it sees the first's job. */
export async function ensure(sql: SQL): Promise<void> {
	await sql`
		INSERT INTO jobs (user_id, kind, status, due_at, payload)
		SELECT u.id, 'retention'::job_kind, 'scheduled'::job_status,
			now() + make_interval(secs => ${SWEEP_SECONDS}), ${new Uint8Array()}
		FROM users u
		WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.user_id = u.id AND j.kind = 'retention'::job_kind)`;
}

/** Deletes the user's rows past their retention, measured from Postgres `now()`, one batch at a time.
 * Stops between batches once `signal` aborts, so a timed-out sweep leaves no statement running. */
export async function sweep(
	sql: SQL,
	userId: string,
	signal: AbortSignal,
): Promise<void> {
	for (;;) {
		signal.throwIfAborted();
		const deleted = await sql`
			DELETE FROM run_log WHERE id IN (
				SELECT id FROM run_log
				WHERE user_id = ${userId}
					AND finished_at < now() - make_interval(days => ${RETENTION_DAYS.run_log})
				LIMIT ${BATCH}
			)
			RETURNING 1`;
		if (deleted.length < BATCH) return;
	}
}

/** The retention lane: one job per user, ensured at boot and sign-in, that runs daily and never gives up. */
export const retention = (sql: SQL): Lane => ({
	concurrency: 1,
	timeoutSeconds: 60,
	retry: {
		maxAttempts: Number.POSITIVE_INFINITY,
		baseSeconds: 60,
		capSeconds: 3600,
	},
	keeps: { to: "nothing" },
	run: async (job, signal) => {
		await sweep(sql, job.userId, signal);
		return { repeatInSeconds: SWEEP_SECONDS };
	},
});
