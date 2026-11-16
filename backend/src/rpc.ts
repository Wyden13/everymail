import {
	type DescMessage,
	type DescMethodUnary,
	fromBinary,
	type MessageShape,
	toBinary,
} from "@bufbuild/protobuf";
import type { Session } from "./session";

/** What a call asks the transport to do with the web session cookie. Only AuthService sets it. */
export type CookieChange = { kind: "set"; token: string } | { kind: "clear" };
export type Reply = { body: Uint8Array; cookie?: CookieChange };

/** Decodes a request body, or throws if it is not a valid message. Returns the call to run. */
type Decode<A extends unknown[]> = (
	body: Uint8Array,
) => (...args: A) => Promise<Reply>;
export type Call = Decode<[]>;

export type Rpc =
	| { access: "public"; decode: Call }
	| { access: "user"; decode: Decode<[session: Session]> };

export type RpcTable = ReadonlyMap<string, Rpc>;

const path = (method: DescMethodUnary) =>
	`/${method.parent.typeName}/${method.name}`;

function decoder<
	I extends DescMessage,
	O extends DescMessage,
	A extends unknown[],
>(
	method: DescMethodUnary<I, O>,
	handler: (request: MessageShape<I>, ...args: A) => Promise<MessageShape<O>>,
): Decode<A> {
	return (body) => {
		const request = fromBinary(method.input, body);
		return async (...args) => ({
			body: toBinary(method.output, await handler(request, ...args)),
		});
	};
}

/** A method anyone may call. The handler receives only the decoded request. */
export function publicRpc<I extends DescMessage, O extends DescMessage>(
	method: DescMethodUnary<I, O>,
	handler: (request: MessageShape<I>) => Promise<MessageShape<O>>,
): [path: string, rpc: Rpc] {
	return [path(method), { access: "public", decode: decoder(method, handler) }];
}

/** A method for signed-in users. The handler runs only with a resolved session. */
export function userRpc<I extends DescMessage, O extends DescMessage>(
	method: DescMethodUnary<I, O>,
	handler: (
		request: MessageShape<I>,
		session: Session,
	) => Promise<MessageShape<O>>,
): [path: string, rpc: Rpc] {
	return [path(method), { access: "user", decode: decoder(method, handler) }];
}
