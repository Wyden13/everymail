import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ScheduledTimeSchema, ScheduleSchema } from "./gen/api/v1/time_pb";
import { enqueue } from "./jobs";
import { Refused } from "./rpc";
import { useJobs } from "./testdb";
import { instant, next } from "./time";

const { sql, users } = useJobs("time");

const wall = ([year, month, day, hour, minute]: number[], zone: string) =>
	create(ScheduledTimeSchema, {
		at: {
			case: "wall",
			value: { year, month, day, hour, minute, zone },
		},
	});
const unix = (seconds: bigint) =>
	create(ScheduledTimeSchema, { at: { case: "unixSeconds", value: seconds } });

// New York springs forward at 02:00 on 8 March 2026 and falls back at 02:00 on 1 November 2026
const converted: [string, ReturnType<typeof wall>, string][] = [
	["a UTC instant", unix(1_780_000_000n), "2026-05-28T20:26:40.000Z"],
	[
		"standard time",
		wall([2026, 1, 15, 8, 0], "America/New_York"),
		"2026-01-15T13:00:00.000Z",
	],
	[
		"daylight time",
		wall([2026, 7, 15, 8, 0], "America/New_York"),
		"2026-07-15T12:00:00.000Z",
	],
	[
		"the minute before the gap",
		wall([2026, 3, 8, 1, 59], "America/New_York"),
		"2026-03-08T06:59:00.000Z",
	],
	[
		"inside the gap, moved forward by it",
		wall([2026, 3, 8, 2, 30], "America/New_York"),
		"2026-03-08T07:30:00.000Z",
	],
	[
		"the first minute after the gap",
		wall([2026, 3, 8, 3, 0], "America/New_York"),
		"2026-03-08T07:00:00.000Z",
	],
	[
		"inside the overlap, the later",
		wall([2026, 11, 1, 1, 30], "America/New_York"),
		"2026-11-01T06:30:00.000Z",
	],
	[
		"just after the overlap",
		wall([2026, 11, 1, 2, 0], "America/New_York"),
		"2026-11-01T07:00:00.000Z",
	],
	[
		"a southern zone's overlap",
		wall([2026, 4, 5, 2, 30], "Australia/Sydney"),
		"2026-04-04T16:30:00.000Z",
	],
	[
		"a half hour zone",
		wall([2026, 6, 1, 9, 0], "Asia/Kolkata"),
		"2026-06-01T03:30:00.000Z",
	],
];

test("a scheduled time becomes its UTC instant", async () => {
	for (const [, time, utc] of converted)
		expect((await instant(sql, time)).toISOString()).toBe(utc);
});

const refused: [string, ReturnType<typeof wall>][] = [
	["an unknown zone", wall([2026, 6, 1, 9, 0], "Nowhere/Town")],
	["a day the month lacks", wall([2026, 2, 30, 9, 0], "UTC")],
	["month 13", wall([2026, 13, 1, 9, 0], "UTC")],
	["minute 60", wall([2026, 6, 1, 9, 60], "UTC")],
	["an instant past the range", unix(9_000_000_000_000_000n)],
];

test("a time that does not exist is refused as a bad request", async () => {
	for (const [, time] of refused) {
		const error = await instant(sql, time).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Refused);
		expect((error as Refused).status).toBe(400);
	}
});

test("a job enqueued at an instant is stored at that instant", async () => {
	const at = await instant(sql, wall([2026, 3, 8, 2, 30], "America/New_York"));
	const id = await enqueue(sql, {
		userId: users.a,
		kind: "test",
		payload: new Uint8Array(),
		due: { at },
	});
	const [row] = await sql`SELECT due_at FROM jobs WHERE id = ${id}`;
	expect(row.due_at.toISOString()).toBe("2026-03-08T07:30:00.000Z");
});

const every = (seconds: number) =>
	create(ScheduleSchema, {
		every: { case: "intervalSeconds", value: seconds },
	});
const clock = (
	kind: "daily" | "weekdays",
	[hour, minute]: number[],
	zone: string,
) =>
	create(ScheduleSchema, {
		every: { case: kind, value: { hour, minute, zone } },
	});

// Same New York changes as above; 6 March 2026 is a Friday
const runs: [string, ReturnType<typeof every>, string, string][] = [
	[
		"every 15 minutes",
		every(900),
		"2026-01-15T13:00:00Z",
		"2026-01-15T13:15:00.000Z",
	],
	[
		"every hour",
		every(3600),
		"2026-01-15T13:20:00Z",
		"2026-01-15T14:20:00.000Z",
	],
	[
		"an interval across spring forward stays exact seconds",
		every(3600),
		"2026-03-08T06:30:00Z",
		"2026-03-08T07:30:00.000Z",
	],
	[
		"daily, before the day's slot",
		clock("daily", [8, 0], "America/New_York"),
		"2026-01-15T12:00:00Z",
		"2026-01-15T13:00:00.000Z",
	],
	[
		"daily, at the slot itself, is the next day",
		clock("daily", [8, 0], "America/New_York"),
		"2026-01-15T13:00:00Z",
		"2026-01-16T13:00:00.000Z",
	],
	[
		"daily, across spring forward, keeps the clock time",
		clock("daily", [8, 0], "America/New_York"),
		"2026-03-07T13:00:00Z",
		"2026-03-08T12:00:00.000Z",
	],
	[
		"daily, across fall back, keeps the clock time",
		clock("daily", [8, 0], "America/New_York"),
		"2026-10-31T12:00:00Z",
		"2026-11-01T13:00:00.000Z",
	],
	[
		"daily, inside the gap, moved forward by it",
		clock("daily", [2, 30], "America/New_York"),
		"2026-03-08T00:00:00Z",
		"2026-03-08T07:30:00.000Z",
	],
	[
		"daily, inside the overlap, the later",
		clock("daily", [1, 30], "America/New_York"),
		"2026-11-01T04:00:00Z",
		"2026-11-01T06:30:00.000Z",
	],
	[
		"daily, after the first of the overlap, still that day's one run",
		clock("daily", [1, 30], "America/New_York"),
		"2026-11-01T05:30:00Z",
		"2026-11-01T06:30:00.000Z",
	],
	[
		"daily, after the overlap's run, the next day",
		clock("daily", [1, 30], "America/New_York"),
		"2026-11-01T06:30:00Z",
		"2026-11-02T06:30:00.000Z",
	],
	[
		"weekdays, on a weekday before the slot",
		clock("weekdays", [9, 0], "America/New_York"),
		"2026-03-05T13:00:00Z",
		"2026-03-05T14:00:00.000Z",
	],
	[
		"weekdays, Friday after the slot, is Monday across spring forward",
		clock("weekdays", [9, 0], "America/New_York"),
		"2026-03-06T15:00:00Z",
		"2026-03-09T13:00:00.000Z",
	],
	[
		"weekdays, Saturday, is Monday",
		clock("weekdays", [9, 0], "America/New_York"),
		"2026-03-07T15:00:00Z",
		"2026-03-09T13:00:00.000Z",
	],
	[
		"weekdays, by the local day where it is already Monday",
		clock("weekdays", [9, 0], "Pacific/Auckland"),
		"2026-03-08T19:00:00Z",
		"2026-03-08T20:00:00.000Z",
	],
	[
		"daily, a southern zone's overlap, the later",
		clock("daily", [2, 30], "Australia/Sydney"),
		"2026-04-04T14:00:00Z",
		"2026-04-04T16:30:00.000Z",
	],
];

test("a schedule's next run is its first slot after an instant", async () => {
	for (const [name, schedule, after, utc] of runs)
		expect([
			name,
			(await next(sql, schedule, new Date(after))).toISOString(),
		]).toEqual([name, utc]);
});

test("a schedule with a time or zone that does not exist is refused as a bad request", async () => {
	for (const schedule of [
		clock("daily", [8, 0], "Nowhere/Town"),
		clock("weekdays", [9, 60], "UTC"),
	]) {
		const error = await next(
			sql,
			schedule,
			new Date("2026-01-15T12:00:00Z"),
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Refused);
		expect((error as Refused).status).toBe(400);
	}
});
