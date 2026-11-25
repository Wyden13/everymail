import { expect, test } from "bun:test";
import {
	backoffSeconds,
	type Event,
	failure,
	freeSlots,
	type Lane,
	type Status,
	sources,
	type Target,
	transition,
} from "./job";

const STATUSES: Status[] = [
	"scheduled",
	"ready",
	"running",
	"waiting_for_approval",
	"waiting_for_event",
	"paused",
];
const EVENTS: Event[] = [
	"claim",
	"succeed",
	"fail",
	"expire",
	"exhaust",
	"await_approval",
	"await_event",
	"resolve",
	"pause",
	"resume",
	"repeat",
	"cancel",
];

/** "event status" for every allowed move; every other pair is refused. */
const ALLOWED: Record<string, Target> = {
	"claim scheduled": { status: "running" },
	"claim ready": { status: "running" },
	"succeed running": { finished: "succeeded" },
	"fail running": { status: "scheduled" },
	"expire running": { status: "ready" },
	"exhaust running": { finished: "failed" },
	"await_approval running": { status: "waiting_for_approval" },
	"await_event running": { status: "waiting_for_event" },
	"resolve waiting_for_approval": { status: "ready" },
	"resolve waiting_for_event": { status: "ready" },
	"pause scheduled": { status: "paused" },
	"pause ready": { status: "paused" },
	"resume paused": { status: "ready" },
	"repeat running": { status: "scheduled" },
	"cancel scheduled": { finished: "cancelled" },
	"cancel ready": { finished: "cancelled" },
	"cancel waiting_for_approval": { finished: "cancelled" },
	"cancel waiting_for_event": { finished: "cancelled" },
	"cancel paused": { finished: "cancelled" },
};

test("every status and event pair moves as allowed or is refused", () => {
	for (const event of EVENTS) {
		for (const status of STATUSES) {
			expect([event, status, transition(status, event)]).toEqual([
				event,
				status,
				ALLOWED[`${event} ${status}`],
			]);
		}
	}
});

test("sources lists exactly the statuses an event moves", () => {
	expect(sources("claim")).toEqual(["scheduled", "ready"]);
	expect(sources("cancel")).not.toContain("running");
	expect(sources("expire")).toEqual(["running"]);
});

const policy = { maxAttempts: 4, baseSeconds: 10, capSeconds: 60 };

test("backoff doubles from the base and stops at the cap", () => {
	expect([1, 2, 3, 4, 5].map((a) => backoffSeconds(policy, a))).toEqual([
		10, 20, 40, 60, 60,
	]);
});

test("a failure is retried until the last attempt, which exhausts the job", () => {
	expect(failure(policy, 3, "fail")).toBe("fail");
	expect(failure(policy, 3, "expire")).toBe("expire");
	expect(failure(policy, 4, "fail")).toBe("exhaust");
	expect(failure(policy, 4, "expire")).toBe("exhaust");
});

const lane = (concurrency: number): Lane => ({
	concurrency,
	timeoutSeconds: 30,
	retry: policy,
	keeps: { to: "subject", failed: async () => {} },
	run: async () => "succeed",
});

test("a full lane leaves the other lanes' slots untouched", () => {
	const lanes = { agent: lane(2), send: lane(3) };
	expect(freeSlots(lanes, new Map([["agent", 2]]))).toEqual([["send", 3]]);
	expect(
		freeSlots(
			lanes,
			new Map([
				["agent", 1],
				["send", 1],
			]),
		),
	).toEqual([
		["agent", 1],
		["send", 2],
	]);
});
