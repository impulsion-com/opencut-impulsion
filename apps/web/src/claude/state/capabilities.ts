import {
	ANIMATION_PROPERTY_GROUPS,
	ANIMATION_PROPERTY_PATHS,
} from "@/animation/types";
import { effectsRegistry, registerDefaultEffects } from "@/effects";
import { graphicsRegistry, registerDefaultGraphics } from "@/graphics";
import {
	getMaskDefinitionsForMenu,
	masksRegistry,
	registerDefaultMasks,
} from "@/masks";
import type { MaskType } from "@/masks/types";
import type {
	NumberParamDefinition,
	ParamDefinition,
	ParamValue,
} from "@/params";
import { getBuiltInElementParams } from "@/params/registry";
import { getTrackTypeForElementType } from "@/timeline/placement/compatibility";
import type { ElementType, TimelineElement } from "@/timeline/types";

// list_capabilities and the param schemas of get_element, read from the editor's registries (map 9.1) so the
// answer always matches what the running editor accepts.

const ELEMENT_KINDS: readonly ElementType[] = [
	"video",
	"image",
	"audio",
	"text",
	"sticker",
	"graphic",
	"effect",
];

/** What the editor does not do at all, so Claude stops looking for it. */
const NOT_IMPLEMENTED = [
	"transitions",
	"speed ramps (constant speed only)",
	"track reordering",
	"slip, slide and roll edits",
	"ripple insert",
	"text stroke, shadow or per-word colour",
];

export interface ParamSchema {
	key: string;
	type: ParamDefinition["type"];
	default: ParamValue;
	min?: number;
	max?: number;
	step?: number;
	options?: string[];
	keyframable: boolean;
	unit?: string;
	/** Only meaningful when these other params have these values (e.g. text background). */
	dependsOn?: Record<string, ParamValue>;
}

/**
 * A number param's range in STORED units, the ones Claude writes: with displayMultiplier set, the definition's
 * min/max/step are in the editor's display space (masks show percentages of the element: centerX -100..100 is
 * stored as -1..1).
 */
function storedRange(param: NumberParamDefinition): {
	min: number;
	max?: number;
	step: number;
} {
	const multiplier = param.displayMultiplier ?? 1;
	return {
		min: param.min / multiplier,
		...(param.max !== undefined ? { max: param.max / multiplier } : {}),
		step: param.step / multiplier,
	};
}

export function serializeParamDefinition(param: ParamDefinition): ParamSchema {
	const schema: ParamSchema = {
		key: param.key,
		type: param.type,
		default: param.default,
		keyframable: param.keyframable !== false,
	};
	if (param.type === "number") {
		const range = storedRange(param);
		schema.min = range.min;
		if (range.max !== undefined) schema.max = range.max;
		schema.step = range.step;
		if (param.unit) schema.unit = param.unit;
	}
	if (param.type === "select") {
		schema.options = param.options.map((option) => option.value);
		schema.keyframable = false;
	}
	if (param.type === "text" || param.type === "font") {
		schema.keyframable = false;
	}
	if (param.dependencies && param.dependencies.length > 0) {
		schema.dependsOn = Object.fromEntries(
			param.dependencies.map((dependency) => [
				dependency.param,
				dependency.equals,
			]),
		);
	}
	return schema;
}

function ensureRegistries(): void {
	// Idempotent; graphics are otherwise registered lazily on the first graphic insert.
	registerDefaultEffects();
	registerDefaultMasks();
	registerDefaultGraphics();
}

function effectSchemas() {
	return effectsRegistry.getAll().map((definition) => ({
		type: definition.type,
		name: definition.name,
		params: definition.params.map(serializeParamDefinition),
	}));
}

function graphicSchemas() {
	return graphicsRegistry.getAll().map((definition) => ({
		shape: definition.id,
		name: definition.name,
		params: definition.params.map(serializeParamDefinition),
	}));
}

function maskSchema(type: MaskType) {
	const definition = masksRegistry.get(type);
	return {
		type: definition.type,
		name: definition.name,
		settable: definition.type !== "freeform",
		params: definition.params.map(serializeParamDefinition),
	};
}

interface KeyframePropertyInfo {
	property: string;
	value: "number" | "color";
	/** Element kinds whose params include this property. */
	elementKinds: ElementType[];
	min?: number;
	max?: number;
	note?: string;
}

function keyframeProperties(): KeyframePropertyInfo[] {
	const properties: KeyframePropertyInfo[] = [];
	for (const path of ANIMATION_PROPERTY_PATHS) {
		const kinds: ElementType[] = [];
		let definition: ParamDefinition | undefined;
		for (const kind of ELEMENT_KINDS) {
			const param = getBuiltInElementParams({ type: kind }).find(
				(candidate) =>
					candidate.key === path && candidate.keyframable !== false,
			);
			if (!param) continue;
			kinds.push(kind);
			definition ??= param;
		}
		if (!definition) continue;
		const range =
			definition.type === "number" ? storedRange(definition) : null;
		properties.push({
			property: path,
			value: definition.type === "color" ? "color" : "number",
			elementKinds: kinds,
			...(range
				? {
						min: range.min,
						...(range.max !== undefined ? { max: range.max } : {}),
					}
				: {}),
		});
	}
	for (const [group, members] of Object.entries(ANIMATION_PROPERTY_GROUPS)) {
		const first = properties.find((entry) => entry.property === members[0]);
		if (!first) continue;
		properties.push({
			...first,
			property: group,
			note: `Sets ${members.join(" and ")} together (uniform zoom).`,
		});
	}
	properties.push(
		{
			property: "params.<key>",
			value: "number",
			elementKinds: ["graphic"],
			note: "A graphic shape's own numeric or colour param (see graphics[].params).",
		},
		{
			property: "effect.<key>",
			value: "number",
			elementKinds: ["video", "image", "text", "sticker", "graphic"],
			note: "A clip effect param, together with effectId (see effects[].params).",
		},
	);
	return properties;
}

export function buildCapabilities() {
	ensureRegistries();
	const blendModes =
		getBuiltInElementParams({ type: "image" })
			.map(serializeParamDefinition)
			.find((param) => param.key === "blendMode")?.options ?? [];
	return {
		elementKinds: ELEMENT_KINDS,
		trackCompatibility: Object.fromEntries(
			ELEMENT_KINDS.map((kind) => [
				kind,
				getTrackTypeForElementType({ elementType: kind }),
			]),
		),
		params: Object.fromEntries(
			ELEMENT_KINDS.map((kind) => [
				kind,
				getBuiltInElementParams({ type: kind }).map(serializeParamDefinition),
			]),
		),
		effects: effectSchemas(),
		graphics: graphicSchemas(),
		masks: getMaskDefinitionsForMenu().map((definition) =>
			maskSchema(definition.type),
		),
		blendModes,
		keyframeProperties: keyframeProperties(),
		units: {
			time: "seconds (3 decimals); keyframe times relative to the element start",
			position: "canvas px from the canvas centre, +y down",
			fontSize: "editor units: rendered px = fontSize x canvasHeight / 90",
			rotate: "degrees",
			opacity: "0..1",
			volume: "dB (-60..20)",
		},
		notImplemented: NOT_IMPLEMENTED,
	};
}

/** The schemas that apply to one element: its own params, plus its shape, clip effects and mask. */
export function buildElementParamSchema(element: TimelineElement) {
	ensureRegistries();
	const schema: {
		element: ParamSchema[];
		graphic?: ParamSchema[];
		effects?: Record<string, ParamSchema[]>;
		mask?: ParamSchema[];
	} = {
		element: getBuiltInElementParams({ type: element.type }).map(
			serializeParamDefinition,
		),
	};
	if (
		element.type === "graphic" &&
		graphicsRegistry.has(element.definitionId)
	) {
		schema.graphic = graphicsRegistry
			.get(element.definitionId)
			.params.map(serializeParamDefinition);
	}
	if (element.type === "effect" && effectsRegistry.has(element.effectType)) {
		// An adjustment layer's params are its effect's params.
		schema.element = effectsRegistry
			.get(element.effectType)
			.params.map(serializeParamDefinition);
	}
	const effects = "effects" in element ? (element.effects ?? []) : [];
	if (effects.length > 0) {
		schema.effects = Object.fromEntries(
			[...new Set(effects.map((effect) => effect.type))]
				.filter((type) => effectsRegistry.has(type))
				.map((type) => [
					type,
					effectsRegistry.get(type).params.map(serializeParamDefinition),
				]),
		);
	}
	const mask = "masks" in element ? element.masks?.[0] : undefined;
	if (mask && masksRegistry.has(mask.type)) {
		schema.mask = maskSchema(mask.type).params;
	}
	return schema;
}
