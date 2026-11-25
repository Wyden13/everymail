import { expect, test } from "bun:test";
import { ensure, sweep } from "./retention";
import { useSchema } from "./testdb";

const sql = useSchema("retention");

test("the sweep deletes the user's run log past 90 days and nothing else", async () => {
	const [{ id: userId }, { id: strangerId }] = await sql`
		INSERT INTO users (provider, subject, email)
		VALUES ('google', 'sweep-a', 'a@b.c'), ('google', 'sweep-b', 'b@b.c') RETURNING id`;
	const ids = await sql`
		INSERT INTO run_log (id, user_id, kind, outcome, attempt, finished_at, payload)
		VALUES (1, ${userId}, 'retention', 'succeeded', 1, now() - interval '89 days', ''),
			(2, ${userId}, 'retention', 'succeeded', 1, now() - interval '91 days', ''),
			(3, ${strangerId}, 'retention', 'succeeded', 1, now() - interval '91 days', '')
		RETURNING id`;
	await sweep(sql, userId);
	expect(
		(
			await sql`SELECT id FROM run_log WHERE id IN ${sql(ids.map((r: { id: string }) => r.id))} ORDER BY id`
		).map((r: { id: string }) => r.id),
	).toEqual(["1", "3"]);
});

test("every user gets one retention job, and ensuring again adds none", async () => {
	const users = await sql`
		INSERT INTO users (provider, subject, email)
		VALUES ('google', 'ensure-a', 'c@b.c'), ('google', 'ensure-b', 'd@b.c') RETURNING id`;
	const [{ id: keptId }] = users;
	await sql`
		INSERT INTO jobs (user_id, kind, status, due_at, payload)
		VALUES (${keptId}, 'retention', 'scheduled', now(), '')`;
	for (const _ of [1, 2]) await ensure(sql);
	expect(
		await sql`SELECT u.subject, count(j.id)::int AS jobs FROM users u
			LEFT JOIN jobs j ON j.user_id = u.id AND j.kind = 'retention'
			WHERE u.subject LIKE 'ensure-%'
			GROUP BY u.subject ORDER BY u.subject`,
	).toEqual([
		{ subject: "ensure-a", jobs: 1 },
		{ subject: "ensure-b", jobs: 1 },
	]);
});
