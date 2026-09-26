import type { ToolResult } from "@opencut/claude-tools";
import { useTimelineStore } from "@/timeline/timeline-store";
import type { ElementRef } from "@/timeline/types";
import { BridgeError, jsonResult } from "@/claude/types";
import {
	findElementInTracks,
	getProjectFps,
	secondsToTicks,
	ticksToSeconds,
} from "@/claude/units";
import { requireReadyProject, type HandlerArgs } from "./handler-kit";

// seek, play, pause, select, set_editor_modes (map 9.4). UI state only: no history entry, no stateVersion bump.

function playbackState({ ctx }: Pick<HandlerArgs<"play">, "ctx">) {
	return {
		isPlaying: ctx.editor.playback.getIsPlaying(),
		playhead: ticksToSeconds({ ticks: ctx.editor.playback.getCurrentTime() }),
	};
}

export async function seek({
	input,
	ctx,
}: HandlerArgs<"seek">): Promise<ToolResult> {
	const { editor } = ctx;
	requireReadyProject(editor);
	// Snapped to the frame grid; PlaybackManager clamps it to the timeline.
	editor.playback.seek({
		time: secondsToTicks({ seconds: input.time, fps: getProjectFps(editor) }),
	});
	return jsonResult({
		playhead: ticksToSeconds({ ticks: editor.playback.getCurrentTime() }),
	});
}

export async function play({ ctx }: HandlerArgs<"play">): Promise<ToolResult> {
	requireReadyProject(ctx.editor);
	// No-op on an empty timeline (PlaybackManager refuses), reported as isPlaying false.
	ctx.editor.playback.play();
	return jsonResult(playbackState({ ctx }));
}

export async function pause({
	ctx,
}: HandlerArgs<"pause">): Promise<ToolResult> {
	requireReadyProject(ctx.editor);
	ctx.editor.playback.pause();
	return jsonResult(playbackState({ ctx }));
}

export async function select({
	input,
	ctx,
}: HandlerArgs<"select">): Promise<ToolResult> {
	const { editor } = ctx;
	const { scene } = requireReadyProject(editor);
	const refs: ElementRef[] = [];
	const unknown: string[] = [];
	for (const elementId of new Set(input.elementIds)) {
		const found = findElementInTracks({ tracks: scene.tracks, elementId });
		if (found) refs.push({ trackId: found.track.id, elementId });
		else unknown.push(elementId);
	}
	if (unknown.length > 0) {
		throw new BridgeError({
			code: "NOT_FOUND",
			message: `Unknown element id(s) in the active scene "${scene.name}": ${unknown.join(", ")}. Nothing was selected.`,
			details: { unknownIds: unknown, sceneId: scene.id },
		});
	}
	editor.selection.setSelectedElements({ elements: refs });
	return jsonResult({ selected: refs.map((ref) => ref.elementId) });
}

/** The user's toggles (persisted in the "timeline-store"); works without an open project. */
export async function setEditorModes({
	input,
}: HandlerArgs<"set_editor_modes">): Promise<ToolResult> {
	const store = useTimelineStore.getState();
	if (
		input.ripple !== undefined &&
		input.ripple !== store.rippleEditingEnabled
	) {
		// EditorRuntimeBindings copies the store value into CommandManager.isRippleEnabled.
		store.toggleRippleEditing();
	}
	if (
		input.snapping !== undefined &&
		input.snapping !== store.snappingEnabled
	) {
		store.toggleSnapping();
	}
	const next = useTimelineStore.getState();
	return jsonResult({
		ripple: next.rippleEditingEnabled,
		snapping: next.snappingEnabled,
	});
}
