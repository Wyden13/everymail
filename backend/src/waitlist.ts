import { create } from "@bufbuild/protobuf";
import type { SQL } from "bun";
import {
	type JoinRequest,
	type JoinResponse,
	JoinResponseSchema,
} from "./gen/api/v1/waitlist_pb";

/** The longest address SMTP allows. */
const MAX_LENGTH = 254;
/** One `@` with something on both sides, a dot inside the domain, no whitespace. Whether the mailbox exists is not ours to know. */
const PLAUSIBLE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export const plausible = (email: string) =>
	email.length <= MAX_LENGTH && PLAUSIBLE.test(email);

export function join(sql: SQL) {
	return async ({ email }: JoinRequest): Promise<JoinResponse> => {
		const address = email.trim();
		if (!plausible(address))
			return create(JoinResponseSchema, {
				outcome: { case: "invalidAddress", value: {} },
			});
		const [added] = await sql`
			INSERT INTO waitlist (email) VALUES (${address})
			ON CONFLICT (lower(email)) DO NOTHING RETURNING 1`;
		return create(JoinResponseSchema, {
			outcome: { case: added ? "joined" : "alreadyJoined", value: {} },
		});
	};
}
