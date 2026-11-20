import { afterAll, beforeAll, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { SQL } from "bun";
import {
	finishSignIn,
	type Identify,
	signInCallback,
	startedHere,
	startSignIn,
} from "./auth";
import {
	FinishSignInRequestSchema,
	StartSignInRequestSchema,
} from "./gen/api/v1/auth_pb";
import { migrate } from "./migrate";
import type { OidcConfig } from "./oidc";
import { type Page, Refused } from "./rpc";
import { hashToken, resolveSession } from "./session";

const claimHash = hashToken("claim");

test("a web sign-in finishes only with the cookie of the browser that started it", () => {
	expect(startedHere("web", claimHash, "claim")).toBe(true);
	expect(startedHere("web", claimHash, "other")).toBe(false);
	expect(startedHere("web", claimHash, undefined)).toBe(false);
});

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for the sign-in queries");

const schema = `auth_test_${process.pid}`;
const admin = new SQL(url, { max: 1 });
const sql = new SQL(url, { max: 2, connection: { search_path: schema } });
const oidc: OidcConfig = {
	redirectUri: "https://x/auth/callback",
	clients: {
		google: { id: "g", secret: "s" },
		microsoft: { id: "m", secret: "s" },
	},
};
const start = startSignIn(sql, oidc);
const finish = finishSignIn(sql);

const native = (port: number) =>
	create(StartSignInRequestSchema, {
		provider: { case: "google", value: {} },
		client: {
			case: "native",
			value: { return: { case: "loopback", value: { port } } },
		},
	});
const collect = async (claim: string, handoff = "") =>
	(await finish(create(FinishSignInRequestSchema, { claim, handoff }))).outcome;

/** What the callback records once the provider has answered: the outcome, and for a sign-in the handoff. */
async function answered(claim: string, status: "signed_in" | "denied") {
	const signedIn = status === "signed_in";
	const [user] = await sql`
		INSERT INTO users (provider, subject, email) VALUES ('google', ${claim}, 'a@b.c') RETURNING id`;
	await sql`
		UPDATE sign_in_attempts SET status = ${status}::sign_in_status,
			user_id = ${signedIn ? user.id : null},
			handoff_hash = ${signedIn ? hashToken("handoff") : null}
		WHERE claim_hash = ${hashToken(claim)}`;
}

beforeAll(async () => {
	await admin.unsafe(`CREATE SCHEMA ${schema}`);
	await migrate(sql);
});

afterAll(async () => {
	await sql.close();
	await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
	await admin.close();
});

test("a native client gets the claim, a web client gets it only as a cookie", async () => {
	const app = await start(native(4100));
	expect(app.message.claim).not.toBe("");
	expect(app.cookies).toBeUndefined();

	const web = await start(
		create(StartSignInRequestSchema, {
			provider: { case: "microsoft", value: {} },
			client: { case: "web", value: {} },
		}),
	);
	expect(web.message.claim).toBe("");
	expect(web.cookies?.map((c) => [c.name, c.kind])).toEqual([
		["signIn", "set"],
	]);
});

test("a loopback port outside 1024 to 65535 is a bad request", async () => {
	for (const port of [0, 80, 65536])
		await expect(start(native(port))).rejects.toBeInstanceOf(Refused);
});

test("the session is collected once, and only with the claim and the handoff together", async () => {
	const { claim } = (await start(native(4100))).message;
	expect((await collect(claim)).case).toBe("pending");

	await answered(claim, "signed_in");
	// Whoever started the attempt holds the claim, but the handoff reached only the device that ran the browser
	expect((await collect(claim)).case).toBe("pending");
	expect((await collect(claim, "guess")).case).toBe("pending");
	expect((await collect("other", "handoff")).case).toBe("expired");

	const outcome = await collect(claim, "handoff");
	if (outcome.case !== "signedIn") throw new Error(`got ${outcome.case}`);
	expect(await resolveSession(sql, outcome.value.bearer)).toBeDefined();
	expect((await collect(claim, "handoff")).case).toBe("expired");
});

test("a cancelled sign-in is reported to the claim alone, once", async () => {
	const { claim } = (await start(native(4100))).message;
	await answered(claim, "denied");
	expect((await collect(claim)).case).toBe("denied");
	expect((await collect(claim)).case).toBe("expired");
});

/** The provider's part, replaced: the code "good" is a sign-in, anything else is a failed exchange. */
const exchanged: string[] = [];
const identify: Identify = async (_, code) => {
	exchanged.push(code);
	if (code !== "good") throw new Error("invalid_grant");
	return { subject: "sub", email: "a@b.c" };
};
const callback = signInCallback(sql, identify);
const stateOf = (authorizeUrl: string) =>
	new URL(authorizeUrl).searchParams.get("state") ?? "";
const arrive = (
	state: string,
	params: Record<string, string>,
	cookie?: string,
) =>
	callback(new URLSearchParams({ state, ...params }), (name) =>
		name === "signIn" ? cookie : undefined,
	);
const startWeb = async () => {
	const { message, cookies } = await start(
		create(StartSignInRequestSchema, {
			provider: { case: "google", value: {} },
			client: { case: "web", value: {} },
		}),
	);
	const [cookie] = cookies ?? [];
	if (cookie?.kind !== "set") throw new Error("no sign-in cookie");
	return { state: stateOf(message.authorizeUrl), cookie: cookie.token };
};
const textOf = (page: Page) => (page.kind === "text" ? page.text : page.kind);
const handedOff = async (authorizeUrl: string) => {
	const page = await arrive(stateOf(authorizeUrl), { code: "good" });
	if (page.kind !== "post") throw new Error(`got ${page.kind}`);
	return { to: page.to, handoff: page.fields.handoff ?? "" };
};

test("a web callback from another browser is refused before the code is spent, and the attempt stays", async () => {
	const { state, cookie } = await startWeb();
	exchanged.length = 0;
	for (const other of [undefined, "other"])
		expect(textOf(await arrive(state, { code: "good" }, other))).toContain(
			"another browser",
		);
	expect(exchanged).toEqual([]);

	const page = await arrive(state, { code: "good" }, cookie);
	if (page.kind !== "redirect") throw new Error(`got ${page.kind}`);
	expect(page.to).toBe("/");
	expect(page.cookies?.map((c) => [c.name, c.kind])).toEqual([
		["session", "set"],
		["signIn", "clear"],
	]);
	// The attempt is spent: the same link signs nobody in twice
	expect(textOf(await arrive(state, { code: "good" }, cookie))).toContain(
		"expired",
	);
});

test("an unknown state is expired and never reaches the provider", async () => {
	exchanged.length = 0;
	expect(textOf(await arrive("nope", { code: "good" }))).toContain("expired");
	expect(exchanged).toEqual([]);
});

test("a native callback hands the browser to the app's loopback by POST, and the handoff releases the session", async () => {
	const { claim, authorizeUrl } = (await start(native(4100))).message;
	const { to, handoff } = await handedOff(authorizeUrl);
	expect(to).toBe("http://127.0.0.1:4100/");
	expect((await collect(claim)).case).toBe("pending");
	expect((await collect(claim, handoff)).case).toBe("signedIn");
	expect(
		textOf(await arrive(stateOf(authorizeUrl), { code: "good" })),
	).toContain("expired");
});

test("a handoff not collected within a minute is worth nothing", async () => {
	const { claim, authorizeUrl } = (await start(native(4100))).message;
	const { handoff } = await handedOff(authorizeUrl);
	const [{ seconds }] = await sql`
		SELECT extract(epoch FROM expires_at - now())::float AS seconds FROM sign_in_attempts
		WHERE claim_hash = ${hashToken(claim)}`;
	expect(seconds).toBeLessThanOrEqual(60);
	await sql`UPDATE sign_in_attempts SET expires_at = now() WHERE claim_hash = ${hashToken(claim)}`;
	expect((await collect(claim, handoff)).case).toBe("expired");
});

test("a cancelled or failed provider step is what the claim collects", async () => {
	const cancelled = (await start(native(4100))).message;
	await arrive(stateOf(cancelled.authorizeUrl), { error: "access_denied" });
	expect((await collect(cancelled.claim)).case).toBe("denied");

	const broken = (await start(native(4100))).message;
	await arrive(stateOf(broken.authorizeUrl), { code: "bad" });
	expect((await collect(broken.claim)).case).toBe("failed");
});

test("sign-ins in progress have a ceiling", async () => {
	await sql`
		INSERT INTO sign_in_attempts (state_hash, claim_hash, provider, client, code_verifier, nonce, expires_at)
		SELECT sha256(('s' || i)::bytea), sha256(('c' || i)::bytea), 'google', 'web', 'v', 'n', now() + interval '10 minutes'
		FROM generate_series(1, 2000) AS i`;
	await expect(start(native(4100))).rejects.toMatchObject({ status: 503 });
	await sql`UPDATE sign_in_attempts SET expires_at = now()`;
	expect((await start(native(4100))).message.claim).not.toBe("");
});
