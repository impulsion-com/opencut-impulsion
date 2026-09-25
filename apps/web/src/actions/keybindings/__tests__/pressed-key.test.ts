import { describe, expect, test } from "bun:test";
import { getPressedKey, type PressedKeyEvent } from "../pressed-key";

function press(event: Partial<PressedKeyEvent>): PressedKeyEvent {
	return { key: "", code: "", altKey: false, ...event };
}

describe("getPressedKey", () => {
	describe("AZERTY (French) layout", () => {
		test("uses the layout letter, not the physical QWERTY position", () => {
			// The key labelled Z sits where QWERTY has W.
			expect(getPressedKey(press({ key: "z", code: "KeyW" }))).toBe("z");
			// The key labelled A sits where QWERTY has Q.
			expect(getPressedKey(press({ key: "a", code: "KeyQ" }))).toBe("a");
			expect(getPressedKey(press({ key: "q", code: "KeyA" }))).toBe("q");
			expect(getPressedKey(press({ key: "w", code: "KeyZ" }))).toBe("w");
			// M is on the QWERTY semicolon key.
			expect(getPressedKey(press({ key: "m", code: "Semicolon" }))).toBe("m");
		});

		test("lowercases shifted letters", () => {
			expect(getPressedKey(press({ key: "Z", code: "KeyW" }))).toBe("z");
		});

		test("does not turn the comma on the QWERTY M position into m", () => {
			expect(getPressedKey(press({ key: ",", code: "KeyM" }))).toBeNull();
			expect(getPressedKey(press({ key: "?", code: "KeyM" }))).toBe("?");
		});

		test("maps the unshifted digit row by physical position", () => {
			expect(getPressedKey(press({ key: "&", code: "Digit1" }))).toBe("1");
			expect(getPressedKey(press({ key: "é", code: "Digit2" }))).toBe("2");
		});

		test("falls back to the physical position when Option yields a symbol", () => {
			// macOS Option+Z on AZERTY produces a symbol, not a letter.
			expect(
				getPressedKey(press({ key: "Â", code: "KeyW", altKey: true })),
			).toBe("w");
		});
	});

	describe("QWERTY layout", () => {
		test("maps letters", () => {
			expect(getPressedKey(press({ key: "z", code: "KeyZ" }))).toBe("z");
			expect(getPressedKey(press({ key: "A", code: "KeyA" }))).toBe("a");
		});

		test("maps digits, punctuation and named keys", () => {
			expect(getPressedKey(press({ key: "1", code: "Digit1" }))).toBe("1");
			expect(getPressedKey(press({ key: "/", code: "Slash" }))).toBe("/");
			expect(getPressedKey(press({ key: ".", code: "Period" }))).toBe(".");
			expect(getPressedKey(press({ key: " ", code: "Space" }))).toBe("space");
			expect(getPressedKey(press({ key: "ArrowLeft", code: "ArrowLeft" }))).toBe(
				"left",
			);
			expect(getPressedKey(press({ key: "Escape", code: "Escape" }))).toBe(
				"escape",
			);
			expect(getPressedKey(press({ key: "Backspace", code: "Backspace" }))).toBe(
				"backspace",
			);
		});

		test("falls back to the physical position for Option symbols and dead keys", () => {
			// macOS Option+Z types "Ω".
			expect(
				getPressedKey(press({ key: "Ω", code: "KeyZ", altKey: true })),
			).toBe("z");
			expect(getPressedKey(press({ key: "Dead", code: "KeyE", altKey: true }))).toBe(
				"e",
			);
		});

		test("keeps Alt with a plain letter on the letter itself", () => {
			expect(getPressedKey(press({ key: "z", code: "KeyZ", altKey: true }))).toBe(
				"z",
			);
		});

		test("ignores keys that are not bindable", () => {
			expect(getPressedKey(press({ key: "Shift", code: "ShiftLeft" }))).toBeNull();
			expect(getPressedKey(press({ key: "F1", code: "F1" }))).toBeNull();
		});
	});

	test("uses the physical position for non-Latin layouts", () => {
		// Russian layout: the QWERTY Z key types "я".
		expect(getPressedKey(press({ key: "я", code: "KeyZ" }))).toBe("z");
	});
});
