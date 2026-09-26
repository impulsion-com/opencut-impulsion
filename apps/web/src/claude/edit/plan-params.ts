import type { ParamRecord } from "@opencut/claude-tools";
import { getGraphicDefinition } from "@/graphics";
import {
	coerceParamValue,
	parseColorToLinearRgba,
	type NumberParamDefinition,
	type ParamDefinition,
	type ParamValues,
} from "@/params";
import { snapToStep } from "@/utils/math";
import { getElementParams } from "@/params/registry";
import type { TimelineElement } from "@/timeline/types";
import { planError, warn, type PlanContext } from "./plan-state";

// Param validation for update_element, add_* params, clip effects and masks: every key must exist in the schema
// that applies (unknown keys are errors, never silently dropped), values are coerced with the editor's own
// coerceParamValue, and out-of-range numbers are clamped with a warning.

export const SCALE_GROUP_KEY = "transform.scale";
const SCALE_KEYS = ["transform.scaleX", "transform.scaleY"] as const;

/** The param schema of an element: its kind's params, plus the shape's own params for graphics. */
export function getElementParamDefinitions({
	element,
}: {
	element: TimelineElement;
}): ParamDefinition[] {
	const base: ParamDefinition[] = [...getElementParams({ element })];
	if (element.type === "graphic") {
		base.push(
			...getGraphicDefinition({ definitionId: element.definitionId }).params,
		);
	}
	return base;
}

/** Stored-space bounds of a number param (min/max are in display space when displayMultiplier is set). */
function storedBounds({ param }: { param: NumberParamDefinition }): {
	min: number;
	max: number | undefined;
	multiplier: number;
} {
	const multiplier = param.displayMultiplier ?? 1;
	return {
		min: param.min / multiplier,
		max: param.max === undefined ? undefined : param.max / multiplier,
		multiplier,
	};
}

/**
 * coerceParamValue for numbers, aware of displayMultiplier: the editor's coerceParamValue snaps and clamps the
 * STORED value with display-space step and bounds (the UI converts before calling it), which would turn a mask
 * centerX of 0.25 into 0.
 */
function coerceNumber({
	param,
	value,
}: {
	param: NumberParamDefinition;
	value: number;
}): number {
	const { multiplier } = storedBounds({ param });
	const display = snapToStep({ value: value * multiplier, step: param.step });
	const clamped = Math.min(
		param.max ?? Number.POSITIVE_INFINITY,
		Math.max(param.min, display),
	);
	return clamped / multiplier;
}

function describeExpected({ param }: { param: ParamDefinition }): string {
	switch (param.type) {
		case "number": {
			const { min, max } = storedBounds({ param });
			return `a number${max !== undefined ? ` between ${min} and ${max}` : ` >= ${min}`}`;
		}
		case "boolean":
			return "true or false";
		case "color":
			return 'a colour string such as "#ffffff"';
		case "select":
			return `one of ${param.options.map((option) => `"${option.value}"`).join(", ")}`;
		case "text":
		case "font":
			return "a string";
	}
}

/**
 * Validates and coerces a param record against `definitions`. "transform.scale" expands into scaleX and scaleY
 * (explicit scaleX / scaleY in the same record win). Throws INVALID_EDIT for unknown keys or wrong value types.
 */
export function coerceParamRecord({
	ctx,
	params,
	definitions,
	subject,
	path,
	extraBooleanKeys = [],
}: {
	ctx: PlanContext;
	params: ParamRecord;
	definitions: readonly ParamDefinition[];
	/** e.g. "a text element", used in messages. */
	subject: string;
	path: (string | number)[];
	/** Boolean keys accepted without a definition (mask "inverted"). */
	extraBooleanKeys?: readonly string[];
}): ParamValues {
	const byKey = new Map(
		definitions.map((definition) => [definition.key, definition]),
	);
	const expanded: [string, ParamRecord[string]][] = [];
	for (const [key, value] of Object.entries(params)) {
		if (key === SCALE_GROUP_KEY && byKey.has(SCALE_KEYS[0])) {
			for (const scaleKey of SCALE_KEYS) {
				if (!(scaleKey in params)) expanded.push([scaleKey, value]);
			}
			continue;
		}
		expanded.push([key, value]);
	}

	const result: ParamValues = {};
	for (const [key, value] of expanded) {
		if (extraBooleanKeys.includes(key)) {
			if (typeof value !== "boolean") {
				throw planError({
					ctx,
					message: `param "${key}" expects true or false.`,
					path: [...path, key],
				});
			}
			result[key] = value;
			continue;
		}
		const param = byKey.get(key);
		if (!param) {
			const valid = [
				...(byKey.has(SCALE_KEYS[0]) ? [SCALE_GROUP_KEY] : []),
				...byKey.keys(),
				...extraBooleanKeys,
			];
			throw planError({
				ctx,
				message: `unknown param "${key}" for ${subject}. Valid keys: ${valid.join(", ")}.`,
				path: [...path, key],
			});
		}
		if (
			param.type === "color" &&
			(typeof value !== "string" ||
				parseColorToLinearRgba({ color: value }) === null)
		) {
			throw planError({
				ctx,
				message: `param "${key}" expects ${describeExpected({ param })}, got ${JSON.stringify(value)}.`,
				path: [...path, key],
			});
		}
		const coerced =
			param.type === "number" &&
			typeof value === "number" &&
			Number.isFinite(value)
				? coerceNumber({ param, value })
				: coerceParamValue({ param, value });
		if (coerced === null) {
			throw planError({
				ctx,
				message: `param "${key}" expects ${describeExpected({ param })}, got ${JSON.stringify(value)}.`,
				path: [...path, key],
			});
		}
		const bounds = param.type === "number" ? storedBounds({ param }) : null;
		if (
			bounds &&
			typeof value === "number" &&
			(value < bounds.min || (bounds.max !== undefined && value > bounds.max))
		) {
			warn({
				ctx,
				message: `"${key}" ${value} is out of range and was clamped to ${coerced}.`,
			});
		}
		result[key] = coerced;
	}
	return result;
}

/** Warns when a text value contains the em dash character (house rule: never on screen). */
export function warnOnEmDash({
	ctx,
	value,
	what,
}: {
	ctx: PlanContext;
	value: string;
	what: string;
}): void {
	if (value.includes("\u2014")) {
		warn({
			ctx,
			message: `${what} contains an em dash character; the house style never uses it (replace it with a comma, a colon or a short dash).`,
		});
	}
}
