import type { ToolResult } from "@opencut/claude-tools";
import { DeleteElementsCommand } from "@/commands/timeline";
import { RemoveMediaAssetCommand } from "@/commands/media";
import type { Command } from "@/commands";
import type { ElementRef, SceneTracks } from "@/timeline/types";
import { flushSave, runAiEdit } from "@/claude/edit/ai-edit";
import { BridgeError, jsonResult } from "@/claude/types";
import { getOrderedTracks } from "@/claude/units";
import {
	requireReadyProject,
	type HandlerArgs,
} from "@/claude/state/handler-kit";
import { summarizeMedia } from "@/claude/state/serialize";

// list_media and remove_media (map 9.1, 9.5).

export async function listMedia({
	ctx,
}: HandlerArgs<"list_media">): Promise<ToolResult> {
	const { editor } = ctx;
	requireReadyProject(editor);
	// `path` is added by the sidecar from its import index (the tab never knows disk paths).
	return jsonResult(
		editor.media.getAssets().map((asset) => ({
			...summarizeMedia(asset),
			size: asset.file.size,
		})),
	);
}

function elementsUsingMedia({
	tracks,
	mediaIds,
}: {
	tracks: SceneTracks;
	mediaIds: ReadonlySet<string>;
}): ElementRef[] {
	const refs: ElementRef[] = [];
	for (const track of getOrderedTracks(tracks)) {
		for (const element of track.elements) {
			if ("mediaId" in element && mediaIds.has(element.mediaId)) {
				refs.push({ trackId: track.id, elementId: element.id });
			}
		}
	}
	return refs;
}

export async function removeMedia({
	input,
	ctx,
}: HandlerArgs<"remove_media">): Promise<ToolResult> {
	const { editor } = ctx;
	const { project, scene } = requireReadyProject(editor);
	const assetIds = new Set(editor.media.getAssets().map((asset) => asset.id));
	const mediaIds = [...new Set(input.mediaIds)];
	const unknown = mediaIds.filter((id) => !assetIds.has(id));
	if (unknown.length > 0) {
		throw new BridgeError({
			code: "NOT_FOUND",
			message: `Unknown media id(s): ${unknown.join(", ")}. Nothing was removed. Use list_media for the current ids.`,
			details: { unknownIds: unknown },
		});
	}
	const wanted = new Set(mediaIds);

	let deleted: ElementRef[] = [];
	runAiEdit({
		editor,
		label: "Retirer des médias",
		build: (tracks) => {
			deleted = elementsUsingMedia({ tracks, mediaIds: wanted });
			// Deleting the elements first, in the same batch, keeps RemoveMediaAssetCommand from pushing its own
			// nested history entry (timeline.deleteElements): the whole removal is one undo step.
			const commands: Command[] =
				deleted.length > 0
					? [new DeleteElementsCommand({ elements: deleted })]
					: [];
			for (const assetId of mediaIds) {
				commands.push(
					new RemoveMediaAssetCommand({
						projectId: project.metadata.id,
						assetId,
					}),
				);
			}
			return commands;
		},
	});
	// Read before the save: a user edit made while it runs must still fail the next expectStateVersion.
	const stateVersion = ctx.getStateVersion();
	await flushSave(editor);

	// RemoveMediaAssetCommand only cleans the active scene; other scenes keep elements that now render nothing.
	const elsewhere = editor.scenes
		.getScenes()
		.filter((other) => other.id !== scene.id)
		.map((other) => ({
			sceneId: other.id,
			name: other.name,
			elementIds: elementsUsingMedia({
				tracks: other.tracks,
				mediaIds: wanted,
			}).map((ref) => ref.elementId),
		}))
		.filter((entry) => entry.elementIds.length > 0);

	return jsonResult({
		removed: mediaIds,
		deletedElementIds: deleted.map((ref) => ref.elementId),
		...(elsewhere.length > 0
			? {
					warnings: [
						"Elements in other scenes still use the removed media and now render nothing; switch_scene and delete them.",
					],
					orphanedInOtherScenes: elsewhere,
				}
			: {}),
		stateVersion,
	});
}
