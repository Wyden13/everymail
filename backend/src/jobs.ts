import type { SQL, TransactionSQL } from "bun";
import {
	type FailureReason,
	failure,
	type Job,
	type Lane,
	type Lanes,
	type Status,
	sources,
	type Target,
	transition,
} from "./job";

const SCHEDULED: Status = "scheduled";
const RUNNING: Status = "running";

const statuses = (sql: SQL, list: Status[]) => sql.array(list, "TEXT");

/** Adds a job due after a delay. Runs in the caller's transaction, which goes through `commit` so the executor wakes. */
export async function enqueue(
	sql: SQL,
	job: {
		userId: string;
		kind: string;
		payload: Uint8Array;
		dueInSeconds: number;
	},
): Promise<string> {
	const [row] = await sql`
		INSERT INTO jobs (user_id, kind, status, due_at, payload)
		VALUES (${job.userId}, ${job.kind}::job_kind, ${SCHEDULED}::job_status,
			now() + make_interval(secs => ${job.dueInSeconds}), ${job.payload})
		RETURNING id`;
	return row.id;
}

/** Runs `work` in one transaction and wakes the executor once it commits; a rollback wakes nothing.
 * Every write that enqueues or readies a job goes through this. */
export async function commit<T>(
	sql: SQL,
	wake: () => void,
	work: (tx: TransactionSQL) => Promise<T>,
): Promise<T> {
	const result = await sql.begin(work);
	wake();
	return result;
}

type JobRow = {
	id: string;
	user_id: string;
	kind: string;
	attempt: number;
	payload: Uint8Array;
};

const toJob = (r: JobRow): Job => ({
	id: r.id,
	userId: r.user_id,
	kind: r.kind,
	attempt: r.attempt,
	payload: r.payload,
});

/** Moves up to `limit` due jobs of a kind to running under a lease, oldest due first, and commits.
 * Rows another claim holds are skipped, never waited on. */
export async function claim(
	sql: SQL,
	kind: string,
	limit: number,
	leaseSeconds: number,
): Promise<Job[]> {
	const rows: JobRow[] = await sql`
		UPDATE jobs SET status = ${RUNNING}::job_status, attempt = attempt + 1,
			lease_until = now() + make_interval(secs => ${leaseSeconds})
		WHERE id IN (
			SELECT id FROM jobs
			WHERE kind = ${kind}::job_kind AND due_at <= now()
				AND status = ANY(${statuses(sql, sources("claim"))}::job_status[])
			ORDER BY due_at, id
			LIMIT ${limit}
			FOR UPDATE SKIP LOCKED
		)
		RETURNING id, user_id, kind, attempt, payload`;
	return rows.map(toJob);
}

/** Records how a claimed attempt ended. Applies only while that attempt still holds the job,
 * so a finish arriving after its lease expired changes nothing. Returns whether it applied.
 * A finish deletes the job and, in the same transaction, writes what the lane keeps: the run log row,
 * or on failure the record on what the job concerns, with the reason.
 * A record that throws rolls the finish back, so the job stays running until its lease expires;
 * that expiry finishes it again with `timed_out`, not the original reason. */
export async function settle(
	sql: SQL,
	{ keeps }: Pick<Lane, "keeps">,
	job: { id: string; attempt: number },
	target: Target,
	{
		dueInSeconds = 0,
		reason,
		attempts = "kept",
	}: {
		dueInSeconds?: number;
		reason?: FailureReason;
		/** `reset` starts the retry count over, as for a repeat that begins a new period. */
		attempts?: "kept" | "reset";
	} = {},
): Promise<boolean> {
	if (!("finished" in target)) {
		const rows = await sql`
			UPDATE jobs SET status = ${target.status}::job_status, lease_until = NULL,
				due_at = now() + make_interval(secs => ${dueInSeconds}),
				attempt = CASE WHEN ${attempts === "reset"} THEN 0 ELSE attempt END
			WHERE id = ${job.id} AND attempt = ${job.attempt} AND status = ${RUNNING}::job_status
			RETURNING 1`;
		return rows.length > 0;
	}
	const failed = target.finished === "failed";
	if (failed && !reason)
		throw new Error(`job ${job.id} failed without a reason`);
	return sql.begin(async (tx) => {
		const [done]: JobRow[] = await tx`
			WITH done AS (
				DELETE FROM jobs
				WHERE id = ${job.id} AND attempt = ${job.attempt} AND status = ${RUNNING}::job_status
				RETURNING id, user_id, kind, attempt, payload
			), logged AS (
				INSERT INTO run_log (id, user_id, kind, outcome, failure_reason, attempt, payload)
				SELECT id, user_id, kind, ${target.finished}::run_outcome,
					${failed ? reason : null}::failure_reason, attempt, payload
				FROM done WHERE ${keeps.to === "run_log"}
			)
			SELECT * FROM done`;
		if (!done) return false;
		if (failed && reason && keeps.to === "subject")
			await keeps.failed(tx, toJob(done), reason);
		return true;
	});
}

/** Every running job whose lease ran out counts as a failed attempt: back to ready, or failed when none remain.
 * A job whose finish throws is logged and its lease pushed forward by its lane's timeout,
 * so it never stops the other jobs or wakes the executor again at once. */
export async function expireLeases(sql: SQL, lanes: Lanes): Promise<void> {
	const rows: { id: string; kind: string; attempt: number }[] = await sql`
		SELECT id, kind, attempt FROM jobs
		WHERE status = ${RUNNING}::job_status AND lease_until <= now()
		ORDER BY lease_until, id`;
	for (const row of rows) {
		const lane = lanes[row.kind];
		if (!lane) throw new Error(`no lane for job kind ${row.kind}`);
		const target = transition(
			RUNNING,
			failure(lane.retry, row.attempt, "expire"),
		);
		if (!target) throw new Error("running refused a lease expiry");
		try {
			await settle(sql, lane, row, target, { reason: "timed_out" });
		} catch (error) {
			console.error(
				`job ${row.id} ${row.kind}: lease expiry not recorded`,
				error,
			);
			await sql`
				UPDATE jobs SET lease_until = now() + make_interval(secs => ${lane.timeoutSeconds})
				WHERE id = ${row.id} AND attempt = ${row.attempt} AND status = ${RUNNING}::job_status`;
		}
	}
}

/** Seconds until the next job of these kinds comes due or the next lease runs out, by Postgres's clock.
 * Zero or less means now; undefined means nothing is pending. */
export async function secondsUntilNext(
	sql: SQL,
	kinds: string[],
): Promise<number | undefined> {
	const [row]: { seconds: number | null }[] = await sql`
		SELECT EXTRACT(EPOCH FROM least(
			(SELECT min(due_at) FROM jobs
				WHERE kind::text = ANY(${sql.array(kinds, "TEXT")})
					AND status = ANY(${statuses(sql, sources("claim"))}::job_status[])),
			(SELECT min(lease_until) FROM jobs WHERE status = ${RUNNING}::job_status)
		) - now())::float8 AS seconds`;
	return row?.seconds ?? undefined;
}
