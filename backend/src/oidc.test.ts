import { expect, test } from "bun:test";
import {
	authorizeUrl,
	checkClaims,
	type OidcConfig,
	pkceChallenge,
} from "./oidc";

const TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const google = {
	iss: "https://accounts.google.com",
	sub: "g1",
	nonce: "n",
	email: "a@gmail.com",
};
const microsoft = {
	iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
	tid: TENANT,
	sub: "m1",
	nonce: "n",
	email: "a@outlook.com",
};

test("PKCE challenge matches the RFC 7636 example", () => {
	expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
		"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
	);
});

test("authorize URL carries every parameter of the code flow with PKCE", () => {
	const config: OidcConfig = {
		redirectUri: "https://mail.everyai.dev/auth/callback",
		clients: {
			google: { id: "gid", secret: "gs" },
			microsoft: { id: "mid", secret: "ms" },
		},
	};
	const url = new URL(
		authorizeUrl(config, "microsoft", {
			state: "s",
			nonce: "n",
			verifier: "v",
		}),
	);
	expect(url.origin + url.pathname).toBe(
		"https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
	);
	expect(Object.fromEntries(url.searchParams)).toEqual({
		response_type: "code",
		client_id: "mid",
		redirect_uri: "https://mail.everyai.dev/auth/callback",
		scope: "openid email profile",
		state: "s",
		nonce: "n",
		code_challenge: pkceChallenge("v"),
		code_challenge_method: "S256",
		prompt: "select_account",
	});
});

test("Google accepts both issuer forms", () => {
	const identity = { subject: "g1", email: "a@gmail.com" };
	expect(checkClaims("google", google, "n")).toEqual(identity);
	expect(
		checkClaims("google", { ...google, iss: "accounts.google.com" }, "n"),
	).toEqual(identity);
	expect(
		checkClaims("google", { ...google, iss: "https://evil.example" }, "n"),
	).toBeUndefined();
});

test("Microsoft issuer must name the token's own tenant", () => {
	expect(checkClaims("microsoft", microsoft, "n")).toEqual({
		subject: "m1",
		email: "a@outlook.com",
	});
	expect(
		checkClaims("microsoft", { ...microsoft, tid: "other" }, "n"),
	).toBeUndefined();
	expect(
		checkClaims("microsoft", { ...microsoft, tid: undefined }, "n"),
	).toBeUndefined();
});

test("a mismatched nonce or a missing subject is rejected", () => {
	expect(checkClaims("google", google, "other")).toBeUndefined();
	expect(checkClaims("google", { ...google, sub: "" }, "n")).toBeUndefined();
});

test("Microsoft falls back to preferred_username; no address at all is rejected", () => {
	const noEmail = { ...microsoft, email: undefined };
	expect(
		checkClaims(
			"microsoft",
			{ ...noEmail, preferred_username: "a@contoso.com" },
			"n",
		),
	).toEqual({
		subject: "m1",
		email: "a@contoso.com",
	});
	expect(checkClaims("microsoft", noEmail, "n")).toBeUndefined();
	expect(
		checkClaims(
			"google",
			{ ...google, email: undefined, preferred_username: "x" },
			"n",
		),
	).toBeUndefined();
});
