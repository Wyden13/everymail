import type { TransactionSQL } from "bun";

export type Status =
	| "scheduled"
	| "ready"
	| "running"
	| "waiting_for_approval"
	| "waiting_for_event"
	| "paused";

export type Event =
	| "claim"
	| "succeed"
	| "fail"
	| "expire"
	| "exhaust"
	| "await_approval"
	| "await_event"
	| "resolve"
	| "pause"
	| "resume"
	| "cancel";

export type Target =
	| { status: Status }
	| { finished: "succeeded" | "failed" | "cancelled" };

const to = (status: Status): Target => ({ status });
const end = (finished: "succeeded" | "failed" | "cancelled"): Target => ({
	finished,
});

const TRANSITIONS: Record<Event, Partial<Record<Status, Target>>> = {
	claim: {
		scheduled: to("running"),
		ready: to("running"),
	},
	succeed: {
		running: end("succeeded"),
	},
	fail: {
		running: to("scheduled"),
	},
	expire: {
		running: to("ready"),
	},
	exhaust: {
		running: end("failed"),
	},
	await_approval: {
		running: to("waiting_for_approval"),
	},
	await_event: {
		running: to("waiting_for_event"),
	},
	resolve: {
		waiting_for_approval: to("ready"),
		waiting_for_event: to("ready"),
	},
	pause: {
		scheduled: to("paused"),
		ready: to("paused"),
	},
	resume: {
		paused: to("ready"),
	},
	cancel: {
		scheduled: end("cancelled"),
		ready: end("cancelled"),
		waiting_for_approval: end("cancelled"),
		waiting_for_event: end("cancelled"),
		paused: end("cancelled"),
	},
};

export const transition = (status: Status, event: Event): Target | undefined =>
	TRANSITIONS[event][status];

export const sources = (event: Event) =>
	Object.keys(TRANSITIONS[event]) as Status[];

export type FailureReason = "timed_out" | "threw";

export type Outcome =
	| Extract<Event, "succeed" | "await_approval" | "await_event">
	| { fail: FailureReason };

export type RetryPolicy = {
	maxAttempts: number;
	baseSeconds: number;
	capSeconds: number;
};

/** Delay before the next try after attempt number `attempt` (1 for the first) failed. */
export const backoffSeconds = (policy: RetryPolicy, attempt: number) =>
	Math.min(policy.capSeconds, policy.baseSeconds * 2 ** (attempt - 1));

export const failure = (
	policy: RetryPolicy,
	attempt: number,
	retry: "fail" | "expire",
): Event => (attempt >= policy.maxAttempts ? "exhaust" : retry);

export type Job = {
	id: string;
	userId: string;
	kind: string;
	attempt: number;
	payload: Uint8Array;
};

/** What a lane's finished jobs keep once their row is deleted. */
export type Keeps =
	/** Agent runs: every finish is written to the run log. */
	| { to: "run_log" }
	/** Any other kind: a job that exhausts its retries shows on what it concerns
	 * (an account's status, a message's send state). `failed` gets the deleted row, payload included,
	 * and runs inside the transaction that deletes the job, so it only writes to the database.
	 * A subject that no longer exists is a no-op, not an error. */
	| {
			to: "subject";
			failed: (
				tx: TransactionSQL,
				job: Job,
				reason: FailureReason,
			) => Promise<void>;
	  };

export type Lane = {
	concurrency: number;
	timeoutSeconds: number;
	retry: RetryPolicy;
	keeps: Keeps;
	run: (job: Job, signal: AbortSignal) => Promise<Outcome>;
};

export type Lanes = Readonly<Record<string, Lane>>;

export const freeSlots = (
	lanes: Lanes,
	running: ReadonlyMap<string, number>,
): [kind: string, free: number][] =>
	Object.entries(lanes)
		.map(([kind, lane]): [string, number] => [
			kind,
			lane.concurrency - (running.get(kind) ?? 0),
		])
		.filter(([, free]) => free > 0);
