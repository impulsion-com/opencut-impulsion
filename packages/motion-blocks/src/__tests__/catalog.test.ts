import { describe, expect, test } from "bun:test";
import {
	clampMotionDuration,
	defaultMotionProps,
	getMotionBlock,
	MOTION_BLOCKS,
	MOTION_MAX_DURATION,
	MotionPropsError,
	normalizeMotionProps,
} from "../catalog";

const EM_DASH = String.fromCharCode(0x2014);

describe("motion block catalogue", () => {
	test("ids are unique and every block's defaults are valid settings", () => {
		const ids = MOTION_BLOCKS.map((block) => block.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const block of MOTION_BLOCKS) {
			const props = defaultMotionProps(block);
			expect(Object.keys(props)).toEqual(block.fields.map((field) => field.key));
			// Normalising twice changes nothing: the stored settings can always be sent back.
			expect(normalizeMotionProps(block, props)).toEqual(props);
			expect(block.defaultDuration).toBeGreaterThanOrEqual(block.minDuration);
		}
	});

	test("no label, description or default text contains an em dash", () => {
		expect(JSON.stringify(MOTION_BLOCKS)).not.toContain(EM_DASH);
	});

	test("omitted settings take the defaults, given ones are kept", () => {
		const block = getMotionBlock("headline");
		if (!block) throw new Error("headline block missing");
		const props = normalizeMotionProps(block, { pill: "Motion", scale: 2 });
		expect(props.pill).toBe("Motion");
		expect(props.scale).toBe(2);
		expect(props.lead).toBe("Devenir");
		expect(props.placement).toBe("left");
	});

	test("typos and wrong types are refused instead of being dropped", () => {
		const cta = getMotionBlock("cta");
		const stack = getMotionBlock("stack");
		if (!cta || !stack) throw new Error("blocks missing");
		const refuse = (run: () => unknown) => expect(run).toThrow(MotionPropsError);
		refuse(() => normalizeMotionProps(cta, { labl: "x" }));
		refuse(() => normalizeMotionProps(cta, { label: 3 }));
		refuse(() => normalizeMotionProps(cta, { placement: "middle" }));
		refuse(() => normalizeMotionProps(cta, { scale: 99 }));
		refuse(() => normalizeMotionProps(stack, { items: "a, b" }));
		refuse(() => normalizeMotionProps(stack, { items: [{ icon: "rocket", label: "x", sub: "" }] }));
		refuse(() => normalizeMotionProps(stack, { items: [{ label: "x", extra: 1 }] }));
		refuse(() =>
			normalizeMotionProps(stack, {
				items: Array.from({ length: 9 }, () => ({ icon: "check", label: "x", sub: "" })),
			}),
		);
	});

	test("list rows are completed with the row defaults", () => {
		const stack = getMotionBlock("stack");
		if (!stack) throw new Error("stack block missing");
		expect(normalizeMotionProps(stack, { items: [{ label: "Une carte" }] }).items).toEqual([
			{ icon: "check", label: "Une carte", sub: "" },
		]);
	});

	test("durations are clamped to the block minimum and to the global maximum", () => {
		const block = getMotionBlock("program");
		if (!block) throw new Error("program block missing");
		expect(clampMotionDuration(block, 0.2)).toBe(block.minDuration);
		expect(clampMotionDuration(block, 999)).toBe(MOTION_MAX_DURATION);
		expect(clampMotionDuration(block, 7.5)).toBe(7.5);
	});
});
