import { create, type MessageInitShape } from "@bufbuild/protobuf";
import type { SQL } from "bun";
import {
	type FinishSignInRequest,
	type FinishSignInResponse,
	FinishSignInResponseSchema,
	type GetSessionRequest,
	type GetSessionResponse,
	GetSessionResponseSchema,
	type SignOutRequest,
	SignOutResponseSchema,
	type StartSignInRequest,
	StartSignInResponseSchema,
} from "./gen/api/v1/auth_pb";
import {
	authorizeUrl,
	type Identity,
	identify,
	type OidcConfig,
	type Provider,
} from "./oidc";
import {
	type Answer,
	type CookieChange,
	type Page,
	type ReadCookie,
	Refused,
} from "./rpc";
import {
	createSession,
	hashToken,
	randomToken,
	revokeSession,
	type Session,
} from "./session";

/** How long a sign-in may take, from the authorize URL until the client collects the session. */
export const ATTEMPT_SECONDS = 600;
/** How long the app has to collect the session once the browser has been sent back to it. */
const HANDOFF_SECONDS = 60;

const text = (status: number, text: string): Page => ({
	kind: "text",
	status,
	text,
});
const EXPIRED = text(
	400,
	"This sign-in has expired. Start again from EveryMail.",
);
const DENIED = text(200, "Sign-in was cancelled. You can return to EveryMail.");
const FAILED = text(502, "Sign-in failed. Return to EveryMail and try again.");
const OTHER_BROWSER = text(
	400,
	"This sign-in was started in another browser. Start again from EveryMail.",
);
const FORGET_SIGN_IN: CookieChange = { name: "signIn", kind: "clear" };

/** A web sign-in finishes only in the browser that started it: that browser holds the claim in a cookie.
 * Without this, a callback URL made with someone else's account could sign a visitor in to that account.
 * A native sign-in finishes in the system browser, which holds no cookie: it is tied to its device by the handoff instead. */
export const startedHere = (
	client: "native" | "web",
	claimHash: Uint8Array,
	cookie: string | undefined,
) =>
	client === "native" ||
	(cookie !== undefined &&
		crypto.timingSafeEqual(hashToken(cookie), Buffer.from(claimHash)));

type Attempt = {
	provider: Provider;
	client: "native" | "web";
	claim_hash: Uint8Array;
	loopback_port: number | null;
	code_verifier: string;
	nonce: string;
	now: Date;
};

/** How many sign-ins may be in progress at once. Starting one is a public call that writes a row, so it has a ceiling. */
const MAX_ATTEMPTS = 2000;

/** Where an attempt finishes, from the request's client oneof. */
type Client = { kind: "web" } | { kind: "native"; loopbackPort: number };

function clientOf(request: StartSignInRequest): Client {
	switch (request.client.case) {
		case "web":
			return { kind: "web" };
		case "native":
			switch (request.client.value.return.case) {
				case "loopback": {
					const { port } = request.client.value.return.value;
					// The column's CHECK holds the same range, as the database's own guard
					if (port < 1024 || port > 65535)
						throw new Refused(400, "loopback port out of range");
					return { kind: "native", loopbackPort: port };
				}
				case undefined:
					break;
			}
			break;
		case undefined:
			break;
	}
	// The decoder refuses an unset oneof before any handler runs
	throw new Error("unset oneof reached a handler");
}

export function startSignIn(sql: SQL, oidc: OidcConfig) {
	return async (
		request: StartSignInRequest,
	): Promise<Answer<typeof StartSignInResponseSchema>> => {
		const provider = request.provider.case;
		if (!provider) throw new Error("unset oneof reached a handler");
		if (!oidc.clients[provider])
			throw new Refused(400, `${provider} sign-in is not configured`);
		const client = clientOf(request);
		const [state, claim, nonce, verifier] = [
			randomToken(),
			randomToken(),
			randomToken(),
			randomToken(),
		];
		const [started] = await sql`
			WITH expired AS (
				DELETE FROM sign_in_attempts WHERE expires_at <= now()
			)
			INSERT INTO sign_in_attempts (state_hash, claim_hash, provider, client, loopback_port, code_verifier, nonce, expires_at)
			SELECT ${hashToken(state)}, ${hashToken(claim)}, ${provider}::sign_in_provider, ${client.kind}::sign_in_client,
				${client.kind === "native" ? client.loopbackPort : null}::int, ${verifier}, ${nonce},
				now() + make_interval(secs => ${ATTEMPT_SECONDS})
			WHERE (SELECT count(*) FROM sign_in_attempts WHERE expires_at > now()) < ${MAX_ATTEMPTS}
			RETURNING 1`;
		if (!started) throw new Refused(503, "too many sign-ins in progress");
		const url = authorizeUrl(oidc, provider, { state, nonce, verifier });
		// Each client gets the claim in the one place it can keep it
		switch (client.kind) {
			case "web":
				return {
					message: create(StartSignInResponseSchema, {
						authorizeUrl: url,
						expiresInSeconds: ATTEMPT_SECONDS,
					}),
					cookies: [{ name: "signIn", kind: "set", token: claim }],
				};
			case "native":
				return {
					message: create(StartSignInResponseSchema, {
						authorizeUrl: url,
						claim,
						expiresInSeconds: ATTEMPT_SECONDS,
					}),
				};
		}
	};
}

/** Exchanges the provider's code for the identity it vouches for. Throws when the provider cannot be reached or its token is not valid. */
export type Identify = (
	attempt: Pick<Attempt, "provider" | "code_verifier" | "nonce" | "now">,
	code: string,
) => Promise<Identity | undefined>;

export const identifyWith =
	(oidc: OidcConfig): Identify =>
	(attempt, code) =>
		identify(
			oidc,
			attempt.provider,
			code,
			attempt.code_verifier,
			attempt.nonce,
			attempt.now,
		);

/** The provider's answer to an attempt. Calls the provider, so it runs outside any transaction. */
async function settle(
	identify: Identify,
	attempt: Attempt,
	query: URLSearchParams,
): Promise<Identity | "denied" | "failed"> {
	const code = query.get("code");
	if (code === null || query.has("error")) return "denied";
	try {
		const identity = await identify(attempt, code);
		if (!identity)
			console.error(`sign-in ${attempt.provider}: claims rejected`);
		return identity ?? "failed";
	} catch (error) {
		console.error(
			`sign-in ${attempt.provider}: ${error instanceof Error ? error.message : "failed"}`,
		);
		return "failed";
	}
}

/** GET /auth/callback, where the provider sends the browser. */
export function signInCallback(sql: SQL, identify: Identify) {
	return async (query: URLSearchParams, cookie: ReadCookie): Promise<Page> => {
		const stateHash = hashToken(query.get("state") ?? "");
		const [attempt]: Attempt[] = await sql`
			SELECT provider, client, claim_hash, loopback_port, code_verifier, nonce, now() AS now FROM sign_in_attempts
			WHERE state_hash = ${stateHash} AND status = 'pending' AND expires_at > now()`;
		if (!attempt) return EXPIRED;
		if (!startedHere(attempt.client, attempt.claim_hash, cookie("signIn")))
			return OTHER_BROWSER;

		const outcome = await settle(identify, attempt, query);
		if (outcome === "denied" || outcome === "failed") {
			await sql`
				UPDATE sign_in_attempts SET status = ${outcome}::sign_in_status
				WHERE state_hash = ${stateHash} AND status = 'pending'`;
			return outcome === "denied" ? DENIED : FAILED;
		}

		// Each change below is conditional on the attempt still pending: a second callback for it finds none
		return sql.begin(async (tx): Promise<Page> => {
			const [user] = await tx`
				INSERT INTO users (provider, subject, email)
				VALUES (${attempt.provider}::sign_in_provider, ${outcome.subject}, ${outcome.email})
				ON CONFLICT (provider, subject) DO UPDATE SET email = EXCLUDED.email
				RETURNING id`;
			if (attempt.client === "web") {
				const [taken] = await tx`
					DELETE FROM sign_in_attempts
					WHERE state_hash = ${stateHash} AND status = 'pending' AND expires_at > now() RETURNING 1`;
				if (!taken) return EXPIRED;
				const token = await createSession(tx, user.id);
				return {
					kind: "redirect",
					to: "/",
					cookies: [{ name: "session", kind: "set", token }, FORGET_SIGN_IN],
				};
			}
			// The session is not released here: the browser carries the handoff to the app on this device,
			// and only the app that started the attempt holds the claim that goes with it.
			// The handoff travels in a POST body and is good for a minute, so it cannot be read off an address bar and passed on
			const handoff = randomToken();
			const [taken] = await tx`
				UPDATE sign_in_attempts SET status = 'signed_in', user_id = ${user.id}, handoff_hash = ${hashToken(handoff)},
					expires_at = least(expires_at, now() + make_interval(secs => ${HANDOFF_SECONDS}))
				WHERE state_hash = ${stateHash} AND status = 'pending' AND expires_at > now() RETURNING 1`;
			if (!taken) return EXPIRED;
			return {
				kind: "post",
				to: `http://127.0.0.1:${attempt.loopback_port}/`,
				fields: { handoff },
				label: "Return to EveryMail",
			};
		});
	};
}

type Outcome = MessageInitShape<typeof FinishSignInResponseSchema>["outcome"];

export function finishSignIn(sql: SQL) {
	return async ({
		claim,
		handoff,
	}: FinishSignInRequest): Promise<FinishSignInResponse> => {
		const claimHash = hashToken(claim);
		const handoffHash = hashToken(handoff);
		const outcome = await sql.begin(async (tx): Promise<Outcome> => {
			// A finished attempt is collected once. A signed-in one is collected only with its handoff:
			// until the app has it, the attempt stays and answers pending, like one the user has not finished
			const [row]: {
				status: string;
				user_id: string | null;
				email: string | null;
			}[] = await tx`
				WITH collected AS (
					DELETE FROM sign_in_attempts
					WHERE claim_hash = ${claimHash} AND client = 'native' AND expires_at > now()
						AND (status IN ('denied', 'failed')
							OR (status = 'signed_in' AND handoff_hash = ${handoffHash}))
					RETURNING status::text, user_id
				)
				SELECT status, user_id, email FROM collected LEFT JOIN users ON users.id = user_id
				UNION ALL
				SELECT 'pending', NULL, NULL FROM sign_in_attempts
				WHERE claim_hash = ${claimHash} AND client = 'native' AND expires_at > now()
					AND NOT EXISTS (SELECT 1 FROM collected)`;
			switch (row?.status) {
				case "signed_in":
					if (!row.user_id || row.email === null)
						throw new Error("signed_in without a user");
					return {
						case: "signedIn",
						value: {
							bearer: await createSession(tx, row.user_id),
							email: row.email,
						},
					};
				case "pending":
					return { case: "pending", value: {} };
				case "denied":
					return { case: "denied", value: {} };
				case "failed":
					return { case: "failed", value: {} };
				default:
					return { case: "expired", value: {} };
			}
		});
		return create(FinishSignInResponseSchema, { outcome });
	};
}

export function getSession(sql: SQL) {
	return async (
		_: GetSessionRequest,
		session: Session,
	): Promise<GetSessionResponse> => {
		const [user]: { provider: Provider; email: string }[] = await sql`
			SELECT provider::text, email FROM users WHERE id = ${session.userId}`;
		if (!user) throw new Error("a session without a user");
		return create(GetSessionResponseSchema, {
			provider: { case: user.provider, value: {} },
			email: user.email,
		});
	};
}

export function signOut(sql: SQL) {
	return async (
		_: SignOutRequest,
		session: Session,
	): Promise<Answer<typeof SignOutResponseSchema>> => {
		await revokeSession(sql, session.tokenHash);
		return {
			message: create(SignOutResponseSchema),
			cookies: [{ name: "session", kind: "clear" }],
		};
	};
}
