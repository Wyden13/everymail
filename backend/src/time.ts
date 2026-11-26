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

/** The shortest interval a schedule may repeat at. */
export const MIN_INTERVAL_SECONDS = 900;

/** The longest delay jitter adds to a slot. */
export const MAX_JITTER_SECONDS = 300;

/** The fixed delay a seed adds after each of a schedule's slots: 10% of the interval, a clock time counting as
 * a day, and at most `MAX_JITTER_SECONDS`. One owner always gets the same delay, so its runs stay the interval
 * plus that delay apart and never come early, while owners that share a slot spread out. */
export function jitterSeconds(schedule: Schedule, seed: string): number {
	const { every } = schedule;
	const interval = every.case === "intervalSeconds" ? every.value : 86_400;
	const range = Math.min(Math.floor(interval / 10), MAX_JITTER_SECONDS);
	return Number(Bun.hash(seed) % BigInt(range));
}

/** The first run of a schedule strictly after `after`: its slot plus the seed's jitter. It reads no clock, so
 * after downtime a caller passing Postgres `now()` gets one run, not one per missed slot. A clock time is placed
 * on each local day by the same zone rules as `instant`, so a day whose time a daylight saving change skips or
 * repeats still runs once. An interval under `MIN_INTERVAL_SECONDS` is refused as a bad request, so agent
 * create and update check a schedule by calling this. */
export async function next(
	sql: SQL,
	schedule: Schedule,
	after: Date,
	seed: string,
): Promise<Date> {
	const { every } = schedule;
	if (!every.case) throw new Error("unset oneof in api.v1.Schedule");
	const jitter = sql`make_interval(secs => ${jitterSeconds(schedule, seed)})`;
	if (every.case === "intervalSeconds") {
		if (every.value < MIN_INTERVAL_SECONDS)
			throw new Refused(
				400,
				`an interval under ${MIN_INTERVAL_SECONDS} seconds: ${every.value}`,
			);
		return one(
			sql,
			sql`${after}::timestamptz + make_interval(secs => ${every.value}) + ${jitter}`,
		);
	}
	const { hour, minute, zone } = every.value;
	// Eight local days always hold the next slot, a weekday one included
	return one(
		sql,
		sql`(SELECT min(t) FROM generate_series(0, 7) AS n,
			LATERAL (SELECT (${after}::timestamptz AT TIME ZONE ${zone})::date + n AS d) AS day,
			LATERAL (SELECT make_timestamptz(extract(year FROM d)::int, extract(month FROM d)::int,
				extract(day FROM d)::int, ${hour}, ${minute}, 0, ${zone}) + ${jitter} AS t) AS slot
			WHERE t > ${after}::timestamptz
				AND (${every.case === "daily"} OR extract(isodow FROM d) < 6))`,
	);
}
