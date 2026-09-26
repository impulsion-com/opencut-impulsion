import type { EditOp, EditPlanCreated } from "@opencut/claude-tools";
import type { MediaAsset } from "@/media/types";
import { calculateTotalDuration } from "@/timeline";
import type { SceneTracks, TimelineElement } from "@/timeline/types";
import { getOrderedTracks } from "@/claude/units";
import { generateUUID } from "@/utils/id";
import type { MediaTime } from "@/wasm";
import {
	applyAddEffectLayer,
	applyAddGraphic,
	applyAddText,
	applyInsertMedia,
} from "./ops-insert";
import {
	applyBookmark,
	applyNewTrack,
	applyProjectSettings,
} from "./ops-project";
import {
	applyClipEffect,
	applyKeyframe,
	applyMask,
	applySourceAudio,
	applyToggleTrack,
	applyUpdateElement,
} from "./ops-props";
import {
	applyDelete,
	applyDuplicate,
	applyMove,
	applyRemoveRange,
	applySetSpeed,
	applySplit,
	applyTrim,
} from "./ops-timing";
import {
	findElement,
	findTrack,
	pruneEmptyTracks,
	type PlanContext,
	type PlanSettingsStep,
	type PlanState,
} from "./plan-state";
import type { TextMeasurer } from "./text-layout";

// Resolves an apply_edit_plan op list against a working copy of the active scene, op by op. Pure: nothing touches
// the editor, so the same function serves dry runs and real runs (the real run then applies the result as one
// history entry, see plan-commands.ts). "@name" references resolve to the ids earlier ops produced, including the
// new right-hand pieces of splits and the copies of duplicates.

export interface ResolveEditPlanInput {
	ops: readonly EditOp[];
	state: PlanState;
	mediaAssets: readonly MediaAsset[];
	/** New ids (elements, tracks, effects). Defaults to UUIDs. */
	generateId?: () => string;
	measureText?: TextMeasurer | null;
}

export interface ResolvedEditPlan {
	/** State after every op, with empty overlay/audio tracks pruned like the editor's reactor does. */
	state: PlanState;
	created: EditPlanCreated[];
	refs: Record<string, string>;
	warnings: string[];
	settingsSteps: PlanSettingsStep[];
	changedElementIds: string[];
	deletedElementIds: string[];
	tracksChanged: boolean;
	bookmarksChanged: boolean;
	durationTicks: MediaTime;
}

function applyOp({ ctx, op }: { ctx: PlanContext; op: EditOp }): void {
	switch (op.op) {
		case "insert_media":
			return applyInsertMedia({ ctx, op });
		case "add_text":
			return applyAddText({ ctx, op });
		case "add_graphic":
			return applyAddGraphic({ ctx, op });
		case "add_effect_layer":
			return applyAddEffectLayer({ ctx, op });
		case "split":
			return applySplit({ ctx, op });
		case "trim":
			return applyTrim({ ctx, op });
		case "move":
			return applyMove({ ctx, op });
		case "delete":
			return applyDelete({ ctx, op });
		case "remove_range":
			return applyRemoveRange({ ctx, op });
		case "duplicate":
			return applyDuplicate({ ctx, op });
		case "update_element":
			return applyUpdateElement({ ctx, op });
		case "set_speed":
			return applySetSpeed({ ctx, op });
		case "keyframe":
			return applyKeyframe({ ctx, op });
		case "clip_effect":
			return applyClipEffect({ ctx, op });
		case "mask":
			return applyMask({ ctx, op });
		case "new_track":
			return applyNewTrack({ ctx, op });
		case "toggle_track":
			return applyToggleTrack({ ctx, op });
		case "source_audio":
			return applySourceAudio({ ctx, op });
		case "bookmark":
			return applyBookmark({ ctx, op });
		case "project_settings":
			return applyProjectSettings({ ctx, op });
	}
}

function sameItems<T>({ a, b }: { a: readonly T[]; b: readonly T[] }): boolean {
	return (
		a === b ||
		(a.length === b.length && a.every((item, index) => item === b[index]))
	);
}

function sameTracks({ a, b }: { a: SceneTracks; b: SceneTracks }): boolean {
	return (
		a === b ||
		(a.main === b.main &&
			sameItems({ a: a.overlay, b: b.overlay }) &&
			sameItems({ a: a.audio, b: b.audio }))
	);
}

function indexElements({
	state,
}: {
	state: PlanState;
}): Map<string, { element: TimelineElement; trackId: string }> {
	const index = new Map<
		string,
		{ element: TimelineElement; trackId: string }
	>();
	for (const track of getOrderedTracks(state.tracks)) {
		for (const element of track.elements) {
			index.set(element.id, { element, trackId: track.id });
		}
	}
	return index;
}

/**
 * Walks the ops in order against `state`. Throws a BridgeError (INVALID_EDIT or NOT_FOUND, message prefixed with
 * "op N (name):") on the first op the timeline refuses; nothing is returned then, so nothing can be half-applied.
 * Expects ops already validated by EditPlanSchema (field rules and "@name" references).
 */
export function resolveEditPlan({
	ops,
	state,
	mediaAssets,
	generateId = generateUUID,
	measureText = null,
}: ResolveEditPlanInput): ResolvedEditPlan {
	const ctx: PlanContext = {
		state,
		mediaAssets,
		generateId,
		measureText,
		refs: new Map(),
		created: [],
		warnings: [],
		settingsSteps: [],
		opIndex: 0,
		opName: ops[0]?.op ?? "delete",
	};

	ops.forEach((op, index) => {
		ctx.opIndex = index;
		ctx.opName = op.op;
		applyOp({ ctx, op });
	});

	// The editor's reactor drops empty overlay/audio tracks right after the batch; do it here so the snapshot we
	// apply is exactly what the timeline ends up with (and redo restores the same thing).
	const pruneResult = pruneEmptyTracks({ tracks: ctx.state.tracks });
	const { prunedTrackIds } = pruneResult;
	// Keep the original references when a plan ends where it started (e.g. a new track that stayed empty), so a
	// no-op plan pushes no history entry.
	const tracks = sameTracks({ a: pruneResult.tracks, b: state.tracks })
		? state.tracks
		: pruneResult.tracks;
	const bookmarks = sameItems({ a: ctx.state.bookmarks, b: state.bookmarks })
		? state.bookmarks
		: ctx.state.bookmarks;
	const finalState: PlanState = { ...ctx.state, tracks, bookmarks };
	const pruned = new Set(prunedTrackIds);
	for (const entry of ctx.created) {
		if (entry.kind === "track" && pruned.has(entry.id)) {
			ctx.warnings.push(
				`op ${entry.op} (new_track): the track stayed empty and was removed (place something on it in the same plan).`,
			);
		}
	}

	// Report what exists at the end: later ops may have deleted or moved what earlier ops created.
	const created: EditPlanCreated[] = [];
	for (const entry of ctx.created) {
		if (entry.kind === "track") {
			if (findTrack({ tracks, trackId: entry.id })) created.push(entry);
			continue;
		}
		if (entry.kind === "element") {
			const found = findElement({ tracks, elementId: entry.id });
			if (found) created.push({ ...entry, trackId: found.track.id });
			continue;
		}
		const holder = entry.elementId
			? findElement({ tracks, elementId: entry.elementId })
			: null;
		const effects =
			holder && "effects" in holder.element
				? (holder.element.effects ?? [])
				: [];
		if (holder && effects.some((effect) => effect.id === entry.id)) {
			created.push({ ...entry, trackId: holder.track.id });
		}
	}
	const refs: Record<string, string> = {};
	for (const entry of created) {
		if (entry.as !== undefined) refs[entry.as] = entry.id;
	}

	const before = indexElements({ state });
	const after = indexElements({ state: finalState });
	const changedElementIds: string[] = [];
	const deletedElementIds: string[] = [];
	for (const [id, previous] of before) {
		const next = after.get(id);
		if (!next) deletedElementIds.push(id);
		else if (
			next.element !== previous.element ||
			next.trackId !== previous.trackId
		)
			changedElementIds.push(id);
	}

	return {
		state: finalState,
		created,
		refs,
		warnings: ctx.warnings,
		settingsSteps: ctx.settingsSteps,
		changedElementIds,
		deletedElementIds,
		tracksChanged: finalState.tracks !== state.tracks,
		bookmarksChanged: finalState.bookmarks !== state.bookmarks,
		durationTicks: calculateTotalDuration({ tracks }),
	};
}

/** Font families a plan uses, to load before resolving (text measurement) and before rendering. */
export function collectPlanFontFamilies({
	ops,
}: {
	ops: readonly EditOp[];
}): string[] {
	const families = new Set<string>();
	for (const op of ops) {
		if (op.op === "add_text" && op.style?.fontFamily)
			families.add(op.style.fontFamily);
		if (
			(op.op === "update_element" || op.op === "mask") &&
			typeof op.params?.fontFamily === "string"
		) {
			families.add(op.params.fontFamily);
		}
	}
	return [...families];
}
