/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- test fakes stand in for EditorCore and friends */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	BridgeError,
	imageResult,
	isBridgeError,
	jsonResult,
	textResult,
	toBridgeErrorPayload,
	toolImageFromDataUrl,
	toolResult,
} from "@/claude/types";

describe("claude types: errors", () => {
	test("BridgeError carries code, default or custom message and details", () => {
		const plain = new BridgeError({ code: "NO_PROJECT" });
		expect(plain.code).toBe("NO_PROJECT");
		expect(plain.message.length).toBeGreaterThan(5);
		expect(plain.toPayload()).toEqual({
			code: "NO_PROJECT",
			message: plain.message,
		});

		const detailed = new BridgeError({
			code: "INVALID_EDIT",
			message: "overlap on track t3",
			details: { op: 2 },
		});
		expect(detailed.toPayload()).toEqual({
			code: "INVALID_EDIT",
			message: "overlap on track t3",
			details: { op: 2 },
		});
		expect(detailed).toBeInstanceOf(Error);
	});

	test("isBridgeError also recognises errors from an older copy of the class (HMR)", () => {
		const foreign = Object.assign(new Error("stale"), {
			name: "BridgeError",
			code: "STALE_STATE",
		});
		expect(isBridgeError(foreign)).toBe(true);
		expect(
			isBridgeError(
				Object.assign(new Error("x"), { name: "BridgeError", code: "NOPE" }),
			),
		).toBe(false);
		expect(isBridgeError(new Error("x"))).toBe(false);
		expect(toBridgeErrorPayload(foreign)).toEqual({
			code: "STALE_STATE",
			message: "stale",
		});
	});

	test("toBridgeErrorPayload maps zod, abort, plain errors and non-errors", () => {
		const zod = z
			.strictObject({ time: z.number() })
			.safeParse({ time: "x", extra: 1 });
		expect(zod.success).toBe(false);
		const zodPayload = toBridgeErrorPayload(zod.error);
		expect(zodPayload.code).toBe("INVALID_PARAMS");
		expect(zodPayload.message).toContain("time");
		expect((zodPayload.details as { issues: unknown[] }).issues.length).toBe(2);

		const abort = new Error("aborted");
		abort.name = "AbortError";
		expect(toBridgeErrorPayload(abort).code).toBe("TIMEOUT");
		expect(toBridgeErrorPayload(new TypeError("boom"))).toEqual({
			code: "INTERNAL",
			message: "boom",
		});
		expect(toBridgeErrorPayload("raw string")).toEqual({
			code: "INTERNAL",
			message: "raw string",
		});
		expect(toBridgeErrorPayload(undefined).code).toBe("INTERNAL");
	});
});

describe("claude types: result helpers", () => {
	test("jsonResult, textResult and toolResult", () => {
		expect(jsonResult({ a: 1 })).toEqual({ json: { a: 1 } });
		expect(textResult("fait")).toEqual({ text: "fait" });
		expect(toolResult({ json: { a: 1 }, text: "ok" })).toEqual({
			json: { a: 1 },
			text: "ok",
		});
		expect(toolResult({})).toEqual({});
	});

	test("imageResult accepts one or many images and strips data URL prefixes", () => {
		const one = imageResult({
			images: {
				data: "data:image/png;base64,iVBORw0KGgo=",
				mimeType: "image/jpeg",
				caption: "frame @1.000s 1080x1920",
			},
			json: { time: 1 },
		});
		expect(one).toEqual({
			images: [
				{
					data: "iVBORw0KGgo=",
					mimeType: "image/png",
					caption: "frame @1.000s 1080x1920",
				},
			],
			json: { time: 1 },
		});
		const many = imageResult({
			images: [
				{ data: "AAAA", mimeType: "image/jpeg" },
				{ data: "BBBB", mimeType: "image/png" },
			],
		});
		expect(many.images?.map((image) => image.data)).toEqual(["AAAA", "BBBB"]);
		expect("json" in many).toBe(false);
	});

	test("toolImageFromDataUrl only accepts base64 JPEG or PNG", () => {
		expect(
			toolImageFromDataUrl({
				dataUrl: "data:image/jpeg;base64,/9j/4AAQ",
				caption: "c",
			}),
		).toEqual({
			data: "/9j/4AAQ",
			mimeType: "image/jpeg",
			caption: "c",
		});
		expect(() =>
			toolImageFromDataUrl({ dataUrl: "data:image/webp;base64,UklGR" }),
		).toThrow();
		expect(() =>
			toolImageFromDataUrl({ dataUrl: "data:image/png;base64," }),
		).toThrow();
	});
});
