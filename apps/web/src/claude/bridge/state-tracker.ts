import type { EditorCore } from "@/core";
import type { BridgeTimers } from "./environment";

// stateVersion: a per-tab counter bumped on every real change of the project, scenes, tracks, bookmarks or
// media, manual or not. Claude passes it back as expectStateVersion so an edit made meanwhile is detected.

const STATE_EVENT_DEBOUNCE_MS = 150;
const STATE_EVENT_MAX_WAIT_MS = 1_000;

/** References compared with Object.is: the editor state is immutable with structural sharing. */
interface StateFingerprint {
	projectId: string | null;
	projectName: string | null;
	settings: unknown;
	sceneId: string | null;
	scenes: unknown;
	tracks: unknown;
	bookmarks: unknown;
	media: unknown;
}

const FINGERPRINT_KEYS = [
	"projectId",
	"projectName",
	"settings",
	"sceneId",
	"scenes",
	"tracks",
	"bookmarks",
	"media",
] as const satisfies readonly (keyof StateFingerprint)[];

function readFingerprint(editor: EditorCore): StateFingerprint {
	const project = editor.project.getActiveOrNull();
	const scene = editor.scenes.getActiveSceneOrNull();
	return {
		projectId: project?.metadata.id ?? null,
		projectName: project?.metadata.name ?? null,
		// Not the project object: it is rebuilt for timeline zoom/scroll and saves, which are not edits.
		settings: project?.settings ?? null,
		sceneId: scene?.id ?? null,
		scenes: editor.scenes.getScenes(),
		tracks: scene?.tracks ?? null,
		bookmarks: scene?.bookmarks ?? null,
		media: editor.media.getAssets(),
	};
}

function isSameFingerprint({
	a,
	b,
}: {
	a: StateFingerprint;
	b: StateFingerprint;
}): boolean {
	return FINGERPRINT_KEYS.every((key) => Object.is(a[key], b[key]));
}

export interface StateTracker {
	/** Watches the current EditorCore, re-binding when getEditor() returns another one (HMR). Returns it. */
	bind(): EditorCore | null;
	unbind(): void;
	/** Re-reads the editor (catches a change not notified yet) and returns the current version. */
	getVersion(): number;
	/** Reports the current version now, cancelling the pending debounce. */
	flush(): void;
	getProject(): { id: string | null; name: string | null };
}

export function createStateTracker({
	getEditor,
	timers,
	now,
	onStateChanged,
	onProjectChanged,
}: {
	getEditor: () => EditorCore | null;
	timers: BridgeTimers;
	now: () => number;
	/** Trailing debounce of 150 ms, at most 1 s after the first pending change. */
	onStateChanged: (payload: {
		version: number;
		projectId: string | null;
	}) => void;
	/** Right away when the open project id changes. */
	onProjectChanged: () => void;
}): StateTracker {
	let editor: EditorCore | null = null;
	let unsubscribe: (() => void) | null = null;
	let fingerprint: StateFingerprint | null = null;
	// Starts at the load time (ms) rather than 0: a reload (frequent with Fast Refresh) must never hand out a
	// version an earlier load already used, or a stale expectStateVersion could match by chance. Still one step
	// per change within the tab.
	let version = Math.max(0, Math.floor(now()));
	let timer: unknown = null;
	let firstPendingAt = 0;

	function getProject() {
		const project = editor?.project.getActiveOrNull();
		return {
			id: project?.metadata.id ?? null,
			name: project?.metadata.name ?? null,
		};
	}

	function clearTimer(): void {
		if (timer !== null) timers.cancel(timer);
		timer = null;
		firstPendingAt = 0;
	}

	function flush(): void {
		clearTimer();
		onStateChanged({ version, projectId: getProject().id });
	}

	function schedule(): void {
		const at = now();
		if (firstPendingAt === 0) firstPendingAt = at;
		if (timer !== null) timers.cancel(timer);
		const delayMs = Math.max(
			0,
			Math.min(
				STATE_EVENT_DEBOUNCE_MS,
				firstPendingAt + STATE_EVENT_MAX_WAIT_MS - at,
			),
		);
		timer = timers.schedule({ callback: flush, delayMs });
	}

	function check(): void {
		if (!editor) return;
		const next = readFingerprint(editor);
		if (fingerprint && isSameFingerprint({ a: fingerprint, b: next })) return;
		const projectChanged =
			fingerprint !== null && fingerprint.projectId !== next.projectId;
		fingerprint = next;
		version += 1;
		if (projectChanged) onProjectChanged();
		schedule();
	}

	function unbind(): void {
		unsubscribe?.();
		unsubscribe = null;
		editor = null;
		fingerprint = null;
		clearTimer();
	}

	function bind(): EditorCore | null {
		const current = getEditor();
		if (current === editor) return current;
		const hadEditor = editor !== null;
		unbind();
		if (!current) return null;
		editor = current;
		const unsubscribers = [
			current.project.subscribe(check),
			current.scenes.subscribe(check),
			current.timeline.subscribe(check),
			current.media.subscribe(check),
		];
		unsubscribe = () => {
			for (const stop of unsubscribers) stop();
		};
		fingerprint = readFingerprint(current);
		if (hadEditor) {
			// A new EditorCore instance (HMR): whatever Claude read before is stale.
			version += 1;
			schedule();
		}
		return current;
	}

	return {
		bind,
		unbind,
		getVersion: () => {
			check();
			return version;
		},
		flush,
		getProject,
	};
}
