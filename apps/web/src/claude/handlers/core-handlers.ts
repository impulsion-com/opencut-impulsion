import type { TabHandlerMap } from "@/claude/types";
import { exportCancel, exportStart } from "@/claude/export/export-handlers";
import { importFiles } from "@/claude/media/import-files";
import { listMedia, removeMedia } from "@/claude/media/media-handlers";
import {
	createProject,
	listProjects,
	openProject,
	saveProject,
	switchScene,
} from "@/claude/project/project-handlers";
import { toTabHandler } from "@/claude/state/handler-kit";
import {
	pause,
	play,
	seek,
	select,
	setEditorModes,
} from "@/claude/state/playback-handlers";
import {
	getEditorState,
	getElement,
	listCapabilities,
} from "@/claude/state/read-handlers";
import {
	captureContactSheet,
	captureFrame,
} from "@/claude/vision/capture-handlers";
import { peekMedia } from "@/claude/vision/peek-media";

// Core tab tools (agent E1): read, vision, playback/UI, project and media lifecycle, plus the tab halves of
// import_media and start_export/cancel_job. Editing tools live in edit/edit-handlers.ts (E2); internal.ping in
// handlers/internal-handlers.ts (S). handlers/index.ts registers this map.

export const coreHandlers: TabHandlerMap = {
	// Read (map 9.1)
	get_editor_state: toTabHandler(getEditorState),
	get_element: toTabHandler(getElement),
	list_capabilities: toTabHandler(listCapabilities),
	list_media: toTabHandler(listMedia),
	list_projects: toTabHandler(listProjects),
	// Vision (map 9.2)
	capture_frame: toTabHandler(captureFrame),
	capture_contact_sheet: toTabHandler(captureContactSheet),
	peek_media: toTabHandler(peekMedia),
	// Playback and UI (map 9.4)
	seek: toTabHandler(seek),
	play: toTabHandler(play),
	pause: toTabHandler(pause),
	select: toTabHandler(select),
	set_editor_modes: toTabHandler(setEditorModes),
	// Project and media lifecycle (map 9.5)
	create_project: toTabHandler(createProject),
	open_project: toTabHandler(openProject),
	switch_scene: toTabHandler(switchScene),
	save_project: toTabHandler(saveProject),
	remove_media: toTabHandler(removeMedia),
	"internal.import_files": toTabHandler(importFiles),
	// Output (map 9.6)
	"internal.export_start": toTabHandler(exportStart),
	"internal.export_cancel": toTabHandler(exportCancel),
};
