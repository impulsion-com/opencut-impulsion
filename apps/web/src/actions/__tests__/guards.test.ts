import { describe, expect, test } from "bun:test";
import { isActionWithOptionalArgs } from "@/actions";
import { isShortcutKey } from "@/actions/keybinding";

describe("isShortcutKey", () => {
	test("accepts bare keys and every modifier combination", () => {
		expect(isShortcutKey("z")).toBe(true);
		expect(isShortcutKey("space")).toBe(true);
		expect(isShortcutKey("ctrl+z")).toBe(true);
		expect(isShortcutKey("ctrl+shift+z")).toBe(true);
		expect(isShortcutKey("ctrl+alt+shift+right")).toBe(true);
		expect(isShortcutKey("alt+shift+/")).toBe(true);
	});

	test("rejects unknown keys, unknown or misordered modifiers and malformed strings", () => {
		expect(isShortcutKey("")).toBe(false);
		expect(isShortcutKey("f1")).toBe(false);
		expect(isShortcutKey("shift+bogus")).toBe(false);
		expect(isShortcutKey("meta+z")).toBe(false);
		expect(isShortcutKey("shift+ctrl+z")).toBe(false);
		expect(isShortcutKey("ctrl+")).toBe(false);
		expect(isShortcutKey("+z")).toBe(false);
		expect(isShortcutKey("ctrl")).toBe(false);
	});
});

describe("isActionWithOptionalArgs", () => {
	test("accepts actions without args or with optional args", () => {
		expect(isActionWithOptionalArgs("undo")).toBe(true);
		expect(isActionWithOptionalArgs("stop-playback")).toBe(true);
		expect(isActionWithOptionalArgs("seek-forward")).toBe(true);
	});

	test("rejects actions with required args and unknown names", () => {
		expect(isActionWithOptionalArgs("remove-media-asset")).toBe(false);
		expect(isActionWithOptionalArgs("remove-media-assets")).toBe(false);
		expect(isActionWithOptionalArgs("not-an-action")).toBe(false);
		expect(isActionWithOptionalArgs("toString")).toBe(false);
	});
});
