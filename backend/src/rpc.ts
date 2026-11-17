import {
	type DescMessage,
	type DescMethodUnary,
	fromBinary,
	type MessageShape,
	toBinary,
} from "@bufbuild/protobuf";
import { reflect } from "@bufbuild/protobuf/reflect";
import type { Session } from "./session";

/** What a call asks the transport to do with the web session cookie. Only AuthService sets it. */
export type CookieChange = { kind: "set"; token: string } | { kind: "clear" };
export type Reply = { body: Uint8Array; cookie?: CookieChange };
export type Answer<O extends DescMessage> = {
	message: MessageShape<O>;
	cookie?: CookieChange;
};

/** Decodes a request body, or throws if it is not a valid message. Returns the call to run. */
type Decode<A extends unknown[]> = (
	body: Uint8Array,
) => (...args: A) => Promise<Reply>;
export type Call = Decode<[]>;

export type Rpc =
	| { access: "public"; decode: Call }
	| { access: "user"; decode: Decode<[session: Session]> };

export type RpcTable = ReadonlyMap<string, Rpc>;

/** A page a browser is sent to, such as the sign-in callback. Answered without protobuf. */
export type Page =
	| { kind: "redirect"; to: string; cookie?: CookieChange }
	| { kind: "text"; status: number; text: string };
export type Pages = ReadonlyMap<
	string,
	(query: URLSearchParams) => Promise<Page>
>;

const path = (method: DescMethodUnary) =>
	`/${method.parent.typeName}/${method.name}`;

/** An unset oneof in a request is a decode error, never a state. */
function decoder<
	I extends DescMessage,
	O extends DescMessage,
	A extends unknown[],
>(
	method: DescMethodUnary<I, O>,
	handler: (request: MessageShape<I>, ...args: A) => Promise<Answer<O>>,
): Decode<A> {
	return (body) => {
		const request = fromBinary(method.input, body);
		const fields = reflect(method.input, request);
		if (method.input.oneofs.some((o) => fields.oneofCase(o) === undefined)) {
			throw new Error(`unset oneof in ${method.input.typeName}`);
		}
		return async (...args) => {
			const { message, cookie } = await handler(request, ...args);
			return { body: toBinary(method.output, message), cookie };
		};
	};
}

/** A method anyone may call. The handler receives only the decoded request. */
export function publicRpc<I extends DescMessage, O extends DescMessage>(
	method: DescMethodUnary<I, O>,
	handler: (request: MessageShape<I>) => Promise<MessageShape<O>>,
): [path: string, rpc: Rpc] {
	return [
		path(method),
		{
			access: "public",
			decode: decoder(method, async (request) => ({
				message: await handler(request),
			})),
		},
	];
}

/** A method for signed-in users. The handler runs only with a resolved session. */
export function userRpc<I extends DescMessage, O extends DescMessage>(
	method: DescMethodUnary<I, O>,
	handler: (
		request: MessageShape<I>,
		session: Session,
	) => Promise<MessageShape<O>>,
): [path: string, rpc: Rpc] {
	return userCookieRpc(method, async (request, session) => ({
		message: await handler(request, session),
	}));
}

/** A method for signed-in users whose answer may also change the web session cookie. */
export function userCookieRpc<I extends DescMessage, O extends DescMessage>(
	method: DescMethodUnary<I, O>,
	handler: (request: MessageShape<I>, session: Session) => Promise<Answer<O>>,
): [path: string, rpc: Rpc] {
	return [path(method), { access: "user", decode: decoder(method, handler) }];
}
