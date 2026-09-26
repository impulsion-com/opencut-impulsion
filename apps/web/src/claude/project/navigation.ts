import type { EditorCore } from "@/core";
import { BridgeError } from "@/claude/types";

// Moving the tab to another project without reloading it. A full reload (location.assign) would kill the
// bridge socket, and with it the RPC waiting for the project to open, so the Next app router is used.

export const OPEN_PROJECT_TIMEOUT_MS = 60_000;
const POLL_MS = 250;
/**
 * Quiet period required once the load looks complete. In dev, React StrictMode runs EditorProvider's effect
 * twice, so two loadProject calls overlap: the first one's save.resume() comes while the second still runs,
 * and a project save landing late (saveCurrentProject writes back the `active` it read before its await) would
 * undo a change made in between. Every step of a load notifies, so silence means it is really over.
 */
export const PROJECT_SETTLE_MS = 500;

export function editorPath({ projectId }: { projectId: string }): string {
	return `/editor/${encodeURIComponent(projectId)}`;
}

interface SoftRouter {
	push: (href: string) => void;
}

/**
 * Next's public app router instance. Next assigns it to `window.next.router` (app-router-instance.js, all
 * Next 13.4+ versions, dev and prod). There is no other way to reach the router from outside React.
 */
function getSoftRouter(): SoftRouter | null {
	const next: unknown = Reflect.get(window, "next");
	if (typeof next !== "object" || next === null) return null;
	const router: unknown = Reflect.get(next, "router");
	if (typeof router !== "object" || router === null) return null;
	const push: unknown = Reflect.get(router, "push");
	if (typeof push !== "function") return null;
	return {
		push: (href) => {
			Reflect.apply(push, router, [href]);
		},
	};
}

/**
 * Client-side navigation when the router is reachable ("soft"); otherwise a full page load ("hard"): the tab
 * then reloads and the hub sees the call fail with CONNECTION_LOST.
 */
export function navigateTab({ path }: { path: string }): "soft" | "hard" {
	const router = getSoftRouter();
	if (router) {
		router.push(path);
		return "soft";
	}
	window.location.assign(path);
	return "hard";
}

/** SaveManager pauses for the whole of ProjectManager.loadProject (pause() first, resume() in its finally). */
function isSavePaused(editor: EditorCore): boolean | null {
	const value: unknown = Reflect.get(editor.save, "isPaused");
	return typeof value === "boolean" ? value : null;
}

/** A SaveManager save in flight (private flag, read by reflection like isPaused). */
function isSaving(editor: EditorCore): boolean {
	return Reflect.get(editor.save, "isSaving") === true;
}

export interface ProjectLoadProbe {
	/** Feeds the current editor state; returns true once the project is fully loaded. */
	observe(): boolean;
}

/**
 * Tracks one ProjectManager.loadProject run for `projectId`. The editor reports no "loaded" event, and
 * isLoading only flips on a first load, so completion is inferred from the load's side effects, in order:
 * it started (scenes cleared or SaveManager paused), it reached the media (MediaManager.isLoadingMedia went
 * true), then it finished (project, scene and media in place, SaveManager resumed).
 * With `requireReload: false` an already open, idle project counts as loaded.
 */
export function createProjectLoadProbe({
	editor,
	projectId,
	requireReload,
	getPath,
}: {
	editor: EditorCore;
	projectId: string;
	requireReload: boolean;
	getPath: () => string;
}): ProjectLoadProbe {
	let started = !requireReload;
	let reachedMedia = !requireReload;
	const expectedPath = editorPath({ projectId });
	return {
		observe() {
			const paused = isSavePaused(editor);
			if (!started) {
				started =
					paused === true ||
					editor.scenes.getActiveSceneOrNull() === null ||
					editor.project.getIsLoading();
			}
			if (started && editor.media.isLoadingMedia()) reachedMedia = true;
			if (!started || !reachedMedia) return false;
			return (
				editor.project.getActiveOrNull()?.metadata.id === projectId &&
				!editor.project.getIsLoading() &&
				!editor.media.isLoadingMedia() &&
				editor.scenes.getActiveSceneOrNull() !== null &&
				paused !== true &&
				decodeURIComponent(getPath()) === decodeURIComponent(expectedPath)
			);
		},
	};
}

/**
 * Resolves once `projectId` is open and loaded in this tab (see createProjectLoadProbe) and nothing has moved
 * for `settleMs` (see PROJECT_SETTLE_MS). Rejects with TIMEOUT after `timeoutMs`, or with the abort reason when
 * `signal` fires.
 */
export function waitForProjectLoaded({
	editor,
	projectId,
	requireReload,
	timeoutMs = OPEN_PROJECT_TIMEOUT_MS,
	settleMs = PROJECT_SETTLE_MS,
	signal,
	getPath = () => window.location.pathname,
}: {
	editor: EditorCore;
	projectId: string;
	requireReload: boolean;
	timeoutMs?: number;
	settleMs?: number;
	signal?: AbortSignal;
	getPath?: () => string;
}): Promise<void> {
	const probe = createProjectLoadProbe({
		editor,
		projectId,
		requireReload,
		getPath,
	});
	return new Promise<void>((resolve, reject) => {
		const cleanups: (() => void)[] = [];
		let settled = false;
		const settle = (outcome: () => void) => {
			if (settled) return;
			settled = true;
			for (const cleanup of cleanups) cleanup();
			outcome();
		};
		let quietTimer: ReturnType<typeof setTimeout> | null = null;
		const stopQuietTimer = () => {
			if (quietTimer !== null) clearTimeout(quietTimer);
			quietTimer = null;
		};
		cleanups.push(stopQuietTimer);
		const check = () => {
			if (!probe.observe()) {
				stopQuietTimer();
				return;
			}
			if (quietTimer !== null) return;
			quietTimer = setTimeout(() => {
				quietTimer = null;
				if (probe.observe() && !isSaving(editor)) settle(resolve);
			}, settleMs);
		};
		// Synchronous notifications catch the short-lived markers (scenes cleared, media loading), and restart
		// the quiet period.
		const onChange = () => {
			stopQuietTimer();
			check();
		};
		cleanups.push(editor.project.subscribe(onChange));
		cleanups.push(editor.scenes.subscribe(onChange));
		cleanups.push(editor.media.subscribe(onChange));
		// SaveManager.resume() and URL changes notify nobody.
		const poll = setInterval(check, POLL_MS);
		cleanups.push(() => clearInterval(poll));
		const timer = setTimeout(() => {
			settle(() =>
				reject(
					new BridgeError({
						code: "TIMEOUT",
						message: `The project "${projectId}" did not finish opening within ${Math.round(timeoutMs / 1000)} s.`,
						details: { projectId },
					}),
				),
			);
		}, timeoutMs);
		cleanups.push(() => clearTimeout(timer));
		if (signal) {
			const onAbort = () =>
				settle(() =>
					reject(
						signal.reason instanceof Error
							? signal.reason
							: new DOMException("The call was aborted", "AbortError"),
					),
				);
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
			cleanups.push(() => signal.removeEventListener("abort", onAbort));
		}
		check();
	});
}
