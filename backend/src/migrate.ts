import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SQL } from "bun";

const DIR = join(import.meta.dir, "../migrations");

/** Arbitrary constant naming the lock every process takes while it migrates. */
const LOCK = 7_310_001;

/** Applies every migration not yet recorded, in name order, in one transaction. Returns their names.
 * Processes starting together wait on one lock, so only the first applies anything. */
export async function migrate(sql: SQL): Promise<string[]> {
	const names = (await readdir(DIR)).filter((n) => n.endsWith(".sql")).sort();
	return sql.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(${LOCK})`;
		await tx`CREATE TABLE IF NOT EXISTS migrations (
			name text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`;
		const done = new Set(
			(await tx`SELECT name FROM migrations`).map(
				(r: { name: string }) => r.name,
			),
		);
		const pending = names.filter((n) => !done.has(n));
		for (const name of pending) {
			await tx.unsafe(await Bun.file(join(DIR, name)).text());
			await tx`INSERT INTO migrations (name) VALUES (${name})`;
		}
		return pending;
	});
}
