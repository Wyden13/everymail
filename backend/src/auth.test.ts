import { expect, test } from "bun:test";
import { startedHere } from "./auth";
import { hashToken } from "./session";

const claimHash = hashToken("claim");

test("a web sign-in finishes only with the cookie of the browser that started it", () => {
	expect(startedHere("web", claimHash, "claim")).toBe(true);
	expect(startedHere("web", claimHash, "other")).toBe(false);
	expect(startedHere("web", claimHash, undefined)).toBe(false);
});

test("a native sign-in finishes in a browser that holds no cookie", () => {
	expect(startedHere("native", claimHash, undefined)).toBe(true);
});
