import { TOOL_DEFAULTS, type ToolResult } from "@opencut/claude-tools";
import { useTimelineStore } from "@/timeline/timeline-store";
import { jsonResult } from "@/claude/types";
import { resolveElement } from "@/claude/units";
import { buildCapabilities, buildElementParamSchema } from "./capabilities";
import {
	isUserInteracting,
	requireReadyProject,
	type HandlerArgs,
} from "./handler-kit";
import { describeElement, serializeEditorState } from "./serialize";

// get_editor_state, get_element, list_capabilities (map 9.1). Read-only: nothing here changes the editor.

export async function getEditorState({
	input,
	ctx,
}: HandlerArgs<"get_editor_state">): Promise<ToolResult> {
	const { editor } = ctx;
	const { project, scene } = requireReadyProject(editor);
	const timelineModes = useTimelineStore.getState();
	const exportState = editor.project.getExportState();
	return jsonResult(
		serializeEditorState({
			project,
			scenes: editor.scenes.getScenes(),
			activeScene: scene,
			mediaAssets: editor.media.getAssets(),
			playhead: editor.playback.getCurrentTime(),
			isPlaying: editor.playback.getIsPlaying(),
			selection: editor.selection.getSelectedElements(),
			canUndo: editor.command.canUndo(),
			canRedo: editor.command.canRedo(),
			modes: {
				ripple: timelineModes.rippleEditingEnabled,
				snapping: timelineModes.snappingEnabled,
			},
			busy: {
				exporting: exportState.isExporting,
				exportProgress: exportState.progress,
				userDragging: isUserInteracting(editor),
			},
			stateVersion: ctx.getStateVersion(),
			detail: input.detail ?? TOOL_DEFAULTS.editorStateDetail,
		}),
	);
}

export async function getElement({
	input,
	ctx,
}: HandlerArgs<"get_element">): Promise<ToolResult> {
	const { editor } = ctx;
	requireReadyProject(editor);
	const { track, element } = resolveElement({
		editor,
		elementId: input.elementId,
	});
	return jsonResult({
		...describeElement({ track, element }),
		paramSchema: buildElementParamSchema(element),
	});
}

/** Registry data only: answers without an open project too (e.g. from the projects page). */
export async function listCapabilities(
	_args: HandlerArgs<"list_capabilities">,
): Promise<ToolResult> {
	return jsonResult(buildCapabilities());
}
