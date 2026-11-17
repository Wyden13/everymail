import { create, type MessageInitShape } from "@bufbuild/protobuf";
import type { SQL } from "bun";
import {
	type FinishSignInRequest,
	type FinishSignInResponse,
	FinishSignInResponseSchema,
	type SignOutRequest,
	SignOutResponseSchema,
	type StartSignInRequest,
	type StartSignInResponse,
	StartSignInResponseSchema,
} from "./gen/api/v1/auth_pb";
import {
	authorizeUrl,
	type Identity,
	identify,
	type OidcConfig,
	type Provider,
} from "./oidc";
import type { Answer, Page } from "./rpc";
import {
	createSession,
	hashToken,
	randomToken,
	revokeSession,
	type Session,
} from "./session";

/** How long a sign-in may take, from the authorize URL until the client collects the session. */
const ATTEMPT_SECONDS = 600;

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
const SIGNED_IN = text(200, "Signed in. You can return to EveryMail.");

type Attempt = {
	provider: Provider;
	client: "native" | "web";
	code_verifier: string;
	nonce: string;
	now: Date;
};

export function startSignIn(sql: SQL, oidc: OidcConfig) {
	return async (request: StartSignInRequest): Promise<StartSignInResponse> => {
		const provider = request.provider.case;
		const client = request.client.case;
		// The decoder already refuses an unset oneof
		if (!provider || !client) throw new Error("unset oneof");
		const [state, claim, nonce, verifier] = [
			randomToken(),
			randomToken(),
			randomToken(),
			randomToken(),
		];
		await sql`
			WITH expired AS (
				DELETE FROM sign_in_attempts WHERE expires_at <= now()
			)
			INSERT INTO sign_in_attempts (state_hash, claim_hash, provider, client, code_verifier, nonce, expires_at)
			VALUES (${hashToken(state)}, ${hashToken(claim)}, ${provider}::sign_in_provider, ${client}::sign_in_client,
				${verifier}, ${nonce}, now() + make_interval(secs => ${ATTEMPT_SECONDS}))`;
		return create(StartSignInResponseSchema, {
			authorizeUrl: authorizeUrl(oidc, provider, { state, nonce, verifier }),
			claim,
		});
	};
}

/** The provider's answer to an attempt. Calls the provider, so it runs outside any transaction. */
async function settle(
	oidc: OidcConfig,
	attempt: Attempt,
	query: URLSearchParams,
): Promise<Identity | "denied" | "failed"> {
	const code = query.get("code");
	if (code === null || query.has("error")) return "denied";
	try {
		const identity = await identify(
			oidc,
			attempt.provider,
			code,
			attempt.code_verifier,
			attempt.nonce,
			attempt.now,
		);
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
export function signInCallback(sql: SQL, oidc: OidcConfig) {
	return async (query: URLSearchParams): Promise<Page> => {
		const stateHash = hashToken(query.get("state") ?? "");
		const [attempt]: Attempt[] = await sql`
			SELECT provider, client, code_verifier, nonce, now() AS now FROM sign_in_attempts
			WHERE state_hash = ${stateHash} AND status = 'pending' AND expires_at > now()`;
		if (!attempt) return EXPIRED;

		const outcome = await settle(oidc, attempt, query);
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
					WHERE state_hash = ${stateHash} AND status = 'pending' RETURNING 1`;
				if (!taken) return EXPIRED;
				const token = await createSession(tx, user.id);
				return { kind: "redirect", to: "/", cookie: { kind: "set", token } };
			}
			const [taken] = await tx`
				UPDATE sign_in_attempts SET status = 'signed_in', user_id = ${user.id}
				WHERE state_hash = ${stateHash} AND status = 'pending' RETURNING 1`;
			return taken ? SIGNED_IN : EXPIRED;
		});
	};
}

type Outcome = MessageInitShape<typeof FinishSignInResponseSchema>["outcome"];

export function finishSignIn(sql: SQL) {
	return async ({
		claim,
	}: FinishSignInRequest): Promise<FinishSignInResponse> => {
		const claimHash = hashToken(claim);
		const outcome = await sql.begin(async (tx): Promise<Outcome> => {
			// A finished attempt is collected once; a pending one stays
			const [row]: { status: string; user_id: string | null }[] = await tx`
				WITH collected AS (
					DELETE FROM sign_in_attempts
					WHERE claim_hash = ${claimHash} AND client = 'native'
						AND status <> 'pending' AND expires_at > now()
					RETURNING status, user_id
				)
				SELECT status, user_id FROM collected
				UNION ALL
				SELECT status, user_id FROM sign_in_attempts
				WHERE claim_hash = ${claimHash} AND client = 'native'
					AND status = 'pending' AND expires_at > now()`;
			switch (row?.status) {
				case "signed_in":
					if (!row.user_id) throw new Error("signed_in without a user");
					return {
						case: "signedIn",
						value: { bearer: await createSession(tx, row.user_id) },
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

export function signOut(sql: SQL) {
	return async (
		_: SignOutRequest,
		session: Session,
	): Promise<Answer<typeof SignOutResponseSchema>> => {
		await revokeSession(sql, session.tokenHash);
		return {
			message: create(SignOutResponseSchema),
			cookie: { kind: "clear" },
		};
	};
}
