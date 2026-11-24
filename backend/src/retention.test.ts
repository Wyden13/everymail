import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { migrate } from "./migrate";
import { sweep } from "./retention";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for the retention sweep");

const schema = `retention_test_${process.pid}`;
const admin = new SQL(url, { max: 1 });
const sql = new SQL(url, { max: 2, connection: { search_path: schema } });

beforeAll(async () => {
	await admin.unsafe(`CREATE SCHEMA ${schema}`);
	await migrate(sql);
});

afterAll(async () => {
	await sql.close();
	await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
	await admin.close();
});

test("the sweep deletes the user's run log past 90 days and nothing else", async () => {
	const [{ id: userId }, { id: strangerId }] = await sql`
		INSERT INTO users (provider, subject, email)
		VALUES ('google', 'a', 'a@b.c'), ('google', 'b', 'b@b.c') RETURNING id`;
	await sql`
		INSERT INTO run_log (id, user_id, kind, outcome, attempt, finished_at, payload)
		VALUES (1, ${userId}, 'retention', 'succeeded', 1, now() - interval '89 days', ''),
			(2, ${userId}, 'retention', 'succeeded', 1, now() - interval '91 days', ''),
			(3, ${strangerId}, 'retention', 'succeeded', 1, now() - interval '91 days', '')`;
	await sweep(sql, userId);
	expect(
		(await sql`SELECT id FROM run_log ORDER BY id`).map(
			(r: { id: string }) => r.id,
		),
	).toEqual(["1", "3"]);
});
