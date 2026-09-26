import type { ToolResult } from "@opencut/claude-tools";
import type { EditorCore } from "@/core";
import { hasActiveGesture } from "@/editor/cancel-interaction";
import type { TProject } from "@/project/types";
import type { TScene } from "@/timeline/types";
import {
	BridgeError,
	type TabHandler,
	type TabHandlerContext,
	type TabMethod,
	type TabMethodInput,
} from "@/claude/types";

// Shared plumbing for the E1 tab handlers (read, vision, playback, project, media, export): an adapter from the
// codebase's object-param style to the positional TabHandler signature, readiness guards and abort helpers.

/** What an E1 handler receives: the parsed params and the call context. */
export interface HandlerArgs<N extends TabMethod> {
	input: TabMethodInput<N>;
	ctx: TabHandlerContext;
}

export type ObjectTabHandler<N extends TabMethod> = (
	args: HandlerArgs<N>,
) => Promise<ToolResult>;

/** Adapts `({ input, ctx }) => result` to the registry's `(input, ctx) => result`. */
export function toTabHandler<N extends TabMethod>(
	handler: ObjectTabHandler<N>,
): TabHandler<N> {
	// eslint-disable-next-line opencut/prefer-object-params -- TabHandler's positional signature is the skeleton's contract
	return (input, ctx) => handler({ input, ctx });
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export interface ReadyProject {
	project: TProject;
	scene: TScene;
}

/** The open project and its active scene, once fully loaded. Throws NO_PROJECT otherwise. */
export function requireReadyProject(editor: EditorCore): ReadyProject {
	const project = editor.project.getActiveOrNull();
	if (!project) {
		throw new BridgeError({
			code: "NO_PROJECT",
			message: "No project is open in the editor tab.",
		});
	}
	if (editor.project.getIsLoading()) {
		throw new BridgeError({
			code: "NO_PROJECT",
			message: `The project "${project.metadata.name}" is still loading.`,
		});
	}
	if (editor.media.isLoadingMedia()) {
		throw new BridgeError({
			code: "NO_PROJECT",
			message: `The media of "${project.metadata.name}" are still loading.`,
		});
	}
	const scene = editor.scenes.getActiveSceneOrNull();
	if (!scene) {
		throw new BridgeError({
			code: "NO_PROJECT",
			message: `The project "${project.metadata.name}" has no active scene yet.`,
		});
	}
	return { project, scene };
}

/**
 * True when the user is dragging (a clip, a resize, a keyframe, a mask or transform handle, or a preview drag)
 * or scrubbing the playhead. Element drags hold their own view, not the timeline preview, hence the gestures.
 */
export function isUserInteracting(editor: EditorCore): boolean {
	return (
		editor.timeline.isPreviewActive() ||
		editor.playback.getIsScrubbing() ||
		hasActiveGesture()
	);
}

export function assertNotExporting({
	editor,
	message,
}: {
	editor: EditorCore;
	message?: string;
}): void {
	if (editor.project.getExportState().isExporting) {
		throw new BridgeError({ code: "EXPORTING", message });
	}
}

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error
		? signal.reason
		: new DOMException("The call was aborted", "AbortError");
}

/** Resolves after `ms`, or rejects with the abort reason when `signal` fires first. */
export function sleep({
	ms,
	signal,
}: {
	ms: number;
	signal?: AbortSignal;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(
				signal.reason instanceof Error
					? signal.reason
					: new DOMException("The call was aborted", "AbortError"),
			);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(
				signal?.reason instanceof Error
					? signal.reason
					: new DOMException("The call was aborted", "AbortError"),
			);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Waits (polling) until the user stops dragging or scrubbing, so long work (an import) does not fail at the very
 * end on a transient interaction. Returns false when the user is still interacting after `timeoutMs`.
 */
export async function waitForUserIdle({
	editor,
	timeoutMs,
	signal,
}: {
	editor: EditorCore;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (isUserInteracting(editor)) {
		if (Date.now() >= deadline) return false;
		await sleep({ ms: 100, signal });
	}
	return true;
}

/** Rounds to 3 decimals (what every tool returns for seconds and rates), never -0. */
export function round3(value: number): number {
	const rounded = Math.round(value * 1000) / 1000;
	return rounded === 0 ? 0 : rounded;
}
