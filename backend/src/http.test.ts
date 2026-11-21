import { expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	AuthService,
	StartSignInRequestSchema,
	StartSignInResponseSchema,
} from "./gen/api/v1/auth_pb";
import {
	CheckRequestSchema,
	CheckResponseSchema,
	HealthService,
} from "./gen/api/v1/health_pb";
import { handleRequest } from "./http";
import {
	type CookieChange,
	type Page,
	publicRpc,
	type ReadCookie,
	Refused,
	userRpc,
} from "./rpc";
import type { Session } from "./session";

const path = "/api.v1.HealthService/Check";
const response = () =>
	create(CheckResponseSchema, {
		database: { case: "unavailable", value: {} },
	});
const request = (
	headers: HeadersInit = {},
	body: BodyInit = new Uint8Array(),
) =>
	new Request(`http://x${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/proto", ...headers },
		body,
	});

const nobody = async () => undefined;
const noPages = new Map();
const handle = handleRequest(
	new Map([publicRpc(HealthService.method.check, async () => response())]),
	noPages,
	nobody,
);
const post = (body: BodyInit, contentType = "application/proto") =>
	handle(request({ "Content-Type": contentType }, body));

test("round trips protobuf through the handler", async () => {
	const res = await post(
		toBinary(CheckRequestSchema, create(CheckRequestSchema)),
	);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toBe("application/proto");
	const body = fromBinary(
		CheckResponseSchema,
		new Uint8Array(await res.arrayBuffer()),
	);
	expect(body.database.case).toBe("unavailable");
});

test("unknown path is 404", async () => {
	const res = await handle(new Request("http://x/nope", { method: "POST" }));
	expect(res.status).toBe(404);
});

test("non-POST is 405 with Allow", async () => {
	const res = await handle(new Request(`http://x${path}`));
	expect(res.status).toBe(405);
	expect(res.headers.get("allow")).toBe("POST");
});

test("wrong content type is 415", async () => {
	expect((await post(new Uint8Array(), "application/json")).status).toBe(415);
});

test("undecodable body is 400", async () => {
	expect((await post(new Uint8Array([0xff]))).status).toBe(400);
});

const live: Session = { userId: "7", tokenHash: new Uint8Array([1]) };
const received: Session[] = [];
const handleUser = handleRequest(
	new Map([
		userRpc(HealthService.method.check, async (_, session) => {
			received.push(session);
			return response();
		}),
	]),
	noPages,
	async (token: string) => (token === "good" ? live : undefined),
);

test("user method without a credential is 401 and never runs", async () => {
	received.length = 0;
	expect((await handleUser(request())).status).toBe(401);
	expect(received).toEqual([]);
});

test("user method with an unknown bearer is 401", async () => {
	received.length = 0;
	const res = await handleUser(request({ Authorization: "Bearer bad" }));
	expect(res.status).toBe(401);
	expect(received).toEqual([]);
});

test("bearer and cookie resolve to the same session", async () => {
	for (const headers of <HeadersInit[]>[
		{ Authorization: "Bearer good" },
		{ Cookie: "theme=dark; __Host-session=good" },
	]) {
		received.length = 0;
		expect((await handleUser(request(headers))).status).toBe(200);
		expect(received).toEqual([live]);
	}
});

const withCookies = (cookies: CookieChange[]) =>
	handleRequest(
		new Map([
			[
				path,
				{
					access: "public",
					decode: () => async () => ({ body: new Uint8Array(), cookies }),
				},
			],
		]),
		noPages,
		nobody,
	)(request());

test("a set cookie reply sets the session cookie", async () => {
	const res = await withCookies([{ name: "session", kind: "set", token: "t" }]);
	expect(res.headers.getSetCookie()).toEqual([
		"__Host-session=t; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=34560000",
	]);
});

test("a clear cookie reply expires the session cookie", async () => {
	const res = await withCookies([{ name: "session", kind: "clear" }]);
	expect(res.headers.getSetCookie()).toEqual([
		"__Host-session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
	]);
});

test("the sign-in cookie survives the provider's redirect and each change is its own header", async () => {
	const res = await withCookies([
		{ name: "signIn", kind: "set", token: "c" },
		{ name: "session", kind: "clear" },
	]);
	expect(res.headers.getSetCookie()).toEqual([
		"__Host-sign-in=c; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600",
		"__Host-session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
	]);
});

test("a page reads the cookies by name", async () => {
	const seen: (string | undefined)[] = [];
	await handleRequest(
		new Map(),
		new Map([
			[
				"/auth/callback",
				async (_: URLSearchParams, cookie: ReadCookie): Promise<Page> => {
					seen.push(cookie("signIn"), cookie("session"));
					return { kind: "text", status: 200, text: "" };
				},
			],
		]),
		nobody,
	)(
		new Request("http://x/auth/callback", {
			headers: {
				// A name that only looks like ours after loose trimming is not ours
				Cookie:
					"__Host-session=s; x__Host-sign-in=no;\u00a0__Host-sign-in=no; __Host-sign-in=c",
			},
		}),
	);
	expect(seen).toEqual(["c", "s"]);
});

test("a call a handler refuses answers with its status", async () => {
	const res = await handleRequest(
		new Map([
			publicRpc(HealthService.method.check, async () => {
				throw new Refused(503, "no");
			}),
		]),
		noPages,
		nobody,
	)(request());
	expect(res.status).toBe(503);
});

test("an unset oneof inside a set message is 400 too", async () => {
	const res = await handleRequest(
		new Map([
			publicRpc(AuthService.method.startSignIn, async () =>
				create(StartSignInResponseSchema),
			),
		]),
		noPages,
		nobody,
	)(
		new Request("http://x/api.v1.AuthService/StartSignIn", {
			method: "POST",
			headers: { "Content-Type": "application/proto" },
			body: toBinary(
				StartSignInRequestSchema,
				create(StartSignInRequestSchema, {
					provider: { case: "google", value: {} },
					client: { case: "native", value: {} },
				}),
			),
		}),
	);
	expect(res.status).toBe(400);
});

test("a request with an unset oneof is 400", async () => {
	const res = await handleRequest(
		new Map([
			publicRpc(AuthService.method.startSignIn, async () =>
				create(StartSignInResponseSchema),
			),
		]),
		noPages,
		nobody,
	)(
		new Request("http://x/api.v1.AuthService/StartSignIn", {
			method: "POST",
			headers: { "Content-Type": "application/proto" },
			body: toBinary(
				StartSignInRequestSchema,
				create(StartSignInRequestSchema, {
					client: { case: "native", value: {} },
				}),
			),
		}),
	);
	expect(res.status).toBe(400);
});

const visit = (page: Page, method = "GET") =>
	handleRequest(
		new Map(),
		new Map([["/auth/callback", async () => page]]),
		nobody,
	)(new Request("http://x/auth/callback?code=c&state=s", { method }));

test("a redirect page is a 303 that can set the cookie", async () => {
	const res = await visit({
		kind: "redirect",
		to: "/",
		cookies: [{ name: "session", kind: "set", token: "t" }],
	});
	expect(res.status).toBe(303);
	expect(res.headers.get("location")).toBe("/");
	expect(res.headers.get("set-cookie")).toStartWith("__Host-session=t;");
	expect(res.headers.get("referrer-policy")).toBe("no-referrer");
	expect(res.headers.get("cache-control")).toBe("no-store");
});

test("a post page sends its fields on in a form, never in a URL, may post nowhere else, and names only its origin", async () => {
	const res = await visit({
		kind: "post",
		to: "http://127.0.0.1:4100/",
		fields: { handoff: 'h"<' },
		label: "Return",
	});
	expect(res.status).toBe(200);
	expect(res.headers.get("location")).toBeNull();
	expect(res.headers.get("content-security-policy")).toContain(
		"form-action http://127.0.0.1:4100/",
	);
	expect(res.headers.get("referrer-policy")).toBe("origin");
	const html = await res.text();
	expect(html).toContain('method="post" action="http://127.0.0.1:4100/"');
	expect(html).toContain('name="handoff" value="h&#34;&#60;"');
});

test("a text page keeps its status and is plain text", async () => {
	const res = await visit({ kind: "text", status: 400, text: "Expired" });
	expect(res.status).toBe(400);
	expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
	expect(await res.text()).toBe("Expired");
});

test("a page answers GET only", async () => {
	const res = await visit({ kind: "text", status: 200, text: "" }, "POST");
	expect(res.status).toBe(405);
	expect(res.headers.get("allow")).toBe("GET");
});
