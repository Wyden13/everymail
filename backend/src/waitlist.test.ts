import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { JoinRequestSchema } from "./gen/api/v1/waitlist_pb";
import { useSchema } from "./testdb";
import { join, plausible } from "./waitlist";

const addresses: [string, boolean][] = [
	["a@b.co", true],
	["first.last+tag@mail.example.com", true],
	["", false],
	["a", false],
	["a@b", false],
	["@b.co", false],
	["a@.co", false],
	["a@b.", false],
	["a@b..co", false],
	["a@@b.co", false],
	["a@b@c.co", false],
	["a b@c.co", false],
	["a@b.co\n", false],
	[`${"a".repeat(249)}@b.co`, true],
	[`${"a".repeat(250)}@b.co`, false],
];

test("the address rule", () => {
	for (const [address, ok] of addresses) expect(plausible(address)).toBe(ok);
});

const sql = useSchema("waitlist");
const send = async (email: string) =>
	(await join(sql)(create(JoinRequestSchema, { email }))).outcome.case;

test("a new address joins once, however it is spelled or padded", async () => {
	expect(await send("  Ann@Example.com ")).toBe("joined");
	expect(await send("ann@example.com")).toBe("alreadyJoined");
	expect(await send("ANN@EXAMPLE.COM")).toBe("alreadyJoined");
	expect(await send("bob@example.com")).toBe("joined");
	expect(await sql`SELECT email FROM waitlist ORDER BY email`).toEqual([
		{ email: "Ann@Example.com" },
		{ email: "bob@example.com" },
	]);
});

test("an implausible address is refused and writes nothing", async () => {
	const [{ before }] = await sql`SELECT count(*)::int AS before FROM waitlist`;
	expect(await send("not an email")).toBe("invalidAddress");
	const [{ after }] = await sql`SELECT count(*)::int AS after FROM waitlist`;
	expect(after).toBe(before);
});
