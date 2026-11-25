import { beforeAll, beforeEach, expect, test } from "bun:test";
import type { SQL } from "bun";
import type { Lane } from "./job";
import {
	claim,
	commit,
	enqueue,
	expireLeases,
	secondsUntilNext,
	settle,
} from "./jobs";
import { useSchema } from "./testdb";

const sql = useSchema("jobs");

const lane: Lane = {
	concurrency: 2,
	timeoutSeconds: 30,
	retry: { maxAttempts: 2, baseSeconds: 10, capSeconds: 60 },
	log: true,
	run: async () => "succeed",
};
const lanes = { test: lane };
const logged = { log: true };
let userId: string;

beforeAll(async () => {
	// An added enum value is usable only once the transaction that added it commits
	await sql`ALTER TYPE job_kind ADD VALUE 'test'`;
	[{ id: userId }] = await sql`
		INSERT INTO users (provider, subject, email) VALUES ('google', 's', 'a@b.c') RETURNING id`;
});

beforeEach(async () => {
	await sql`DELETE FROM jobs`;
	await sql`DELETE FROM run_log`;
});

const add = (dueInSeconds: number, payload = new Uint8Array()) =>
	enqueue(sql, { userId, kind: "test", payload, dueInSeconds });

const statusOf = async (id: string) =>
	(await sql`SELECT status FROM jobs WHERE id = ${id}`)[0]?.status;

const logOf = (id: string) =>
	sql`SELECT kind, outcome, failure_reason, attempt, payload FROM run_log WHERE id = ${id}`;

const unlogged = { log: false };

test("claims due jobs only, oldest due first, then by id, up to the limit", async () => {
	const late = await add(-5);
	const early = await add(-60);
	const tie = await add(-5);
	await add(3600);
	const first = await claim(sql, "test", 1, 30);
	expect(first.map((j) => j.id)).toEqual([early]);
	const rest = await claim(sql, "test", 10, 30);
	expect(rest.map((j) => j.id).sort()).toEqual([late, tie].sort());
	expect(await claim(sql, "test", 10, 30)).toEqual([]);
});

test("a claim counts the attempt and carries the payload", async () => {
	const id = await add(0, new Uint8Array([1, 2, 3]));
	const [job] = await claim(sql, "test", 1, 30);
	expect(job).toMatchObject({ id, userId, kind: "test", attempt: 1 });
	expect([...(job?.payload ?? [])]).toEqual([1, 2, 3]);
	expect(await statusOf(id)).toBe("running");
});

test("two claims at once never take the same job", async () => {
	for (let i = 0; i < 6; i++) await add(-1);
	const [a, b] = await Promise.all([
		claim(sql, "test", 4, 30),
		claim(sql, "test", 4, 30),
	]);
	const ids = [...(a ?? []), ...(b ?? [])].map((j) => j.id);
	expect(ids.length).toBe(6);
	expect(new Set(ids).size).toBe(6);
});

test("an expired lease returns the job to ready, then fails it once attempts run out", async () => {
	const id = await add(0);
	await claim(sql, "test", 1, -1);
	await expireLeases(sql, lanes);
	expect(await statusOf(id)).toBe("ready");
	const [again] = await claim(sql, "test", 1, -1);
	expect(again?.attempt).toBe(2);
	await expireLeases(sql, lanes);
	expect(await statusOf(id)).toBeUndefined();
	expect((await logOf(id))[0]).toMatchObject({
		outcome: "failed",
		failure_reason: "timed_out",
		attempt: 2,
	});
});

test("a lease still running is left alone", async () => {
	const id = await add(0);
	await claim(sql, "test", 1, 30);
	await expireLeases(sql, lanes);
	expect(await statusOf(id)).toBe("running");
});

test("a finish from an older attempt changes nothing", async () => {
	const id = await add(0);
	const [stale] = await claim(sql, "test", 1, -1);
	await expireLeases(sql, lanes);
	const [current] = await claim(sql, "test", 1, 30);
	if (!stale || !current) throw new Error("not claimed");
	expect(await settle(sql, logged, stale, { finished: "succeeded" })).toBe(
		false,
	);
	expect(await statusOf(id)).toBe("running");
	expect(await logOf(id)).toEqual([]);
	expect(await settle(sql, logged, current, { finished: "succeeded" })).toBe(
		true,
	);
	expect(await statusOf(id)).toBeUndefined();
});

test("a finish deletes the job and logs its outcome and payload under the job's id", async () => {
	const id = await add(0, new Uint8Array([7]));
	const [job] = await claim(sql, "test", 1, 30);
	if (!job) throw new Error("not claimed");
	expect(await settle(sql, logged, job, { finished: "succeeded" })).toBe(true);
	expect(await statusOf(id)).toBeUndefined();
	const [row] = await logOf(id);
	expect(row).toMatchObject({
		kind: "test",
		outcome: "succeeded",
		failure_reason: null,
		attempt: 1,
	});
	expect([...row.payload]).toEqual([7]);
});

test("a failed run is logged with its reason", async () => {
	const id = await add(0);
	const [job] = await claim(sql, "test", 1, 30);
	if (!job) throw new Error("not claimed");
	expect(
		await settle(sql, logged, job, { finished: "failed" }, { reason: "threw" }),
	).toBe(true);
	expect((await logOf(id))[0]).toMatchObject({
		outcome: "failed",
		failure_reason: "threw",
	});
});

test("a lane that does not log deletes its finished job and writes nothing", async () => {
	for (const finished of ["succeeded", "failed", "cancelled"] as const) {
		const id = await add(0);
		const [job] = await claim(sql, "test", 1, 30);
		if (!job) throw new Error("not claimed");
		expect(
			await settle(sql, unlogged, job, { finished }, { reason: "threw" }),
		).toBe(true);
		expect(await statusOf(id)).toBeUndefined();
		expect(await logOf(id)).toEqual([]);
	}
});

test("a failure without a reason is refused and leaves the job running", async () => {
	const id = await add(0);
	const [job] = await claim(sql, "test", 1, 30);
	if (!job) throw new Error("not claimed");
	await expect(
		settle(sql, unlogged, job, { finished: "failed" }),
	).rejects.toThrow();
	expect(await statusOf(id)).toBe("running");
});

test("a retried attempt is scheduled after its backoff", async () => {
	const id = await add(0);
	const [job] = await claim(sql, "test", 1, 30);
	if (!job) throw new Error("not claimed");
	await settle(
		sql,
		logged,
		job,
		{ status: "scheduled" },
		{ dueInSeconds: 3600 },
	);
	expect(await statusOf(id)).toBe("scheduled");
	expect(await claim(sql, "test", 1, 30)).toEqual([]);
});

test("a repeat keeps the row and its attempt count, scheduled after its interval", async () => {
	const id = await add(0);
	const [job] = await claim(sql, "test", 1, 30);
	if (!job) throw new Error("not claimed");
	await settle(
		sql,
		logged,
		job,
		{ status: "scheduled" },
		{ dueInSeconds: 3600 },
	);
	expect(
		await sql`SELECT status, attempt, due_at > now() + interval '59 minutes' AS later
			FROM jobs WHERE id = ${id}`,
	).toEqual([{ status: "scheduled", attempt: 1, later: true }]);
	expect(await logOf(id)).toEqual([]);
});

test("the next wake is the nearest due time or lease end", async () => {
	expect(await secondsUntilNext(sql, ["test"])).toBeUndefined();
	await add(3600);
	const due = await secondsUntilNext(sql, ["test"]);
	expect(due).toBeGreaterThan(3590);
	expect(due).toBeLessThanOrEqual(3600);
	// A full lane's due jobs do not wake the executor
	expect(await secondsUntilNext(sql, [])).toBeUndefined();
	await add(0);
	await claim(sql, "test", 1, 600);
	const lease = await secondsUntilNext(sql, []);
	expect(lease).toBeGreaterThan(590);
	expect(lease).toBeLessThanOrEqual(600);
});

test("commit wakes the executor once the enqueue is visible, and a rollback wakes nothing", async () => {
	let wakes = 0;
	const wake = () => {
		wakes++;
	};
	const enqueueIn = (tx: SQL) =>
		enqueue(tx, {
			userId,
			kind: "test",
			payload: new Uint8Array(),
			dueInSeconds: 0,
		});
	const id = await commit(sql, wake, async (tx) => {
		const added = await enqueueIn(tx);
		expect(wakes).toBe(0);
		return added;
	});
	expect(wakes).toBe(1);
	expect(await statusOf(id)).toBe("scheduled");
	await expect(
		commit(sql, wake, async (tx) => {
			await enqueueIn(tx);
			throw new Error("rolled back");
		}),
	).rejects.toThrow("rolled back");
	expect(wakes).toBe(1);
	expect(await sql`SELECT id FROM jobs`).toHaveLength(1);
});
