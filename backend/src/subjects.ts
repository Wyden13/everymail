import { fromBinary } from "@bufbuild/protobuf";
import { AccountJobSchema, SendJobSchema } from "./gen/jobs/v1/jobs_pb";
import type { Keeps } from "./job";

/** Per subject table, how a job's payload names its row. */
const SUBJECTS = {
	accounts: (payload: Uint8Array) =>
		fromBinary(AccountJobSchema, payload).accountId,
	sends: (payload: Uint8Array) => fromBinary(SendJobSchema, payload).sendId,
} as const;

/** What a lane that keeps its subject passes as `keeps`: the exhausted job marks its row failed with the reason.
 * A row that no longer exists, or that is another user's, is left alone. */
export const failsOn = (table: keyof typeof SUBJECTS): Keeps => ({
	to: "subject",
	failed: async (tx, job, reason) => {
		await tx`UPDATE ${tx(table)} SET status = 'failed', failure_reason = ${reason}::failure_reason
			WHERE id = ${SUBJECTS[table](job.payload).toString()} AND user_id = ${job.userId}`;
	},
});
