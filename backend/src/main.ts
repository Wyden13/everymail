import { SQL } from "bun";
import { HealthService } from "./gen/api/v1/health_pb";
import { check } from "./health";
import { serve } from "./http";
import { migrate } from "./migrate";
import { publicRpc } from "./rpc";
import { resolveSession } from "./session";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const sql = new SQL(databaseUrl, {
	max: 3,
	connectionTimeout: 3,
});

const table = new Map([
	publicRpc(HealthService.method.check, () => check(sql)),
]);

await migrate(sql);
const server = serve(
	table,
	(token) => resolveSession(sql, token),
	Number(process.env.PORT ?? 8787),
);
console.log(`listening on ${server.url}`);
