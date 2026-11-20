import { ATTEMPT_SECONDS } from "./auth";
import type {
	Call,
	CookieChange,
	CookieName,
	Page,
	Pages,
	Reply,
	Rpc,
	RpcTable,
} from "./rpc";
import type { Session } from "./session";

const PROTO = "application/proto";
/** The session cookie lives for the browser's cap on cookie lifetime; the session row decides when the session ends.
 * The sign-in cookie must arrive with the provider's redirect, a cross-site navigation, so it is Lax, and it lives as long as the attempt. */
const COOKIES: Record<
	CookieName,
	{ name: string; sameSite: "Strict" | "Lax"; maxAgeSeconds: number }
> = {
	session: {
		name: "__Host-session",
		sameSite: "Strict",
		maxAgeSeconds: 34_560_000,
	},
	signIn: {
		name: "__Host-sign-in",
		sameSite: "Lax",
		maxAgeSeconds: ATTEMPT_SECONDS,
	},
};

export type Resolve = (token: string) => Promise<Session | undefined>;

const status = (code: number, headers?: HeadersInit) =>
	new Response(null, { status: code, headers });

const readCookie = (req: Request, name: CookieName) =>
	req.headers
		.get("cookie")
		?.split(/;\s*/)
		.find((pair) => pair.startsWith(`${COOKIES[name].name}=`))
		?.slice(COOKIES[name].name.length + 1) || undefined;

/** The bearer token of a native client, or else the session cookie of the web app. */
const credential = (req: Request) =>
	req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ??
	readCookie(req, "session");

export function cookieHeader(change: CookieChange) {
	const { name, sameSite, maxAgeSeconds } = COOKIES[change.name];
	const [value, maxAge] =
		change.kind === "set" ? [change.token, maxAgeSeconds] : ["", 0];
	return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAge}`;
}

const setCookies = (headers: Headers, changes: CookieChange[] = []) => {
	for (const change of changes)
		headers.append("Set-Cookie", cookieHeader(change));
};

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

/** The callback URL carries the sign-in code: nothing may cache it or pass it on as a referrer. */
function render(page: Page): Response {
	const headers = new Headers({
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
	});
	if (page.kind === "text") {
		headers.set("Content-Type", "text/plain; charset=utf-8");
		return new Response(page.text, { status: page.status, headers });
	}
	headers.set("Location", page.to);
	setCookies(headers, page.cookies);
	return new Response(null, { status: 303, headers });
}

export function handleRequest(table: RpcTable, pages: Pages, resolve: Resolve) {
	return async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		const page = pages.get(url.pathname);
		if (page) {
			if (req.method !== "GET") return status(405, { Allow: "GET" });
			try {
				return render(
					await page(url.searchParams, (name) => readCookie(req, name)),
				);
			} catch (error) {
				console.error(error);
				return status(500);
			}
		}

		const rpc = table.get(url.pathname);
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
			setCookies(headers, reply.cookies);
			return new Response(reply.body.slice(), { headers });
		} catch (error) {
			console.error(error);
			return status(500);
		}
	};
}

export function serve(
	table: RpcTable,
	pages: Pages,
	resolve: Resolve,
	port: number,
) {
	return Bun.serve({ port, fetch: handleRequest(table, pages, resolve) });
}
