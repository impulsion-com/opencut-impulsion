import { afterEach, describe, expect, test } from "bun:test";
import { isBrowserEnvironment } from "@/claude/bridge/environment";

// A copy of the editor framed by another site has our Origin: it must never start the bridge.

const globals = globalThis as Record<string, unknown>;
const saved = { window: globals.window, WebSocket: globals.WebSocket };

afterEach(() => {
	globals.window = saved.window;
	globals.WebSocket = saved.WebSocket;
});

describe("isBrowserEnvironment", () => {
	test("true in a top-level tab", () => {
		const tab: Record<string, unknown> = {};
		tab.self = tab;
		tab.top = tab;
		globals.window = tab;
		globals.WebSocket = class {};
		expect(isBrowserEnvironment()).toBe(true);
	});

	test("false in a frame, and when reading top throws", () => {
		globals.WebSocket = class {};
		const frame: Record<string, unknown> = { top: {} };
		frame.self = frame;
		globals.window = frame;
		expect(isBrowserEnvironment()).toBe(false);
		const hostile: Record<string, unknown> = {};
		hostile.self = hostile;
		Object.defineProperty(hostile, "top", {
			get() {
				throw new Error("cross-origin");
			},
		});
		globals.window = hostile;
		expect(isBrowserEnvironment()).toBe(false);
	});

	test("false on the server", () => {
		globals.window = undefined;
		expect(isBrowserEnvironment()).toBe(false);
	});
});
