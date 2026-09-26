import { describe, expect, test } from "bun:test";
import { buildCapabilities } from "@/claude/state/capabilities";
import { masksRegistry, registerDefaultMasks } from "@/masks";

// list_capabilities and get_element tell Claude which values a param accepts. The mask op takes STORED units
// (centerX 0.25 = a quarter of the width), while mask definitions keep display-space bounds for the UI.

describe("list_capabilities ranges", () => {
	test("mask params are reported in stored units (display bounds / displayMultiplier)", () => {
		const capabilities = buildCapabilities();
		const rectangle = capabilities.masks.find((mask) => mask.type === "rectangle");
		const param = (key: string) =>
			rectangle?.params.find((candidate) => candidate.key === key);
		expect(param("centerX")).toMatchObject({ min: -1, max: 1, step: 0.01 });
		expect(param("width")).toMatchObject({ default: 0.6, min: 0.01 });
		expect(param("rotation")).toMatchObject({ min: 0, max: 360, step: 1 });

		registerDefaultMasks();
		for (const mask of capabilities.masks) {
			const definition = masksRegistry.get(mask.type);
			for (const reported of mask.params) {
				const source = definition.params.find((p) => p.key === reported.key);
				if (source?.type !== "number") continue;
				const multiplier = source.displayMultiplier ?? 1;
				expect(reported.min).toBeCloseTo(source.min / multiplier);
				// Every default sits inside the reported range.
				expect(Number(reported.default)).toBeGreaterThanOrEqual(
					(reported.min ?? 0) - 1e-9,
				);
				if (reported.max !== undefined)
					expect(Number(reported.default)).toBeLessThanOrEqual(reported.max + 1e-9);
			}
		}
	});
});
