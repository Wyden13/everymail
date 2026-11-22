import { SQL } from "bun";
import {
	finishSignIn,
	getSession,
	identifyWith,
	signInCallback,
	signOut,
	startSignIn,
} from "./auth";
import { createExecutor } from "./executor";
import { AuthService } from "./gen/api/v1/auth_pb";
import { HealthService } from "./gen/api/v1/health_pb";
import { check } from "./health";
import { serve } from "./http";
import { LANES } from "./lanes";
import { migrate } from "./migrate";
import type { OidcConfig } from "./oidc";
import { publicCookieRpc, publicRpc, userCookieRpc, userRpc } from "./rpc";
import { resolveSession } from "./session";

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

const client = (prefix: string) => ({
	id: requireEnv(`${prefix}_CLIENT_ID`),
	secret: requireEnv(`${prefix}_CLIENT_SECRET`),
});

const sql = new SQL(requireEnv("DATABASE_URL"), {
	max: 3,
	connectionTimeout: 3,
});

const oidc: OidcConfig = {
	redirectUri: `${requireEnv("PUBLIC_ORIGIN")}/auth/callback`,
	// Google is required; Microsoft is offered only once its client id is set
	clients: {
		google: client("GOOGLE"),
		microsoft: process.env.MICROSOFT_CLIENT_ID
			? client("MICROSOFT")
			: undefined,
	},
};

const table = new Map([
	publicRpc(HealthService.method.check, () => check(sql)),
	publicCookieRpc(AuthService.method.startSignIn, startSignIn(sql, oidc)),
	publicRpc(AuthService.method.finishSignIn, finishSignIn(sql)),
	userRpc(AuthService.method.getSession, getSession(sql)),
	userCookieRpc(AuthService.method.signOut, signOut(sql)),
]);
const pages = new Map([
	["/auth/callback", signInCallback(sql, identifyWith(oidc))],
]);

await migrate(sql);
// biome-ignore lint/correctness/noUnusedVariables: handlers that enqueue a job get executor.wake, through commit in jobs.ts
const executor = createExecutor(sql, LANES);
const server = serve(
	table,
	pages,
	(token) => resolveSession(sql, token),
	Number(process.env.PORT ?? 8787),
);
console.log(`listening on ${server.url}`);
