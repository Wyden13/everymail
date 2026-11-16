import type { SQL } from "bun";

/** How long an unused session lives. Each use renews it, at most once a day. */
export const SESSION_SECONDS = 2_592_000;
const RENEW_SECONDS = 86_400;

export type Session = { userId: string; tokenHash: Uint8Array };

export const hashToken = (token: string) =>
	new Bun.CryptoHasher("sha256").update(token).digest();

/** Starts a session and returns its credential. Also drops the user's expired sessions. */
export async function createSession(sql: SQL, userId: string): Promise<string> {
	const token = Buffer.from(
		crypto.getRandomValues(new Uint8Array(32)),
	).toString("base64url");
	await sql`
		WITH expired AS (
			DELETE FROM sessions WHERE user_id = ${userId} AND expires_at <= now()
		)
		INSERT INTO sessions (token_hash, user_id, expires_at)
		VALUES (${hashToken(token)}, ${userId}, now() + make_interval(secs => ${SESSION_SECONDS}))`;
	return token;
}

/** The session a credential names, renewed when a day or more of its lifetime has passed. */
export async function resolveSession(
	sql: SQL,
	token: string,
): Promise<Session | undefined> {
	const tokenHash = hashToken(token);
	const [row] = await sql`
		WITH live AS (
			SELECT user_id FROM sessions WHERE token_hash = ${tokenHash} AND expires_at > now()
		), renewed AS (
			UPDATE sessions SET expires_at = now() + make_interval(secs => ${SESSION_SECONDS})
			WHERE token_hash = ${tokenHash} AND expires_at > now()
				AND expires_at < now() + make_interval(secs => ${SESSION_SECONDS - RENEW_SECONDS})
		)
		SELECT user_id FROM live`;
	return row && { userId: row.user_id, tokenHash };
}

export async function revokeSession(sql: SQL, tokenHash: Uint8Array) {
	await sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
}
