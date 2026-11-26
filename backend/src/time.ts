import { SQL } from "bun";
import type { Schedule, ScheduledTime } from "./gen/api/v1/time_pb";
import { Refused } from "./rpc";

/** Evaluates one instant in Postgres. One that does not exist, such as an unknown zone or a day the month
 * lacks, is refused as a bad request. */
async function one(sql: SQL, value: SQL.Query<unknown>): Promise<Date> {
	try {
		const [row]: [{ at: Date }] = await sql`SELECT ${value} AS at`;
		return row.at;
	} catch (error) {
		// Class 22 is a data exception: out of range or not recognized
		if (error instanceof SQL.PostgresError && error.errno?.startsWith("22"))
			throw new Refused(400, error.message);
		throw error;
	}
}

/** The UTC instant a client's scheduled time names, by Postgres's time zone database, so the server holds the
 * only copy of the zone rules. Postgres moves a wall time skipped by a daylight saving change forward by the
 * gap and takes the later of one that happens twice. An instant, date, time or zone that does not exist is
 * refused as a bad request. */
export async function instant(sql: SQL, time: ScheduledTime): Promise<Date> {
	const { at } = time;
	if (!at.case) throw new Error("unset oneof in api.v1.ScheduledTime");
	return one(
		sql,
		at.case === "unixSeconds"
			? sql`to_timestamp(${at.value.toString()}::float8)`
			: sql`make_timestamptz(${at.value.year}, ${at.value.month}, ${at.value.day},
				${at.value.hour}, ${at.value.minute}, 0, ${at.value.zone})`,
	);
}

/** The first run of a schedule strictly after `after`. It reads no clock, so after downtime a caller passing
 * Postgres `now()` gets one run, not one per missed slot. A clock time is placed on each local day by the same
 * zone rules as `instant`, so a day whose time a daylight saving change skips or repeats still runs once. */
export async function next(
	sql: SQL,
	schedule: Schedule,
	after: Date,
): Promise<Date> {
	const { every } = schedule;
	if (!every.case) throw new Error("unset oneof in api.v1.Schedule");
	if (every.case === "intervalSeconds")
		return one(
			sql,
			sql`${after}::timestamptz + make_interval(secs => ${every.value})`,
		);
	const { hour, minute, zone } = every.value;
	// Eight local days always hold the next slot, a weekday one included
	return one(
		sql,
		sql`(SELECT min(t) FROM generate_series(0, 7) AS n,
			LATERAL (SELECT (${after}::timestamptz AT TIME ZONE ${zone})::date + n AS d) AS day,
			LATERAL make_timestamptz(extract(year FROM d)::int, extract(month FROM d)::int,
				extract(day FROM d)::int, ${hour}, ${minute}, 0, ${zone}) AS t
			WHERE t > ${after}::timestamptz
				AND (${every.case === "daily"} OR extract(isodow FROM d) < 6))`,
	);
}
