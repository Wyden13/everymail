import { SQL } from "bun";
import { finishSignIn, signInCallback, signOut, startSignIn } from "./auth";
import { createExecutor } from "./executor";
import { AuthService } from "./gen/api/v1/auth_pb";
import { HealthService } from "./gen/api/v1/health_pb";
import { check } from "./health";
import { serve } from "./http";
import { LANES } from "./lanes";
import { migrate } from "./migrate";
import type { OidcConfig } from "./oidc";
import { publicRpc, userCookieRpc } from "./rpc";
import { resolveSession } from "./session";

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

const sql = new SQL(requireEnv("DATABASE_URL"), {
	max: 3,
	connectionTimeout: 3,
});

const oidc: OidcConfig = {
	redirectUri: `${requireEnv("PUBLIC_ORIGIN")}/auth/callback`,
	clients: {
		google: {
			id: requireEnv("GOOGLE_CLIENT_ID"),
			secret: requireEnv("GOOGLE_CLIENT_SECRET"),
		},
		microsoft: {
			id: requireEnv("MICROSOFT_CLIENT_ID"),
			secret: requireEnv("MICROSOFT_CLIENT_SECRET"),
		},
	},
};

const table = new Map([
	publicRpc(HealthService.method.check, () => check(sql)),
	publicRpc(AuthService.method.startSignIn, startSignIn(sql, oidc)),
	publicRpc(AuthService.method.finishSignIn, finishSignIn(sql)),
	userCookieRpc(AuthService.method.signOut, signOut(sql)),
]);
const pages = new Map([["/auth/callback", signInCallback(sql, oidc)]]);

await migrate(sql);
createExecutor(sql, LANES);
const server = serve(
	table,
	pages,
	(token) => resolveSession(sql, token),
	Number(process.env.PORT ?? 8787),
);
console.log(`listening on ${server.url}`);
