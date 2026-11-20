import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { hashToken } from "./session";

/** The values of the sign_in_provider enum. */
export type Provider = "google" | "microsoft";
export type Identity = { subject: string; email: string };
export type OidcConfig = {
	redirectUri: string;
	clients: Record<Provider, { id: string; secret: string }>;
};

const TOKEN_TIMEOUT_MS = 10_000;
const MICROSOFT = "https://login.microsoftonline.com/common";

const text = (value: unknown) =>
	typeof value === "string" && value !== "" ? value : undefined;

const PROVIDERS: Record<
	Provider,
	{
		authorize: string;
		token: string;
		keys: ReturnType<typeof createRemoteJWKSet>;
		scope: string;
		issued: (claims: JWTPayload) => boolean;
		email: (claims: JWTPayload) => string | undefined;
	}
> = {
	google: {
		authorize: "https://accounts.google.com/o/oauth2/v2/auth",
		token: "https://oauth2.googleapis.com/token",
		keys: createRemoteJWKSet(
			new URL("https://www.googleapis.com/oauth2/v3/certs"),
		),
		scope: "openid email",
		issued: ({ iss }) =>
			iss === "https://accounts.google.com" || iss === "accounts.google.com",
		email: (claims) => text(claims.email),
	},
	microsoft: {
		authorize: `${MICROSOFT}/oauth2/v2.0/authorize`,
		token: `${MICROSOFT}/oauth2/v2.0/token`,
		keys: createRemoteJWKSet(new URL(`${MICROSOFT}/discovery/v2.0/keys`)),
		// profile carries preferred_username, the address of accounts without an email claim
		scope: "openid email profile",
		// The common endpoint serves every tenant, so the issuer names the token's own tenant
		issued: ({ iss, tid }) =>
			text(tid) !== undefined &&
			iss === `https://login.microsoftonline.com/${tid}/v2.0`,
		email: (claims) => text(claims.email) ?? text(claims.preferred_username),
	},
};

/** RFC 7636 S256: base64url of the SHA-256 of the verifier. */
export const pkceChallenge = (verifier: string) =>
	hashToken(verifier).toString("base64url");

export function authorizeUrl(
	config: OidcConfig,
	provider: Provider,
	secrets: { state: string; nonce: string; verifier: string },
): string {
	const url = new URL(PROVIDERS[provider].authorize);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: config.clients[provider].id,
		redirect_uri: config.redirectUri,
		scope: PROVIDERS[provider].scope,
		state: secrets.state,
		nonce: secrets.nonce,
		code_challenge: pkceChallenge(secrets.verifier),
		code_challenge_method: "S256",
		prompt: "select_account",
	}).toString();
	return url.toString();
}

/** The identity in a verified ID token, or undefined when a claim does not hold. Signature, audience and expiry are checked before. */
export function checkClaims(
	provider: Provider,
	claims: JWTPayload,
	nonce: string,
): Identity | undefined {
	const subject = text(claims.sub);
	const email = PROVIDERS[provider].email(claims);
	if (!PROVIDERS[provider].issued(claims) || claims.nonce !== nonce) return;
	return subject && email ? { subject, email } : undefined;
}

/** Exchanges the code for an ID token and checks it. Throws when the provider cannot be reached or the token is not valid. */
export async function identify(
	config: OidcConfig,
	provider: Provider,
	code: string,
	verifier: string,
	nonce: string,
	now: Date,
): Promise<Identity | undefined> {
	const client = config.clients[provider];
	const res = await fetch(PROVIDERS[provider].token, {
		method: "POST",
		headers: { Accept: "application/json" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: config.redirectUri,
			client_id: client.id,
			client_secret: client.secret,
			code_verifier: verifier,
		}),
		signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
	});
	if (!res.ok)
		throw new Error(`${provider} token endpoint answered ${res.status}`);
	const { id_token } = (await res.json()) as { id_token?: unknown };
	if (typeof id_token !== "string")
		throw new Error(`${provider} sent no ID token`);
	const { payload } = await jwtVerify(id_token, PROVIDERS[provider].keys, {
		audience: client.id,
		currentDate: now,
		algorithms: ["RS256"],
		requiredClaims: ["exp", "iat"],
	});
	return checkClaims(provider, payload, nonce);
}
