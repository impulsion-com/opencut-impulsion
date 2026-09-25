import type { Key } from "@/actions/keybinding";
import { isKey } from "@/actions/keybinding";

export type PressedKeyEvent = Pick<KeyboardEvent, "key" | "code" | "altKey">;

function isAsciiLetter(value: string): boolean {
	return value.length === 1 && value >= "a" && value <= "z";
}

function isSingleAsciiCharacter(value: string): boolean {
	return value.length === 1 && value.charCodeAt(0) < 0x80;
}

/**
 * Map a keyboard event to the `Key` used in shortcut strings.
 *
 * Letters follow the active layout (`ev.key`), so on a French AZERTY keyboard
 * Cmd+Z is the key labelled Z (physical `KeyW`) and Cmd+A the key labelled A
 * (physical `KeyQ`). Mapping letters by `ev.code` made the key labelled W
 * trigger undo there, next to the browser's own Cmd+W (close tab).
 *
 * `ev.code` (physical QWERTY position) is only a fallback for letter keys
 * whose `ev.key` is not a usable character: Option on macOS turns letters
 * into symbols (Option+Z is "Ω"), dead keys report "Dead", and non-Latin
 * layouts report their own script. Both recording and matching go through
 * this function, so such shortcuts stay consistent even if the stored letter
 * is the QWERTY one.
 *
 * Digits use `ev.code` on purpose: on AZERTY the unshifted digit row types
 * "&", "é", ..., and the shortcut should not require Shift.
 */
export function getPressedKey(ev: PressedKeyEvent): Key | null {
	const raw = (ev.key ?? "").toLowerCase();
	const code = ev.code ?? "";

	if (code === "Space" || raw === " " || raw === "spacebar" || raw === "space")
		return "space";

	if (raw === "arrowup") return "up";
	if (raw === "arrowdown") return "down";
	if (raw === "arrowleft") return "left";
	if (raw === "arrowright") return "right";

	if (isAsciiLetter(raw) && isKey(raw)) return raw;

	if (code.startsWith("Key") && (ev.altKey || !isSingleAsciiCharacter(raw))) {
		const letter = code.slice(3).toLowerCase();
		if (isKey(letter)) return letter;
	}

	if (code.startsWith("Digit")) {
		const digit = code.slice(5);
		if (isKey(digit)) return digit;
	}

	if (isKey(raw)) return raw;
	return null;
}
