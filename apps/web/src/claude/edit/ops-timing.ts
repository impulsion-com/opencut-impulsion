import {
	TOOL_DEFAULTS,
	type DeleteOp,
	type DuplicateOp,
	type MoveOp,
	type RemoveRangeOp,
	type SetSpeedOp,
	type SplitOp,
	type TrimOp,
} from "@opencut/claude-tools";
import { cloneAnimations } from "@/animation";
import { buildConstantRetime } from "@/retime";
import { removeTimeRanges, splitElementAt } from "@/ripple/remove-ranges";
import { calculateTotalDuration } from "@/timeline";
import {
	canElementGoOnTrack,
	enforceMainTrackStart,
	getHighestInsertIndexForTrack,
	resolveTrackPlacement,
} from "@/timeline/placement";
import { getTrackTypeForElementType } from "@/timeline/placement/compatibility";
import { canPlaceTimeSpansOnTrack } from "@/timeline/placement/overlap";
import type {
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "@/timeline/types";
import { applyElementUpdate } from "@/timeline/update-pipeline";
import {
	frameTicks,
	getOrderedTracks,
	ticksToSeconds,
	type ResolvedElement,
} from "@/claude/units";
import {
	addMediaTime,
	type MediaTime,
	roundMediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import {
	planFps,
	resolveElementRef,
	resolveTrackRef,
	toTicks,
} from "./plan-refs";
import {
	addElementsToTrack,
	findTrack,
	insertEmptyTrack,
	planError,
	recordCreated,
	removeElements,
	replaceElement,
	updateTrackElements,
	warn,
	type PlanContext,
} from "./plan-state";

// Ops that change when elements play: split, trim, move, delete, remove_range, set_speed, duplicate.

function seconds({ ticks }: { ticks: number }): string {
	return `${ticksToSeconds({ ticks })} s`;
}

function describeSpan({ element }: { element: TimelineElement }): string {
	return `${ticksToSeconds({ ticks: element.startTime })}-${ticksToSeconds({ ticks: element.startTime + element.duration })} s`;
}

function findOverlap({
	track,
	startTime,
	duration,
	excludeElementId,
}: {
	track: TimelineTrack;
	startTime: MediaTime;
	duration: MediaTime;
	excludeElementId?: string;
}): TimelineElement | null {
	if (
		canPlaceTimeSpansOnTrack({
			track,
			timeSpans: [{ startTime, duration, excludeElementId }],
		})
	) {
		return null;
	}
	const elements: readonly TimelineElement[] = track.elements;
	return (
		elements.find(
			(other) =>
				other.id !== excludeElementId &&
				startTime < other.startTime + other.duration &&
				startTime + duration > other.startTime,
		) ?? null
	);
}

function uniqueRefs({
	values,
}: {
	values: readonly string[];
}): { value: string; index: number }[] {
	const seen = new Set<string>();
	const result: { value: string; index: number }[] = [];
	values.forEach((value, index) => {
		if (seen.has(value)) return;
		seen.add(value);
		result.push({ value, index });
	});
	return result;
}

// ---------------------------------------------------------------------------
// split
// ---------------------------------------------------------------------------

export function applySplit({
	ctx,
	op,
}: {
	ctx: PlanContext;
	op: SplitOp;
}): void {
	const at = toTicks({ ctx, seconds: op.at });
	const keep = op.keep ?? TOOL_DEFAULTS.splitKeep;
	const targets: (ResolvedElement & { index: number })[] = [];
	for (const { value, index } of uniqueRefs({ values: op.elementIds })) {
		const resolved = resolveElementRef({
			ctx,
			value,
			path: ["elementIds", index],
		});
		// "@name" and the raw id of the same element count once.
		if (targets.some((target) => target.element.id === resolved.element.id))
			continue;
		targets.push({ ...resolved, index });
	}
	for (const { element, index } of targets) {
		if (at <= element.startTime || at >= element.startTime + element.duration) {
			throw planError({
				ctx,
				message: `the cut at ${seconds({ ticks: at })} is not strictly inside element ${element.id} (${describeSpan({ element })}).`,
				path: ["elementIds", index],
			});
		}
	}

	for (const { track, element } of targets) {
		const rightId = ctx.generateId();
		const { left, right } = splitElementAt({ element, splitTime: at, rightId });
		// Same names as SplitElementsCommand.
		const leftPiece = { ...left, name: `${element.name} (left)` };
		const rightPiece = { ...right, name: `${element.name} (right)` };
		const pieces =
			keep === "left"
				? [leftPiece]
				: keep === "right"
					? [rightPiece]
					: [leftPiece, rightPiece];
		ctx.state = {
			...ctx.state,
			tracks: updateTrackElements({
				tracks: ctx.state.tracks,
				trackId: track.id,
				update: (elements) =>
					elements.flatMap((candidate) =>
						candidate.id === element.id ? pieces : [candidate],
					),
			}),
		};
		if (keep !== "left") {
			recordCreated({
				ctx,
				kind: "element",
				id: rightId,
				trackId: track.id,
				as: op.as,
			});
		}
	}
}

// ---------------------------------------------------------------------------
// trim
// ---------------------------------------------------------------------------

function hasSourceLimit({ element }: { element: TimelineElement }): boolean {
	return (
		(element.type === "video" || element.type === "audio") &&
		element.sourceDuration != null
	);
}

function rateOf({ element }: { element: TimelineElement }): number {
	return element.type === "video" || element.type === "audio"
		? (element.retime?.rate ?? 1)
		: 1;
}

function sourceDeltaFor({
	clipDelta,
	rate,
}: {
	clipDelta: number;
	rate: number;
}): MediaTime {
	const magnitude = roundMediaTime({ time: Math.abs(clipDelta) * rate });
	return clipDelta < 0 ? roundMediaTime({ time: -magnitude }) : magnitude;
}

export function applyTrim({ ctx, op }: { ctx: PlanContext; op: TrimOp }): void {
	const { track, element } = resolveElementRef({
		ctx,
		value: op.elementId,
		path: ["elementId"],
	});
	const fps = planFps({ ctx });
	const frame = frameTicks({ fps });
	const start = element.startTime;
	const end = addMediaTime({ a: start, b: element.duration });
	let newStart =
		op.start !== undefined ? toTicks({ ctx, seconds: op.start }) : start;
	let newEnd = op.end !== undefined ? toTicks({ ctx, seconds: op.end }) : end;
	const rate = rateOf({ element });
	const limited = hasSourceLimit({ element });

	let trimStart = addMediaTime({
		a: element.trimStart,
		b: sourceDeltaFor({ clipDelta: newStart - start, rate }),
	});
	if (trimStart < 0) {
		if (!limited) {
			trimStart = ZERO_MEDIA_TIME;
		} else {
			const earliest = subMediaTime({
				a: start,
				b: roundMediaTime({ time: element.trimStart / rate }),
			});
			if (earliest - newStart > frame) {
				throw planError({
					ctx,
					message: `element ${element.id} cannot start before ${seconds({ ticks: earliest })}: its source media begins there.`,
					path: ["start"],
				});
			}
			newStart = earliest;
			trimStart = ZERO_MEDIA_TIME;
		}
	}

	let trimEnd = subMediaTime({
		a: element.trimEnd,
		b: sourceDeltaFor({ clipDelta: newEnd - end, rate }),
	});
	if (trimEnd < 0) {
		if (!limited) {
			trimEnd = ZERO_MEDIA_TIME;
		} else {
			const latest = addMediaTime({
				a: end,
				b: roundMediaTime({ time: element.trimEnd / rate }),
			});
			if (newEnd - latest > frame) {
				throw planError({
					ctx,
					message: `element ${element.id} cannot end after ${seconds({ ticks: latest })}: its source media ends there.`,
					path: ["end"],
				});
			}
			newEnd = latest;
			trimEnd = ZERO_MEDIA_TIME;
		}
	}

	const duration = subMediaTime({ a: newEnd, b: newStart });
	if (duration < frame) {
		throw planError({
			ctx,
			message: `element ${element.id} would be shorter than one frame (${seconds({ ticks: newStart })} to ${seconds({ ticks: newEnd })}).`,
		});
	}
	const clash = findOverlap({
		track,
		startTime: newStart,
		duration,
		excludeElementId: element.id,
	});
	if (clash) {
		throw planError({
			ctx,
			message: `the trimmed element would overlap element ${clash.id} (${describeSpan({ element: clash })}) on its track.`,
		});
	}

	const next = applyElementUpdate({
		element,
		patch: { startTime: newStart, duration, trimStart, trimEnd },
		context: { tracks: ctx.state.tracks, trackId: track.id },
	});
	if (next.startTime !== newStart) {
		warn({
			ctx,
			message: `element ${element.id} was moved to start at ${seconds({ ticks: next.startTime })}: the first clip of the main track always starts at 0 s (it now ends at ${seconds({ ticks: next.startTime + next.duration })}).`,
		});
	}
	ctx.state = {
		...ctx.state,
		tracks: replaceElement({ tracks: ctx.state.tracks, element: next }),
	};
}

// ---------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------

export function applyMove({ ctx, op }: { ctx: PlanContext; op: MoveOp }): void {
	const { track: source, element } = resolveElementRef({
		ctx,
		value: op.elementId,
		path: ["elementId"],
	});
	const requestedStart =
		op.start !== undefined
			? toTicks({ ctx, seconds: op.start })
			: element.startTime;
	const without = removeElements({
		tracks: ctx.state.tracks,
		elementIds: new Set([element.id]),
	});
	const trackType = getTrackTypeForElementType({ elementType: element.type });
	const span = { startTime: requestedStart, duration: element.duration };

	let tracks: SceneTracks = without;
	let targetTrackId: string;
	const target = op.track;
	if (target === "overlay") {
		targetTrackId = ctx.generateId();
		tracks = insertEmptyTrack({
			tracks,
			type: trackType,
			displayIndex: getHighestInsertIndexForTrack({ tracks, trackType }),
			id: targetTrackId,
		});
	} else if (target === "audio" || target === "auto") {
		if (target === "audio" && element.type !== "audio") {
			throw planError({
				ctx,
				message: `track "audio" only takes audio, not a ${element.type} element.`,
				path: ["track"],
			});
		}
		const placement = resolveTrackPlacement({
			tracks,
			...(target === "audio"
				? { trackType: "audio" }
				: { elementType: element.type }),
			timeSpans: [span],
			strategy: { type: "firstAvailable" },
		});
		if (!placement) {
			throw planError({
				ctx,
				message: "no track can take the element.",
				path: ["track"],
			});
		}
		if (placement.kind === "newTrack") {
			targetTrackId = ctx.generateId();
			tracks = insertEmptyTrack({
				tracks,
				type: placement.trackType,
				displayIndex: placement.insertIndex,
				id: targetTrackId,
			});
		} else {
			targetTrackId = placement.trackId;
		}
	} else if (target === undefined) {
		targetTrackId = source.id;
	} else {
		const track = resolveTrackRef({ ctx, value: target, path: ["track"] });
		if (
			!canElementGoOnTrack({ elementType: element.type, trackType: track.type })
		) {
			throw planError({
				ctx,
				message: `a ${element.type} element cannot go on track ${track.id} (a ${track.type} track${track.id === tracks.main.id ? ", the main track" : ""}).`,
				path: ["track"],
			});
		}
		targetTrackId = track.id;
	}

	const startTime = enforceMainTrackStart({
		tracks,
		targetTrackId,
		requestedStartTime: requestedStart,
	});
	if (startTime !== requestedStart) {
		warn({
			ctx,
			message: `start moved from ${seconds({ ticks: requestedStart })} to ${seconds({ ticks: startTime })}: the first clip of the main track always starts at 0 s.`,
		});
	}
	const targetTrack = findTrack({ tracks, trackId: targetTrackId });
	if (!targetTrack) {
		throw planError({
			ctx,
			code: "NOT_FOUND",
			message: `track ${targetTrackId} does not exist.`,
		});
	}
	const clash = findOverlap({
		track: targetTrack,
		startTime,
		duration: element.duration,
	});
	if (clash) {
		throw planError({
			ctx,
			message: `element ${element.id} would overlap element ${clash.id} (${describeSpan({ element: clash })}) on track ${targetTrackId}. Move or trim that one first (earlier op), or use track "overlay".`,
		});
	}
	ctx.state = {
		...ctx.state,
		tracks: addElementsToTrack({
			tracks,
			trackId: targetTrackId,
			elements: [{ ...element, startTime }],
		}),
	};
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

export function applyDelete({
	ctx,
	op,
}: {
	ctx: PlanContext;
	op: DeleteOp;
}): void {
	const ids = new Set(
		uniqueRefs({ values: op.elementIds }).map(
			({ value, index }) =>
				resolveElementRef({ ctx, value, path: ["elementIds", index] }).element
					.id,
		),
	);
	ctx.state = {
		...ctx.state,
		tracks: removeElements({ tracks: ctx.state.tracks, elementIds: ids }),
	};
}

// ---------------------------------------------------------------------------
// remove_range
// ---------------------------------------------------------------------------

export function applyRemoveRange({
	ctx,
	op,
}: {
	ctx: PlanContext;
	op: RemoveRangeOp;
}): void {
	const start = toTicks({ ctx, seconds: op.start });
	const end = toTicks({ ctx, seconds: op.end });
	if (end <= start) {
		throw planError({
			ctx,
			message: `the range ${op.start}-${op.end} s is shorter than one frame once snapped to the frame grid.`,
			path: ["end"],
		});
	}
	const selected = op.tracks
		? new Set(
				op.tracks.map(
					(value, index) =>
						resolveTrackRef({ ctx, value, path: ["tracks", index] }).id,
				),
			)
		: null;
	const total = calculateTotalDuration({ tracks: ctx.state.tracks });
	if (start >= total) {
		warn({
			ctx,
			message: `the range starts at or after the end of the timeline (${seconds({ ticks: total })}): nothing to cut.`,
		});
	} else if (end > total) {
		warn({
			ctx,
			message: `the range runs past the end of the timeline (${seconds({ ticks: total })}).`,
		});
	}

	const result = removeTimeRanges({
		tracks: ctx.state.tracks,
		ranges: [{ start, end }],
		trackFilter: selected ? (track) => selected.has(track.id) : undefined,
		bookmarks: ctx.state.bookmarks,
		fps: planFps({ ctx }),
		generateId: ctx.generateId,
	});
	ctx.state = {
		...ctx.state,
		tracks: result.tracks,
		bookmarks: result.bookmarks,
	};
	for (const piece of result.createdElements) {
		recordCreated({
			ctx,
			kind: "element",
			id: piece.elementId,
			trackId: piece.trackId,
		});
	}
	if (result.createdElements.length > 0) {
		warn({
			ctx,
			message: `${result.createdElements.length} element(s) spanning the range were cut in two; the part after the range got a new id: ${result.createdElements.map((piece) => `${piece.sourceElementId} -> ${piece.elementId}`).join(", ")}.`,
		});
	}
	if (result.mainStartAdjustment > 0) {
		warn({
			ctx,
			message: `the first main clip was moved ${seconds({ ticks: result.mainStartAdjustment })} earlier to keep the main track starting at 0 s.`,
		});
	}
}

// ---------------------------------------------------------------------------
// set_speed
// ---------------------------------------------------------------------------

export function applySetSpeed({
	ctx,
	op,
}: {
	ctx: PlanContext;
	op: SetSpeedOp;
}): void {
	const { track, element } = resolveElementRef({
		ctx,
		value: op.elementId,
		path: ["elementId"],
	});
	if (element.type !== "video" && element.type !== "audio") {
		throw planError({
			ctx,
			message: `speed applies to video and audio only, not to a ${element.type} element.`,
			path: ["elementId"],
		});
	}
	const next = applyElementUpdate({
		element,
		patch: {
			retime: buildConstantRetime({
				rate: op.rate,
				maintainPitch: op.maintainPitch ?? TOOL_DEFAULTS.speedMaintainPitch,
			}),
		},
		context: { tracks: ctx.state.tracks, trackId: track.id },
	});
	const clash = findOverlap({
		track,
		startTime: next.startTime,
		duration: next.duration,
		excludeElementId: element.id,
	});
	if (clash) {
		throw planError({
			ctx,
			message: `at ${op.rate}x the clip would last until ${seconds({ ticks: next.startTime + next.duration })} and overlap element ${clash.id} (${describeSpan({ element: clash })}). Move that one first (earlier op).`,
		});
	}
	ctx.state = {
		...ctx.state,
		tracks: replaceElement({ tracks: ctx.state.tracks, element: next }),
	};
}

// ---------------------------------------------------------------------------
// duplicate
// ---------------------------------------------------------------------------

export function applyDuplicate({
	ctx,
	op,
}: {
	ctx: PlanContext;
	op: DuplicateOp;
}): void {
	const sources = uniqueRefs({ values: op.elementIds }).map(
		({ value, index }) =>
			resolveElementRef({ ctx, value, path: ["elementIds", index] }),
	);
	const idsByTrack = new Map<string, Set<string>>();
	for (const { track, element } of sources) {
		const ids = idsByTrack.get(track.id) ?? new Set<string>();
		ids.add(element.id);
		idsByTrack.set(track.id, ids);
	}

	// Same as DuplicateElementsCommand: one NEW track per source track, copies at the same times.
	for (const track of getOrderedTracks(ctx.state.tracks)) {
		const ids = idsByTrack.get(track.id);
		if (!ids) continue;
		const elements: readonly TimelineElement[] = track.elements;
		const copies: TimelineElement[] = elements
			.filter((element) => ids.has(element.id))
			.map((element) => ({
				...element,
				id: ctx.generateId(),
				name: `${element.name} (copy)`,
				animations: cloneAnimations({
					animations: element.animations,
					shouldRegenerateKeyframeIds: true,
				}),
			}));
		const placement = resolveTrackPlacement({
			tracks: ctx.state.tracks,
			trackType: track.type,
			timeSpans: [],
			strategy: { type: "alwaysNew", position: "highest" },
		});
		if (!placement || placement.kind !== "newTrack") {
			throw planError({
				ctx,
				message: `no new track could be made for the copies of track ${track.id}.`,
			});
		}
		const trackId = ctx.generateId();
		const withTrack = insertEmptyTrack({
			tracks: ctx.state.tracks,
			type: track.type,
			displayIndex: placement.insertIndex,
			id: trackId,
		});
		ctx.state = {
			...ctx.state,
			tracks: addElementsToTrack({
				tracks: withTrack,
				trackId,
				elements: copies,
			}),
		};
		for (const copy of copies) {
			recordCreated({ ctx, kind: "element", id: copy.id, trackId, as: op.as });
		}
	}
}
