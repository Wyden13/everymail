import type { Call, CookieChange, Reply, Rpc, RpcTable } from "./rpc";
import type { Session } from "./session";

const PROTO = "application/proto";
const COOKIE = "__Host-session";
/** The browser's cap on cookie lifetime. The session row decides when the session ends. */
const COOKIE_MAX_AGE_SECONDS = 34_560_000;

export type Resolve = (token: string) => Promise<Session | undefined>;

const status = (code: number, headers?: HeadersInit) =>
	new Response(null, { status: code, headers });

/** The bearer token of a native client, or else the session cookie of the web app. */
const credential = (req: Request) =>
	req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ??
	req.headers.get("cookie")?.match(/(?:^|;\s*)__Host-session=([^;]+)/)?.[1];

export const cookieHeader = (change: CookieChange) =>
	change.kind === "set"
		? `${COOKIE}=${change.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}`
		: `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** The call to run, or undefined when a user method has no live session. */
async function authorize(
	rpc: Rpc,
	req: Request,
	resolve: Resolve,
): Promise<Call | undefined> {
	if (rpc.access === "public") return rpc.decode;
	const token = credential(req);
	const session = token === undefined ? undefined : await resolve(token);
	if (!session) return undefined;
	return (body) => {
		const run = rpc.decode(body);
		return () => run(session);
	};
}

export function handleRequest(table: RpcTable, resolve: Resolve) {
	return async (req: Request): Promise<Response> => {
		const rpc = table.get(new URL(req.url).pathname);
		if (!rpc) return status(404);
		if (req.method !== "POST") return status(405, { Allow: "POST" });
		if (req.headers.get("content-type") !== PROTO) return status(415);

		let decode: Call | undefined;
		try {
			decode = await authorize(rpc, req, resolve);
		} catch (error) {
			console.error(error);
			return status(500);
		}
		if (!decode) return status(401);

		let call: () => Promise<Reply>;
		try {
			call = decode(new Uint8Array(await req.arrayBuffer()));
		} catch {
			return status(400);
		}
		try {
			const reply = await call();
			const headers = new Headers({ "Content-Type": PROTO });
			if (reply.cookie) headers.set("Set-Cookie", cookieHeader(reply.cookie));
			return new Response(reply.body.slice(), { headers });
		} catch (error) {
			console.error(error);
			return status(500);
		}
	};
}

export function serve(table: RpcTable, resolve: Resolve, port: number) {
	return Bun.serve({ port, fetch: handleRequest(table, resolve) });
}
