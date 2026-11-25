import { afterAll, beforeAll } from "bun:test";
import { SQL } from "bun";
import { migrate } from "./migrate";

/** A throwaway schema, migrated before the file's tests and dropped after, so no test touches the real tables.
 * Its hooks run before any the caller registers later. */
export function useSchema(name: string): SQL {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL is required for the database tests");
	const schema = `${name}_test_${process.pid}`;
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
	return sql;
}
