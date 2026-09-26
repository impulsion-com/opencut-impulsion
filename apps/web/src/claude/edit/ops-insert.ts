import {
	TOOL_DEFAULTS,
	type AddEffectLayerOp,
	type AddGraphicOp,
	type AddTextOp,
	type InsertMediaOp,
	type ParamRecord,
} from "@opencut/claude-tools";
import type { FrameRate } from "opencut-wasm";
import { effectsRegistry, registerDefaultEffects } from "@/effects";
import { floatToFrameRate } from "@/fps/utils";
import { getGraphicDefinition } from "@/graphics";
import { getBuiltInElementParams } from "@/params/registry";
import { DEFAULTS } from "@/timeline/defaults";
import {
	buildEffectElement,
	buildElementFromMedia,
	buildGraphicElement,
	buildTextElement,
} from "@/timeline/element-utils";
import {
	canElementGoOnTrack,
	getHighestInsertIndexForTrack,
	resolveTrackPlacement,
} from "@/timeline/placement";
import { getTrackTypeForElementType } from "@/timeline/placement/compatibility";
import { canPlaceTimeSpansOnTrack } from "@/timeline/placement/overlap";
import type { TProjectSettings } from "@/project/types";
import type { CreateTimelineElement, TimelineElement } from "@/timeline/types";
import { frameTicks, ticksToSeconds } from "@/claude/units";
import {
	mediaTime,
	mediaTimeFromSeconds,
	type MediaTime,
	roundFrameTime,
	subMediaTime,
} from "@/wasm";
import { coerceParamRecord, warnOnEmDash } from "./plan-params";
import {
	planFps,
	resolveTrackRef,
	toDurationTicks,
	toTicks,
} from "./plan-refs";
import {
	addElementsToTrack,
	countElements,
	insertEmptyTrack,
	planError,
	recordCreated,
	warn,
	type PlanContext,
} from "./plan-state";
import { buildMeasureFont, wrapText } from "./text-layout";

// Ops that create timeline elements. Placement mirrors InsertElementCommand (resolveTrackPlacement, the main-track
// start rule) but refuses overlaps on explicit tracks and incompatible kinds with a precise error instead of
// failing silently.

type TrackTarget = string | undefined;

/**
 * Adds `element` (id already set) to the working tracks at `target`. Returns the track it landed on. Keywords:
 * "main" (video/image only), "overlay" (a new track of the right kind on top: for audio, the top audio slot),
 * "audio" (audio only: first audio track with room, else a new one), "auto"/undefined (first compatible track with
 * room, else a new top track), or a track id / "@name".
 */
export function placeElement({
	ctx,
	element,
	target,
	path,
}: {
	ctx: PlanContext;
	element: TimelineElement;
	target: TrackTarget;
	path: (string | number)[];
}): { trackId: string; element: TimelineElement } {
	const tracks = ctx.state.tracks;
	const trackType = getTrackTypeForElementType({ elementType: element.type });
	const span = { startTime: element.startTime, duration: element.duration };

	if (target === "overlay") {
		const trackId = ctx.generateId();
		const withTrack = insertEmptyTrack({
			tracks,
			type: trackType,
			displayIndex: getHighestInsertIndexForTrack({ tracks, trackType }),
			id: trackId,
		});
		ctx.state = {
			...ctx.state,
			tracks: addElementsToTrack({
				tracks: withTrack,
				trackId,
				elements: [element],
			}),
		};
		return { trackId, element };
	}

	if (target === "audio" && element.type !== "audio") {
		throw planError({
			ctx,
			message: `track "audio" only takes audio; a ${element.type} element needs "main", "overlay", "auto" or a track id.`,
			path,
		});
	}
	if (target === "main" && trackType !== "video") {
		throw planError({
			ctx,
			message: `the main track only takes video and images, not a ${element.type} element.`,
			path,
		});
	}

	let placement;
	if (target === undefined || target === "auto" || target === "audio") {
		placement = resolveTrackPlacement({
			tracks,
			...(target === "audio"
				? { trackType: "audio" }
				: { elementType: element.type }),
			timeSpans: [span],
			strategy: { type: "firstAvailable" },
		});
	} else {
		const track = resolveTrackRef({ ctx, value: target, path });
		if (
			!canElementGoOnTrack({ elementType: element.type, trackType: track.type })
		) {
			throw planError({
				ctx,
				message: `a ${element.type} element cannot go on track ${track.id} (a ${track.type} track${track.id === tracks.main.id ? ", the main track" : ""}).`,
				path,
			});
		}
		placement = resolveTrackPlacement({
			tracks,
			elementType: element.type,
			timeSpans: [span],
			strategy: { type: "explicit", trackId: track.id },
		});
	}
	if (!placement) {
		throw planError({ ctx, message: "the element could not be placed.", path });
	}

	if (placement.kind === "newTrack") {
		const trackId = ctx.generateId();
		const withTrack = insertEmptyTrack({
			tracks,
			type: placement.trackType,
			displayIndex: placement.insertIndex,
			id: trackId,
		});
		ctx.state = {
			...ctx.state,
			tracks: addElementsToTrack({
				tracks: withTrack,
				trackId,
				elements: [element],
			}),
		};
		return { trackId, element };
	}

	let placed = element;
	if (
		placement.adjustedStartTime !== undefined &&
		placement.adjustedStartTime !== element.startTime
	) {
		placed = { ...element, startTime: placement.adjustedStartTime };
		warn({
			ctx,
			message: `start moved from ${ticksToSeconds({ ticks: element.startTime })} s to ${ticksToSeconds({ ticks: placed.startTime })} s: the first clip of the main track always starts at 0 s.`,
		});
	}
	const targetTrack = [...tracks.overlay, tracks.main, ...tracks.audio][
		placement.trackIndex
	];
	if (
		!targetTrack ||
		!canPlaceTimeSpansOnTrack({
			track: targetTrack,
			timeSpans: [{ startTime: placed.startTime, duration: placed.duration }],
		})
	) {
		const clash = targetTrack?.elements.find(
			(other) =>
				placed.startTime < other.startTime + other.duration &&
				placed.startTime + placed.duration > other.startTime,
		);
		throw planError({
			ctx,
			message: `it would overlap element ${clash?.id ?? "?"} (${clash ? `${ticksToSeconds({ ticks: clash.startTime })}-${ticksToSeconds({ ticks: clash.startTime + clash.duration })} s` : ""}) on track ${placement.trackId}. Pick a free time, another track, or "overlay" for a new track.`,
			path,
		});
	}
	ctx.state = {
		...ctx.state,
		tracks: addElementsToTrack({
			tracks,
			trackId: placement.trackId,
			elements: [placed],
		}),
	};
	return { trackId: placement.trackId, element: placed };
}

function withId({
	element,
	id,
}: {
	element: CreateTimelineElement;
	id: string;
}): TimelineElement {
	// CreateTimelineElement is exactly TimelineElement without `id`, member by member.
	return { ...element, id } as TimelineElement;
}

/** Largest whole number of frames that fits in `ticks` (`ticks` itself when shorter than one frame). */
export function floorToFrame({
	ticks,
	fps,
}: {
	ticks: MediaTime;
	fps: FrameRate;
}): MediaTime {
	const frame = frameTicks({ fps });
	if (ticks < frame) return ticks;
	const rounded = roundFrameTime({ time: ticks, fps });
	// roundFrameTime rounds to the nearest frame, so it overshoots by less than one frame at most.
	return rounded <= ticks ? rounded : subMediaTime({ a: rounded, b: frame });
}

// ---------------------------------------------------------------------------
// insert_media
// ---------------------------------------------------------------------------

export function applyInsertMedia({
	ctx,
	op,
}: {
	ctx: PlanContext;
	op: InsertMediaOp;
}): void {
	const asset = ctx.mediaAssets.find(
		(candidate) => candidate.id === op.mediaId,
	);
	if (!asset) {
		throw planError({
			ctx,
			code: "NOT_FOUND",
			message: `media "${op.mediaId}" is not in the project (use list_media, or import_media first).`,
			path: ["mediaId"],
		});
	}
	const fps = planFps({ ctx });
	const startTime = toTicks({ ctx, seconds: op.start });
	const isFirstElement = countElements({ tracks: ctx.state.tracks }) === 0;

	let create: CreateTimelineElement;
	if (asset.type === "image") {
		if (op.trimStart !== undefined && op.trimStart > 0) {
			warn({ ctx, message: "trimStart is ignored for images." });
		}
		const duration = toDurationTicks({
			ctx,
			seconds: op.duration ?? TOOL_DEFAULTS.imageDurationSeconds,
		});
		create = buildElementFromMedia({
			mediaId: asset.id,
			mediaType: "image",
			name: asset.name,
			duration,
			startTime,
		});
	} else {
		const trimStart = mediaTimeFromSeconds({ seconds: op.trimStart ?? 0 });
		const hasKnownDuration =
			typeof asset.duration === "number" && asset.duration > 0;
		const requested =
			op.duration !== undefined
				? toDurationTicks({ ctx, seconds: op.duration })
				: null;
		let sourceDuration: MediaTime;
		let duration: MediaTime;
		if (hasKnownDuration) {
			sourceDuration = mediaTimeFromSeconds({ seconds: asset.duration ?? 0 });
			if (trimStart >= sourceDuration) {
				throw planError({
					ctx,
					message: `trimStart ${op.trimStart} s is past the end of the media (${ticksToSeconds({ ticks: sourceDuration })} s).`,
					path: ["trimStart"],
				});
			}
			const available = subMediaTime({ a: sourceDuration, b: trimStart });
			if (requested === null) {
				duration = floorToFrame({ ticks: available, fps });
			} else if (requested > available) {
				if (requested - available > frameTicks({ fps })) {
					throw planError({
						ctx,
						message: `duration ${op.duration} s exceeds what the media has after trimStart (${ticksToSeconds({ ticks: available })} s).`,
						path: ["duration"],
					});
				}
				duration = available;
			} else {
				duration = requested;
			}
		} else {
			duration =
				requested ??
				toDurationTicks({ ctx, seconds: TOOL_DEFAULTS.elementDurationSeconds });
			sourceDuration = mediaTime({ ticks: trimStart + duration });
			warn({
				ctx,
				message:
					"the media duration is unknown; the clip cannot be checked against the source length.",
			});
		}
		const base = buildElementFromMedia({
			mediaId: asset.id,
			mediaType: asset.type,
			name: asset.name,
			duration,
			startTime,
		});
		create = {
			...base,
			trimStart,
			trimEnd: subMediaTime({
				a: subMediaTime({ a: sourceDuration, b: trimStart }),
				b: duration,
			}),
			sourceDuration,
		};
	}

	const element = withId({ element: create, id: ctx.generateId() });
	const placed = placeElement({
		ctx,
		element,
		target: op.track,
		path: ["track"],
	});
	recordCreated({
		ctx,
		kind: "element",
		id: placed.element.id,
		trackId: placed.trackId,
		as: op.as,
	});

	if (isFirstElement && (asset.type === "video" || asset.type === "image")) {
		applyFirstClipCanvasRule({ ctx, asset });
	}
}

/**
 * InsertElementCommand's rule: the first video or image on an empty timeline sets the canvas to the media size
 * (and originalCanvasSize if unset) and, for a video, the fps to the media's. Recorded as a non-undoable settings
 * step, like the editor does it.
 */
function applyFirstClipCanvasRule({
	ctx,
	asset,
}: {
	ctx: PlanContext;
	asset: PlanContext["mediaAssets"][number];
}): void {
	const patch: Partial<TProjectSettings> = {};
	if (asset.width && asset.height) {
		const canvasSize = { width: asset.width, height: asset.height };
		patch.canvasSize = canvasSize;
		if (!ctx.state.settings.originalCanvasSize)
			patch.originalCanvasSize = canvasSize;
	}
	if (asset.type === "video" && asset.fps) {
		patch.fps = floatToFrameRate(asset.fps);
	}
	if (Object.keys(patch).length === 0) return;
	ctx.settingsSteps.push({ opIndex: ctx.opIndex, patch, undoable: false });
	ctx.state = { ...ctx.state, settings: { ...ctx.state.settings, ...patch } };
	warn({
		ctx,
		message: `first clip on an empty timeline: the editor set the canvas to ${patch.canvasSize ? `${patch.canvasSize.width}x${patch.canvasSize.height}` : "(unchanged)"}${patch.fps ? ` at ${Math.round((patch.fps.numerator / patch.fps.denominator) * 1000) / 1000} fps` : ""}. Add a project_settings op after this one to keep another canvas.`,
	});
}

// ---------------------------------------------------------------------------
// add_text
// ---------------------------------------------------------------------------

const TEXT_STYLE_KEYS = [
	"fontFamily",
	"fontSize",
	"color",
	"fontWeight",
	"fontStyle",
	"textDecoration",
	"textAlign",
	"letterSpacing",
	"lineHeight",
] as const;

const TEXT_BACKGROUND_KEYS = [
	"enabled",
	"color",
	"cornerRadius",
	"paddingX",
	"paddingY",
	"offsetX",
	"offsetY",
] as const;

function textStyleToParams({ op }: { op: AddTextOp }): ParamRecord {
	const record: ParamRecord = {};
	const style = op.style;
	if (style) {
		for (const key of TEXT_STYLE_KEYS) {
			const value = style[key];
			if (value !== undefined) record[key] = value;
		}
		if (style.background) {
			for (const key of TEXT_BACKGROUND_KEYS) {
				const value = style.background[key];
				if (value !== undefined) record[`background.${key}`] = value;
			}
		}
	}
	if (op.position?.x !== undefined)
		record["transform.positionX"] = op.position.x;
	if (op.position?.y !== undefined)
		record["transform.positionY"] = op.position.y;
	return record;
}

function textName({ text }: { text: string }): string {
	const firstLine = text.split("\n")[0]?.trim() ?? "";
	return firstLine.length > 40
		? `${firstLine.slice(0, 37)}...`
		: firstLine || "Text";
}

export function applyAddText({
	ctx,
	op,
}: {
	ctx: PlanContext;
	op: AddTextOp;
}): void {
	const definitions = getBuiltInElementParams({ type: "text" });
	const params = coerceParamRecord({
		ctx,
		params: textStyleToParams({ op }),
		definitions,
		subject: "a text element",
		path: ["style"],
	});
	warnOnEmDash({ ctx, value: op.text, what: "the text" });

	const resolved = { ...DEFAULTS.text.element.params, ...params };
	let content = op.text;
	if (op.maxWidth !== undefined) {
		if (ctx.measureText) {
			const measure = ctx.measureText;
			const font = buildMeasureFont({
				fontFamily: String(resolved.fontFamily),
				fontSize: Number(resolved.fontSize),
				fontWeight: resolved.fontWeight === "bold" ? "bold" : "normal",
				fontStyle: resolved.fontStyle === "italic" ? "italic" : "normal",
				canvasHeight: ctx.state.settings.canvasSize.height,
			});
			const letterSpacingPx = Number(resolved.letterSpacing) || 0;
			content = wrapText({
				text: op.text,
				maxWidthPx: op.maxWidth * ctx.state.settings.canvasSize.width,
				measure: (line) => measure({ text: line, font, letterSpacingPx }),
			});
		} else {
			warn({ ctx, message: "maxWidth ignored: text cannot be measured here." });
		}
	}

	const { startTime, duration } = {
		startTime: toTicks({ ctx, seconds: op.start }),
		duration: toDurationTicks({ ctx, seconds: op.duration }),
	};
	const create = buildTextElement({
		raw: {
			name: textName({ text: op.text }),
			duration,
			params: { ...params, content },
		},
		startTime,
	});
	const element = withId({ element: create, id: ctx.generateId() });
	const placed = placeElement({
		ctx,
		element,
		target: op.track,
		path: ["track"],
	});
	recordCreated({
		ctx,
		kind: "element",
		id: placed.element.id,
		trackId: placed.trackId,
		as: op.as,
	});
}

// ---------------------------------------------------------------------------
// add_graphic
// ---------------------------------------------------------------------------

export function applyAddGraphic({
	ctx,
	op,
}: {
	ctx: PlanContext;
	op: AddGraphicOp;
}): void {
	const definition = getGraphicDefinition({ definitionId: op.shape });
	const record: ParamRecord = { ...(op.params ?? {}) };
	if (op.size) {
		const { width, height } = ctx.state.settings.canvasSize;
		const shortEdge = Math.min(width, height);
		record["transform.scaleX"] = op.size.width / shortEdge;
		record["transform.scaleY"] = op.size.height / shortEdge;
	}
	const params = coerceParamRecord({
		ctx,
		params: record,
		definitions: [
			...getBuiltInElementParams({ type: "graphic" }),
			...definition.params,
		],
		subject: `a ${op.shape} graphic`,
		path: ["params"],
	});
	const base = buildGraphicElement({
		definitionId: op.shape,
		startTime: toTicks({ ctx, seconds: op.start }),
		params,
	});
	const element = withId({
		element: {
			...base,
			duration: toDurationTicks({ ctx, seconds: op.duration }),
		},
		id: ctx.generateId(),
	});
	const placed = placeElement({
		ctx,
		element,
		target: op.track,
		path: ["track"],
	});
	recordCreated({
		ctx,
		kind: "element",
		id: placed.element.id,
		trackId: placed.trackId,
		as: op.as,
	});
}

// ---------------------------------------------------------------------------
// add_effect_layer
// ---------------------------------------------------------------------------

export function applyAddEffectLayer({
	ctx,
	op,
}: {
	ctx: PlanContext;
	op: AddEffectLayerOp;
}): void {
	registerDefaultEffects();
	const definition = effectsRegistry.get(op.effect);
	const base = buildEffectElement({
		effectType: op.effect,
		startTime: toTicks({ ctx, seconds: op.start }),
		duration: toDurationTicks({ ctx, seconds: op.duration }),
	});
	const params =
		op.intensity === undefined
			? {}
			: coerceParamRecord({
					ctx,
					params: { intensity: op.intensity },
					definitions: definition.params,
					subject: `a ${op.effect} effect`,
					path: ["intensity"],
				});
	const element = withId({
		element: { ...base, params: { ...base.params, ...params } },
		id: ctx.generateId(),
	});
	const placed = placeElement({
		ctx,
		element,
		target: op.track,
		path: ["track"],
	});
	recordCreated({
		ctx,
		kind: "element",
		id: placed.element.id,
		trackId: placed.trackId,
		as: op.as,
	});
}
