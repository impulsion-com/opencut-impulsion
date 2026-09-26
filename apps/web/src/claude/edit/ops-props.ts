import {
	EFFECT_PARAM_PROPERTY_PATTERN,
	type ClipEffectOp,
	type KeyframeOp,
	type MaskOp,
	type SourceAudioOp,
	type ToggleTrackOp,
	type UpdateElementOp,
} from "@opencut/claude-tools";
import {
	buildEffectParamPath,
	buildGraphicParamPath,
	getElementKeyframes,
	hasKeyframesForPath,
	removeElementKeyframe,
	upsertPathKeyframe,
} from "@/animation";
import {
	buildDefaultEffectInstance,
	effectsRegistry,
	registerDefaultEffects,
} from "@/effects";
import { DEFAULT_GRAPHIC_SOURCE_SIZE } from "@/graphics";
import {
	buildDefaultMaskInstance,
	masksRegistry,
	registerDefaultMasks,
} from "@/masks";
import type { Mask } from "@/masks/types";
import type { ParamValues } from "@/params";
import {
	buildSeparatedAudioElement,
	canExtractSourceAudio,
	isSourceAudioSeparated,
} from "@/timeline/audio-separation";
import { isMaskableElement, isVisualElement } from "@/timeline/element-utils";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { resolveTrackPlacement } from "@/timeline/placement";
import type { MaskableElement, TimelineElement } from "@/timeline/types";
import { applyElementUpdate } from "@/timeline/update-pipeline";
import { frameTicks, ticksToSeconds } from "@/claude/units";
import {
	type MediaTime,
	maxMediaTime,
	minMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import {
	coerceParamRecord,
	getElementParamDefinitions,
	SCALE_GROUP_KEY,
	warnOnEmDash,
} from "./plan-params";
import {
	planFps,
	resolveEffectRef,
	resolveElementRef,
	resolveTrackRef,
	toTicks,
} from "./plan-refs";
import {
	addElementsToTrack,
	insertEmptyTrack,
	planError,
	recordCreated,
	replaceElement,
	updateTrack,
	warn,
	type PlanContext,
} from "./plan-state";

// Ops that change what an element looks or sounds like: update_element, keyframe, clip_effect, mask,
// toggle_track, source_audio.

function replace({
	ctx,
	element,
}: {
	ctx: PlanContext;
	element: TimelineElement;
}): void {
	ctx.state = {
		...ctx.state,
		tracks: replaceElement({ tracks: ctx.state.tracks, element }),
	};
}

/**
 * Refuses a param that has keyframes: the renderer reads an animated property from its keyframes and uses the
 * base value only when there are none, so setting it would change nothing on screen (the properties panel keys
 * such a change instead). `animationPath` is the channel's path, `property` the keyframe op's name for it.
 */
function assertNotAnimated({
	ctx,
	element,
	animationPath,
	property,
	path,
}: {
	ctx: PlanContext;
	element: TimelineElement;
	animationPath: string;
	property: string;
	path: (string | number)[];
}): void {
	const count = getElementKeyframes({ animations: element.animations }).filter(
		(keyframe) => keyframe.propertyPath === animationPath,
	).length;
	if (count === 0) return;
	throw planError({
		ctx,
		message: `"${property}" is animated (${count} keyframe${count > 1 ? "s" : ""}), so a new value would be hidden by its keyframes. Change its keyframes with keyframe ops on property "${property}", or remove them first.`,
		path,
	});
}

// ---------------------------------------------------------------------------
// update_element
// ---------------------------------------------------------------------------

export function applyUpdateElement({
	ctx,
	op,
}: {
	ctx: PlanContext;
	op: UpdateElementOp;
}): void {
	const { track, element } = resolveElementRef({
		ctx,
		value: op.elementId,
		path: ["elementId"],
	});
	const params: ParamValues =
		op.params && Object.keys(op.params).length > 0
			? coerceParamRecord({
					ctx,
					params: op.params,
					definitions: getElementParamDefinitions({ element }),
					subject: `a ${element.type} element`,
					path: ["params"],
				})
			: {};
	for (const key of Object.keys(params)) {
		// transform.scale was expanded to scaleX and scaleY: name it as the model wrote it.
		const grouped =
			key.startsWith("transform.scale") &&
			op.params !== undefined &&
			SCALE_GROUP_KEY in op.params &&
			!(key in op.params);
		const property = grouped ? SCALE_GROUP_KEY : key;
		assertNotAnimated({
			ctx,
			element,
			animationPath: key,
			property,
			path: ["params", property],
		});
		// A graphic shape's own params animate under "params.<key>".
		if (element.type === "graphic") {
			assertNotAnimated({
				ctx,
				element,
				animationPath: buildGraphicParamPath({ paramKey: key }),
				property: buildGraphicParamPath({ paramKey: key }),
				path: ["params", key],
			});
		}
	}
	if (typeof params.content === "string") {
		warnOnEmDash({ ctx, value: params.content, what: "content" });
	}
	if (op.muted !== undefined) {
		if (element.type !== "video" && element.type !== "audio") {
			throw planError({
				ctx,
				message: `muted applies to video and audio elements, not to a ${element.type} element.`,
				path: ["muted"],
			});
		}
		params.muted = op.muted;
	}
	if (op.hidden !== undefined && !isVisualElement(element)) {
		throw planError({
			ctx,
			message: `only visual elements can be hidden, not a ${element.type} element (use muted, or toggle_track).`,
			path: ["hidden"],
		});
	}

	const next = applyElementUpdate({
		element,
		patch: {
			params,
			...(op.name !== undefined ? { name: op.name } : {}),
			...(op.hidden !== undefined ? { hidden: op.hidden } : {}),
		},
		context: { tracks: ctx.state.tracks, trackId: track.id },
	});
	replace({ ctx, element: next });
}

// ---------------------------------------------------------------------------
// keyframe
// ---------------------------------------------------------------------------

const SCALE_PATHS = ["transform.scaleX", "transform.scaleY"] as const;
const EFFECT_PROPERTY_PREFIX = "effect.";

function keyframePaths({
	ctx,
	op,
	element,
}: {
	ctx: PlanContext;
	op: KeyframeOp;
	element: TimelineElement;
}): string[] {
	if (op.property === SCALE_GROUP_KEY) return [...SCALE_PATHS];
	if (EFFECT_PARAM_PROPERTY_PATTERN.test(op.property)) {
		const effectId = resolveEffectRef({
			ctx,
			value: op.effectId ?? "",
			path: ["effectId"],
		});
		const effects = isVisualElement(element) ? (element.effects ?? []) : [];
		if (!effects.some((effect) => effect.id === effectId)) {
			throw planError({
				ctx,
				code: "NOT_FOUND",
				message: `element ${element.id} has no clip effect "${effectId}"${effects.length > 0 ? ` (its effects: ${effects.map((effect) => effect.id).join(", ")})` : ""}.`,
				path: ["effectId"],
			});
		}
		return [
			buildEffectParamPath({
				effectId,
				paramKey: op.property.slice(EFFECT_PROPERTY_PREFIX.length),
			}),
		];
	}
	return [op.property];
}

/** The keyframe of `path` at `time`, or failing that the nearest one within one frame. */
function findKeyframe({
	element,
	path,
	time,
	tolerance,
}: {
	element: TimelineElement;
	path: string;
	time: MediaTime;
	tolerance: number;
}): { id: string; time: number; value: unknown } | null {
	let best: { id: string; time: number; value: unknown } | null = null;
	for (const keyframe of getElementKeyframes({
		animations: element.animations,
	})) {
		if (keyframe.propertyPath !== path) continue;
		const distance = Math.abs(keyframe.time - time);
		if (distance > tolerance) continue;
		if (!best || distance < Math.abs(best.time - time)) best = keyframe;
	}
	return best;
}

export function applyKeyframe({
	ctx,
	op,
}: {
	ctx: PlanContext;
	op: KeyframeOp;
}): void {
	const { element } = resolveElementRef({
		ctx,
		value: op.elementId,
		path: ["elementId"],
	});
	const paths = keyframePaths({ ctx, op, element });
	const requested = toTicks({ ctx, seconds: op.time });
	const time = maxMediaTime({
		a: ZERO_MEDIA_TIME,
		b: minMediaTime({ a: requested, b: element.duration }),
	});
	if (time !== requested) {
		warn({
			ctx,
			message: `keyframe time ${op.time} s is past the element's end (${ticksToSeconds({ ticks: element.duration })} s long) and was clamped to its last instant. Keyframe times are relative to the element start.`,
		});
	}

	let next = element;
	for (const path of paths) {
		const target = resolveAnimationTarget({ element: next, path });
		if (!target) {
			throw planError({
				ctx,
				message: `"${op.property}" cannot be keyframed on a ${element.type} element.`,
				path: ["property"],
			});
		}
		if (op.remove === true) {
			const keyframe = findKeyframe({
				element: next,
				path,
				time,
				tolerance: frameTicks({ fps: planFps({ ctx }) }),
			});
			if (!keyframe) {
				const times = getElementKeyframes({ animations: next.animations })
					.filter((candidate) => candidate.propertyPath === path)
					.map((candidate) => ticksToSeconds({ ticks: candidate.time }));
				throw planError({
					ctx,
					message: `there is no "${op.property}" keyframe at ${op.time} s on element ${element.id}${times.length > 0 ? ` (keyframes at ${times.join(", ")} s)` : " (it has none)"}.`,
					path: ["time"],
				});
			}
			const animations = removeElementKeyframe({
				animations: next.animations,
				propertyPath: path,
				keyframeId: keyframe.id,
			});
			// Like RemoveKeyframeCommand: removing the last key keeps its value as the static value.
			const base =
				!hasKeyframesForPath({ animations, propertyPath: path }) &&
				(typeof keyframe.value === "number" ||
					typeof keyframe.value === "string" ||
					typeof keyframe.value === "boolean")
					? target.setBaseValue({ value: keyframe.value })
					: next;
			next = { ...base, animations };
			continue;
		}

		const value = op.value;
		if (value === undefined || target.coerceValue({ value }) === null) {
			throw planError({
				ctx,
				message: `${JSON.stringify(value)} is not a valid value for "${op.property}".`,
				path: ["value"],
			});
		}
		const range = target.numericRanges?.value;
		if (
			typeof value === "number" &&
			range &&
			((range.min !== undefined && value < range.min) ||
				(range.max !== undefined && value > range.max))
		) {
			warn({
				ctx,
				message: `"${op.property}" value ${value} is out of range and was clamped to ${String(target.coerceValue({ value }))}.`,
			});
		}
		next = {
			...next,
			animations: upsertPathKeyframe({
				animations: next.animations,
				propertyPath: path,
				time,
				value,
				interpolation: op.interpolation,
				channelLayout: target.channelLayout,
				coerceValue: target.coerceValue,
			}),
		};
	}
	replace({ ctx, element: next });
}

// ---------------------------------------------------------------------------
// clip_effect
// ---------------------------------------------------------------------------

export function applyClipEffect({
	ctx,
	op,
}: {
	ctx: PlanContext;
	op: ClipEffectOp;
}): void {
	const { track, element } = resolveElementRef({
		ctx,
		value: op.elementId,
		path: ["elementId"],
	});
	if (!isVisualElement(element)) {
		throw planError({
			ctx,
			message: `clip effects apply to visual elements (video, image, text, sticker, graphic), not to a ${element.type} element.`,
			path: ["elementId"],
		});
	}
	registerDefaultEffects();
	const effects = element.effects ?? [];

	if (op.action === "add") {
		const effectType = op.effect ?? "blur";
		const definition = effectsRegistry.get(effectType);
		const params = op.params
			? coerceParamRecord({
					ctx,
					params: op.params,
					definitions: definition.params,
					subject: `a ${effectType} effect`,
					path: ["params"],
				})
			: {};
		const instance = buildDefaultEffectInstance({ effectType });
		const effect = {
			...instance,
			id: ctx.generateId(),
			params: { ...instance.params, ...params },
		};
		replace({ ctx, element: { ...element, effects: [...effects, effect] } });
		recordCreated({
			ctx,
			kind: "effect",
			id: effect.id,
			trackId: track.id,
			elementId: element.id,
			as: op.as,
		});
		return;
	}

	const effectId = resolveEffectRef({
		ctx,
		value: op.effectId ?? "",
		path: ["effectId"],
	});
	const effect = effects.find((candidate) => candidate.id === effectId);
	if (!effect) {
		throw planError({
			ctx,
			code: "NOT_FOUND",
			message: `element ${element.id} has no clip effect "${effectId}"${effects.length > 0 ? ` (its effects: ${effects.map((candidate) => candidate.id).join(", ")})` : " (it has none)"}.`,
			path: ["effectId"],
		});
	}

	if (op.action === "update") {
		const params = coerceParamRecord({
			ctx,
			params: op.params ?? {},
			definitions: effectsRegistry.get(effect.type).params,
			subject: `a ${effect.type} effect`,
			path: ["params"],
		});
		for (const key of Object.keys(params)) {
			assertNotAnimated({
				ctx,
				element,
				animationPath: buildEffectParamPath({ effectId, paramKey: key }),
				property: `${EFFECT_PROPERTY_PREFIX}${key}`,
				path: ["params", key],
			});
		}
		replace({
			ctx,
			element: {
				...element,
				effects: effects.map((candidate) =>
					candidate.id === effectId
						? { ...candidate, params: { ...candidate.params, ...params } }
						: candidate,
				),
			},
		});
		return;
	}

	if (op.action === "toggle") {
		replace({
			ctx,
			element: {
				...element,
				effects: effects.map((candidate) =>
					candidate.id === effectId
						? { ...candidate, enabled: !candidate.enabled }
						: candidate,
				),
			},
		});
		return;
	}

	// remove: also drop the effect's keyframe channels, which would otherwise linger as dead data.
	const prefix = buildEffectParamPath({ effectId, paramKey: "" });
	const animations = element.animations
		? Object.fromEntries(
				Object.entries(element.animations).filter(
					([path]) => !path.startsWith(prefix),
				),
			)
		: undefined;
	replace({
		ctx,
		element: {
			...element,
			effects: effects.filter((candidate) => candidate.id !== effectId),
			animations:
				animations && Object.keys(animations).length > 0
					? animations
					: undefined,
		},
	});
}

// ---------------------------------------------------------------------------
// mask
// ---------------------------------------------------------------------------

function numberParam({
	element,
	key,
	fallback,
}: {
	element: TimelineElement;
	key: string;
	fallback: number;
}): number {
	const value = element.params[key];
	return typeof value === "number" ? value : fallback;
}

/** On-canvas size of a maskable element at its base transform (what the Masks tab passes as elementSize). */
export function getMaskableElementSize({
	element,
	canvasSize,
	mediaAssets,
}: {
	element: MaskableElement;
	canvasSize: { width: number; height: number };
	mediaAssets: PlanContext["mediaAssets"];
}): { width: number; height: number } {
	let sourceWidth = DEFAULT_GRAPHIC_SOURCE_SIZE;
	let sourceHeight = DEFAULT_GRAPHIC_SOURCE_SIZE;
	if (element.type === "video" || element.type === "image") {
		const asset = mediaAssets.find(
			(candidate) => candidate.id === element.mediaId,
		);
		sourceWidth = asset?.width ?? canvasSize.width;
		sourceHeight = asset?.height ?? canvasSize.height;
	}
	const contain = Math.min(
		canvasSize.width / sourceWidth,
		canvasSize.height / sourceHeight,
	);
	return {
		width: Math.abs(
			sourceWidth *
				contain *
				numberParam({ element, key: "transform.scaleX", fallback: 1 }),
		),
		height: Math.abs(
			sourceHeight *
				contain *
				numberParam({ element, key: "transform.scaleY", fallback: 1 }),
		),
	};
}

function withMaskParams({
	mask,
	params,
}: {
	mask: Mask;
	params: ParamValues;
}): Mask {
	// The params were validated against this mask type's definitions, so the params shape still matches `type`.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return { ...mask, params: { ...mask.params, ...params } } as Mask;
}

export function applyMask({ ctx, op }: { ctx: PlanContext; op: MaskOp }): void {
	const { element } = resolveElementRef({
		ctx,
		value: op.elementId,
		path: ["elementId"],
	});
	if (!isMaskableElement(element)) {
		throw planError({
			ctx,
			message: `masks apply to video, image and graphic elements, not to a ${element.type} element.`,
			path: ["elementId"],
		});
	}
	const masks = element.masks ?? [];

	if (op.action === "set") {
		const maskType = op.type ?? "rectangle";
		registerDefaultMasks();
		const definition = masksRegistry.get(maskType);
		const params = op.params
			? coerceParamRecord({
					ctx,
					params: op.params,
					definitions: definition.params,
					subject: `a ${maskType} mask`,
					path: ["params"],
					extraBooleanKeys: ["inverted"],
				})
			: {};
		const mask = withMaskParams({
			mask: buildDefaultMaskInstance({
				maskType,
				elementSize: getMaskableElementSize({
					element,
					canvasSize: ctx.state.settings.canvasSize,
					mediaAssets: ctx.mediaAssets,
				}),
			}),
			params,
		});
		if (masks.length > 0) {
			warn({
				ctx,
				message: `the element's ${masks[0]?.type} mask was replaced (one mask per element).`,
			});
		}
		replace({ ctx, element: { ...element, masks: [mask] } });
		return;
	}

	if (masks.length === 0) {
		if (op.action === "remove") {
			warn({
				ctx,
				message: `element ${element.id} has no mask; nothing to remove.`,
			});
			return;
		}
		throw planError({
			ctx,
			message: `element ${element.id} has no mask to invert (set one first).`,
		});
	}
	if (op.action === "remove") {
		replace({ ctx, element: { ...element, masks: [] } });
		return;
	}
	replace({
		ctx,
		element: {
			...element,
			masks: masks.map((mask) =>
				withMaskParams({ mask, params: { inverted: !mask.params.inverted } }),
			),
		},
	});
}

// ---------------------------------------------------------------------------
// toggle_track
// ---------------------------------------------------------------------------

export function applyToggleTrack({
	ctx,
	op,
}: {
	ctx: PlanContext;
	op: ToggleTrackOp;
}): void {
	const track = resolveTrackRef({ ctx, value: op.trackId, path: ["trackId"] });
	let changed = false;
	if (op.mute !== undefined) {
		if (track.type !== "video" && track.type !== "audio") {
			throw planError({
				ctx,
				message: `a ${track.type} track has no sound to mute (only video and audio tracks).`,
				path: ["mute"],
			});
		}
		if (track.muted !== op.mute) {
			const muted = op.mute;
			ctx.state = {
				...ctx.state,
				tracks: updateTrack({
					tracks: ctx.state.tracks,
					trackId: track.id,
					update: (candidate) => ({ ...candidate, muted }),
				}),
			};
			changed = true;
		}
	}
	if (op.hide !== undefined) {
		if (track.type === "audio") {
			throw planError({
				ctx,
				message: "an audio track cannot be hidden (use mute).",
				path: ["hide"],
			});
		}
		if (track.hidden !== op.hide) {
			const hidden = op.hide;
			ctx.state = {
				...ctx.state,
				tracks: updateTrack({
					tracks: ctx.state.tracks,
					trackId: track.id,
					update: (candidate) => ({ ...candidate, hidden }),
				}),
			};
			changed = true;
		}
	}
	if (!changed) {
		warn({
			ctx,
			message: `track ${track.id} was already in that state; nothing changed.`,
		});
	}
}

// ---------------------------------------------------------------------------
// source_audio
// ---------------------------------------------------------------------------

export function applySourceAudio({
	ctx,
	op,
}: {
	ctx: PlanContext;
	op: SourceAudioOp;
}): void {
	const { element } = resolveElementRef({
		ctx,
		value: op.elementId,
		path: ["elementId"],
	});
	if (element.type !== "video") {
		throw planError({
			ctx,
			message: `source_audio applies to video elements, not to a ${element.type} element.`,
			path: ["elementId"],
		});
	}
	const asset = ctx.mediaAssets.find(
		(candidate) => candidate.id === element.mediaId,
	);

	if (!op.separate) {
		if (!isSourceAudioSeparated({ element })) {
			warn({
				ctx,
				message: `the clip's own sound is already on; nothing changed.`,
			});
			return;
		}
		replace({ ctx, element: { ...element, isSourceAudioEnabled: true } });
		const detached = [...ctx.state.tracks.audio]
			.flatMap((audioTrack) => audioTrack.elements)
			.filter(
				(candidate) =>
					candidate.sourceType === "upload" &&
					candidate.mediaId === element.mediaId &&
					candidate.startTime === element.startTime,
			)
			.map((candidate) => candidate.id);
		warn({
			ctx,
			message:
				detached.length > 0
					? `the clip's own sound is back on; delete the detached audio element (${detached.join(", ")}) too, or the sound plays twice.`
					: "the clip's own sound is back on; if a detached copy of it remains on an audio track, delete it or the sound plays twice.",
		});
		return;
	}

	if (isSourceAudioSeparated({ element })) {
		warn({
			ctx,
			message: "the clip's sound is already detached; nothing changed.",
		});
		return;
	}
	const elementId = element.id;
	// canExtractSourceAudio is a type guard on VideoElement, so `element` is `never` in the failure branch.
	if (!canExtractSourceAudio(element, asset)) {
		throw planError({
			ctx,
			message: asset
				? `the media of element ${elementId} has no audio track.`
				: `the media of element ${elementId} is missing from the project.`,
			path: ["elementId"],
		});
	}

	const audio: TimelineElement = {
		...buildSeparatedAudioElement({ sourceElement: element }),
		id: ctx.generateId(),
	};
	const placement = resolveTrackPlacement({
		tracks: ctx.state.tracks,
		trackType: "audio",
		timeSpans: [{ startTime: audio.startTime, duration: audio.duration }],
		strategy: { type: "firstAvailable" },
	});
	if (!placement) {
		throw planError({
			ctx,
			message: "no audio track can take the detached sound.",
		});
	}
	let tracks = ctx.state.tracks;
	let audioTrackId: string;
	if (placement.kind === "newTrack") {
		audioTrackId = ctx.generateId();
		tracks = insertEmptyTrack({
			tracks,
			type: "audio",
			displayIndex: placement.insertIndex,
			id: audioTrackId,
		});
	} else {
		audioTrackId = placement.trackId;
	}
	tracks = addElementsToTrack({
		tracks,
		trackId: audioTrackId,
		elements: [audio],
	});
	tracks = replaceElement({
		tracks,
		element: { ...element, isSourceAudioEnabled: false },
	});
	ctx.state = { ...ctx.state, tracks };
	recordCreated({
		ctx,
		kind: "element",
		id: audio.id,
		trackId: audioTrackId,
		as: op.as,
	});
}
