import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { SQL } from "bun";
import { AccountJobSchema, SendJobSchema } from "./gen/jobs/v1/jobs_pb";
import { claim, enqueue, settle } from "./jobs";
import { migrate } from "./migrate";
import { failsOn } from "./subjects";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for the subject records");

/** A throwaway schema, so the test kind added below never reaches the real enum. */
const schema = `subjects_test_${process.pid}`;
const admin = new SQL(url, { max: 1 });
const sql = new SQL(url, { max: 2, connection: { search_path: schema } });

let userId: string;
let strangerId: string;

beforeAll(async () => {
	await admin.unsafe(`CREATE SCHEMA ${schema}`);
	await migrate(sql);
	await sql`ALTER TYPE job_kind ADD VALUE 'test'`;
	[{ id: userId }, { id: strangerId }] = await sql`
		INSERT INTO users (provider, subject, email)
		VALUES ('google', 'a', 'a@b.c'), ('google', 'b', 'b@b.c') RETURNING id`;
});

afterAll(async () => {
	await sql.close();
	await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
	await admin.close();
});

beforeEach(async () => {
	await sql`DELETE FROM jobs`;
	await sql`DELETE FROM accounts`;
});

const addAccount = async (owner = userId): Promise<string> =>
	(await sql`INSERT INTO accounts (user_id) VALUES (${owner}) RETURNING id`)[0]
		.id;

const addSend = async (accountId: string): Promise<string> =>
	(
		await sql`INSERT INTO sends (user_id, account_id, status)
			VALUES (${userId}, ${accountId}, 'sending') RETURNING id`
	)[0].id;

const accountJob = (id: string) =>
	toBinary(
		AccountJobSchema,
		create(AccountJobSchema, { accountId: BigInt(id) }),
	);

const sendJob = (id: string) =>
	toBinary(SendJobSchema, create(SendJobSchema, { sendId: BigInt(id) }));

/** Claims a job with this payload and finishes it failed under the given subject. */
const exhaust = async (
	table: Parameters<typeof failsOn>[0],
	payload: Uint8Array,
) => {
	await enqueue(sql, { userId, kind: "test", payload, dueInSeconds: 0 });
	const [job] = await claim(sql, "test", 1, 30);
	if (!job) throw new Error("not claimed");
	return settle(
		sql,
		{ keeps: failsOn(table) },
		job,
		{ finished: "failed" },
		{ reason: "threw" },
	);
};

const stateOf = async (table: "accounts" | "sends", id: string) =>
	(
		await sql`SELECT status, failure_reason FROM ${sql(table)} WHERE id = ${id}`
	)[0];

test("an exhausted job marks its account or send failed with the reason, and no other row", async () => {
	const account = await addAccount();
	const other = await addAccount();
	const send = await addSend(other);
	const untouched = await addSend(other);
	expect(await exhaust("accounts", accountJob(account))).toBe(true);
	expect(await exhaust("sends", sendJob(send))).toBe(true);
	expect(await stateOf("accounts", account)).toEqual({
		status: "failed",
		failure_reason: "threw",
	});
	expect(await stateOf("sends", send)).toEqual({
		status: "failed",
		failure_reason: "threw",
	});
	expect(await stateOf("accounts", other)).toEqual({
		status: "syncing",
		failure_reason: null,
	});
	expect(await stateOf("sends", untouched)).toEqual({
		status: "sending",
		failure_reason: null,
	});
});

test("a subject that is gone or another user's is left alone and the job still finishes", async () => {
	const theirs = await addAccount(strangerId);
	const gone = await addAccount();
	await sql`DELETE FROM accounts WHERE id = ${gone}`;
	expect(await exhaust("accounts", accountJob(theirs))).toBe(true);
	expect(await exhaust("accounts", accountJob(gone))).toBe(true);
	expect(await stateOf("accounts", theirs)).toEqual({
		status: "syncing",
		failure_reason: null,
	});
	expect(await sql`SELECT 1 FROM jobs`).toEqual([]);
});
