import { describe, expect, test } from "bun:test";
import { bumpSourceVersion, getSourceVersion } from "../source-version";

describe("source content versions", () => {
	test("a reused source object gets a new version each time new pixels land in it", () => {
		// Stands in for a pooled CanvasSink canvas: same object, new frame.
		const pooledCanvas = {};
		const other = {};
		expect(getSourceVersion(pooledCanvas)).toBe(0);
		bumpSourceVersion(pooledCanvas);
		const afterFirstFrame = getSourceVersion(pooledCanvas);
		bumpSourceVersion(pooledCanvas);
		expect(getSourceVersion(pooledCanvas)).toBe(afterFirstFrame + 1);
		// Versions are per object: static images and stickers stay at 0.
		expect(getSourceVersion(other)).toBe(0);
		expect(getSourceVersion(null)).toBe(0);
	});
});
