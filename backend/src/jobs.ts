import type { SQL } from "bun";
import {
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

/** Adds a job due after a delay. Runs in the caller's transaction; the caller wakes the executor after it commits. */
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

/** Moves up to `limit` due jobs of a kind to running under a lease, oldest due first, and commits.
 * Rows another claim holds are skipped, never waited on. */
export async function claim(
	sql: SQL,
	kind: string,
	limit: number,
	leaseSeconds: number,
): Promise<Job[]> {
	const rows: {
		id: string;
		user_id: string;
		attempt: number;
		payload: Uint8Array;
	}[] = await sql`
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
		RETURNING id, user_id, attempt, payload`;
	return rows.map((r) => ({
		id: r.id,
		userId: r.user_id,
		kind,
		attempt: r.attempt,
		payload: r.payload,
	}));
}

/** Records how a claimed attempt ended. Applies only while that attempt still holds the job,
 * so a finish arriving after its lease expired changes nothing. Returns whether it applied.
 * A finish deletes the job and, for a logged lane, writes the run log row in the same statement. */
export async function settle(
	sql: SQL,
	lane: Pick<Lane, "log">,
	job: { id: string; attempt: number },
	target: Target,
	dueInSeconds = 0,
): Promise<boolean> {
	const rows =
		"finished" in target
			? await sql`
				WITH done AS (
					DELETE FROM jobs
					WHERE id = ${job.id} AND attempt = ${job.attempt} AND status = ${RUNNING}::job_status
					RETURNING id, user_id, kind, attempt, payload
				), logged AS (
					INSERT INTO run_log (id, user_id, kind, outcome, attempt, payload)
					SELECT id, user_id, kind, ${target.finished}::run_outcome, attempt, payload
					FROM done WHERE ${lane.log}
				)
				SELECT 1 FROM done`
			: await sql`
				UPDATE jobs SET status = ${target.status}::job_status, lease_until = NULL,
					due_at = now() + make_interval(secs => ${dueInSeconds})
				WHERE id = ${job.id} AND attempt = ${job.attempt} AND status = ${RUNNING}::job_status
				RETURNING 1`;
	return rows.length > 0;
}

/** Every running job whose lease ran out counts as a failed attempt: back to ready, or failed when none remain. */
export async function expireLeases(sql: SQL, lanes: Lanes): Promise<void> {
	const rows: { id: string; kind: string; attempt: number }[] = await sql`
		SELECT id, kind, attempt FROM jobs
		WHERE status = ${RUNNING}::job_status AND lease_until <= now()`;
	for (const row of rows) {
		const lane = lanes[row.kind];
		if (!lane) throw new Error(`no lane for job kind ${row.kind}`);
		const target = transition(
			RUNNING,
			failure(lane.retry, row.attempt, "expire"),
		);
		if (!target) throw new Error("running refused a lease expiry");
		await settle(sql, lane, row, target);
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
