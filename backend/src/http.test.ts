import { expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	CheckRequestSchema,
	CheckResponseSchema,
	HealthService,
} from "./gen/api/v1/health_pb";
import { handleRequest } from "./http";
import { type CookieChange, publicRpc, userRpc } from "./rpc";
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
const handle = handleRequest(
	new Map([publicRpc(HealthService.method.check, async () => response())]),
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
	async (token) => (token === "good" ? live : undefined),
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

const withCookie = (cookie: CookieChange) =>
	handleRequest(
		new Map([
			[
				path,
				{
					access: "public",
					decode: () => async () => ({ body: new Uint8Array(), cookie }),
				},
			],
		]),
		nobody,
	)(request());

test("a set cookie reply sets the session cookie", async () => {
	const res = await withCookie({ kind: "set", token: "t" });
	expect(res.headers.get("set-cookie")).toBe(
		"__Host-session=t; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=34560000",
	);
});

test("a clear cookie reply expires the session cookie", async () => {
	const res = await withCookie({ kind: "clear" });
	expect(res.headers.get("set-cookie")).toBe(
		"__Host-session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
	);
});
