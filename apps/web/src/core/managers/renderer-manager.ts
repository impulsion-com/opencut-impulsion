import type { EditorCore } from "@/core";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import type { ExportOptions, ExportResult } from "@/export";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import { buildScene } from "@/services/renderer/scene-builder";
import { createTimelineAudioBuffer } from "@/media/audio";
import { formatTimecode } from "opencut-wasm";
import { downloadBlob } from "@/utils/browser";
import { loadFonts } from "@/fonts/google-fonts";
import { getElementFontFamilies } from "@/timeline/element-utils";
import type { TCanvasSize } from "@/project/types";
import { clampMediaTime, mediaTime, ZERO_MEDIA_TIME, type MediaTime } from "@/wasm";

type SnapshotResult =
	| { success: true; blob: Blob; filename: string }
	| { success: false; error: string };

export type CaptureMimeType = "image/jpeg" | "image/png";

export interface CapturedFrame {
	/** Base64 image data, without the data: prefix. */
	base64: string;
	mimeType: CaptureMimeType;
	/** Encoded image size in px: the canvas scaled down to fit maxEdge (never scaled up). */
	width: number;
	height: number;
	/** The timeline time actually rendered (clamped to the last frame). */
	time: MediaTime;
	canvasSize: TCanvasSize;
}

export interface RenderedFrame {
	index: number;
	/** The timeline time actually rendered (clamped to the last frame). */
	time: MediaTime;
	/** The compositor output. Only valid during the onFrame call: draw it right away. */
	source: HTMLCanvasElement;
	canvasSize: TCanvasSize;
}

/** How long an exclusive render waits for an in-flight preview frame before going ahead anyway. */
const PREVIEW_RENDER_WAIT_MS = 2_000;

function fitWithinMaxEdge({
	width,
	height,
	maxEdge,
}: {
	width: number;
	height: number;
	maxEdge: number;
}): { width: number; height: number } {
	const scale = Math.min(1, maxEdge / Math.max(width, height));
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw signal.reason instanceof Error
			? signal.reason
			: new DOMException("The render was aborted", "AbortError");
	}
}

export class RendererManager {
	private renderTree: RootNode | null = null;
	private _isDegraded = false;
	private listeners = new Set<() => void>();
	// Render mutex. There is one compositor canvas (a wasm thread_local) and one videoCache, shared by the
	// preview, snapshots, thumbnails, captures and exports: two renders interleaving at an await get each
	// other's textures or video frames. Exclusive renders queue FIFO; the preview skips frames while one is
	// pending and redraws once previewVersion moves.
	private exclusiveTail: Promise<void> = Promise.resolve();
	private exclusivePending = 0;
	private previewRender: Promise<void> | null = null;
	private previewVersion = 0;

	constructor(private editor: EditorCore) {}

	get isDegraded(): boolean {
		return this._isDegraded;
	}

	setDegraded(degraded: boolean): void {
		if (this._isDegraded === degraded) return;
		this._isDegraded = degraded;
		this.notify();
	}

	setRenderTree({ renderTree }: { renderTree: RootNode | null }): void {
		this.renderTree = renderTree;
		this.notify();
	}

	getRenderTree(): RootNode | null {
		return this.renderTree;
	}

	/** True while an exclusive render (capture, snapshot, thumbnail, export) is queued or running. */
	isRenderLocked(): boolean {
		return this.exclusivePending > 0;
	}

	/** Bumped each time the render lock is released: the preview must redraw (the compositor shows another frame). */
	getPreviewVersion(): number {
		return this.previewVersion;
	}

	/** The preview registers its in-flight frame so an exclusive render waits for it instead of interleaving. */
	trackPreviewRender({ render }: { render: Promise<unknown> }): void {
		const tracked = render.then(
			() => undefined,
			(error: unknown) => {
				console.error("Preview render failed:", error);
			},
		);
		this.previewRender = tracked;
		void tracked.then(() => {
			if (this.previewRender === tracked) this.previewRender = null;
		});
	}

	/** Runs `task` with the compositor and video cache to itself (FIFO with other exclusive renders). */
	async runExclusive<T>(task: () => Promise<T>): Promise<T> {
		this.exclusivePending += 1;
		const previous = this.exclusiveTail;
		let release = () => {};
		this.exclusiveTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			await previous;
			await this.waitForPreviewRender();
			return await task();
		} finally {
			this.exclusivePending -= 1;
			if (this.exclusivePending === 0) this.previewVersion += 1;
			release();
		}
	}

	private async waitForPreviewRender(): Promise<void> {
		const pending = this.previewRender;
		if (!pending) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			pending,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, PREVIEW_RENDER_WAIT_MS);
			}),
		]);
		clearTimeout(timer);
	}

	/**
	 * Renders the active scene at each time, exactly as exported (full-resolution sources), holding the render
	 * lock for the whole batch. `onFrame` runs synchronously right after each render, while the compositor
	 * canvas still holds that frame (on the WebGL fallback it is only readable in that task).
	 * Pass the times sorted ascending: the video cache then decodes forward.
	 */
	async renderFrames({
		times,
		onFrame,
		signal,
	}: {
		times: readonly MediaTime[];
		onFrame: (frame: RenderedFrame) => void;
		signal?: AbortSignal;
	}): Promise<{ canvasSize: TCanvasSize; times: MediaTime[] }> {
		const pendingScene = this.editor.scenes.getActiveSceneOrNull();
		if (pendingScene) {
			// Outside the lock so a font download never freezes the preview; loadFonts caches.
			await loadFonts({
				families: getElementFontFamilies({ tracks: pendingScene.tracks }),
			});
		}
		throwIfAborted(signal);

		return this.runExclusive(async () => {
			const project = this.editor.project.getActiveOrNull();
			const scene = this.editor.scenes.getActiveSceneOrNull();
			if (!project || !scene) {
				throw new Error("No project or scene to render");
			}
			const { canvasSize, fps, background } = project.settings;
			const tracks = scene.tracks;
			await loadFonts({ families: getElementFontFamilies({ tracks }) });

			const duration = this.editor.timeline.getTotalDuration();
			const lastFrame = this.editor.timeline.getLastFrameTime();
			const rootNode = buildScene({
				tracks,
				mediaAssets: this.editor.media.getAssets(),
				// An empty timeline still renders its background.
				duration: duration > 0 ? duration : mediaTime({ ticks: 1 }),
				canvasSize,
				background,
			});
			const renderer = new CanvasRenderer({
				width: canvasSize.width,
				height: canvasSize.height,
				fps,
			});

			const rendered: MediaTime[] = [];
			for (const [index, requested] of times.entries()) {
				throwIfAborted(signal);
				const time = clampMediaTime({
					time: requested,
					min: ZERO_MEDIA_TIME,
					max: lastFrame > 0 ? lastFrame : ZERO_MEDIA_TIME,
				});
				await renderer.render({ node: rootNode, time });
				onFrame({ index, time, source: renderer.getOutputCanvas(), canvasSize });
				rendered.push(time);
			}
			return { canvasSize, times: rendered };
		});
	}

	/** One composed frame of the active scene as an encoded image, scaled to fit `maxEdge`. */
	async captureFrame({
		time,
		maxEdge = 1280,
		mime = "image/jpeg",
		quality = 0.85,
		signal,
	}: {
		time: MediaTime;
		maxEdge?: number;
		mime?: CaptureMimeType;
		quality?: number;
		signal?: AbortSignal;
	}): Promise<CapturedFrame> {
		const output: { frame: CapturedFrame | null } = { frame: null };
		await this.renderFrames({
			times: [time],
			signal,
			onFrame: ({ time: renderedTime, source, canvasSize }) => {
				const size = fitWithinMaxEdge({
					width: canvasSize.width,
					height: canvasSize.height,
					maxEdge,
				});
				const target = document.createElement("canvas");
				target.width = size.width;
				target.height = size.height;
				const context = target.getContext("2d");
				if (!context) throw new Error("Failed to get a 2D context for the capture");
				if (mime === "image/jpeg") {
					// JPEG has no alpha: a transparent background would otherwise come out black anyway.
					context.fillStyle = "#000000";
					context.fillRect(0, 0, size.width, size.height);
				}
				context.drawImage(source, 0, 0, size.width, size.height);
				// Encoded in the same task as the render.
				const dataUrl = target.toDataURL(mime, quality);
				const comma = dataUrl.indexOf(",");
				output.frame = {
					base64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
					mimeType: dataUrl.startsWith("data:image/png") ? "image/png" : mime,
					width: size.width,
					height: size.height,
					time: renderedTime,
					canvasSize,
				};
			},
		});
		if (!output.frame) throw new Error("The frame could not be captured");
		return output.frame;
	}

	async saveSnapshot(): Promise<{ success: boolean; error?: string }> {
		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		downloadBlob({ blob: snapshot.blob, filename: snapshot.filename });
		return { success: true };
	}

	async copySnapshot(): Promise<{ success: boolean; error?: string }> {
		if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
			return {
				success: false,
				error: "Clipboard image copy is not supported in this browser",
			};
		}

		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		try {
			await navigator.clipboard.write([
				new ClipboardItem({
					[snapshot.blob.type || "image/png"]: snapshot.blob,
				}),
			]);
			return { success: true };
		} catch (error) {
			console.error("Copy snapshot failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	private async createSnapshot(): Promise<SnapshotResult> {
		return this.runExclusive(() => this.createSnapshotUnlocked());
	}

	private async createSnapshotUnlocked(): Promise<SnapshotResult> {
		try {
			const renderTree = this.getRenderTree();
			const activeProject = this.editor.project.getActive();

			if (!renderTree || !activeProject) {
				return { success: false, error: "No project or scene to capture" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const { canvasSize, fps } = activeProject.settings;
			const renderTime = Math.min(
				this.editor.playback.getCurrentTime(),
				this.editor.timeline.getLastFrameTime(),
			);

			const renderer = new CanvasRenderer({
				width: canvasSize.width,
				height: canvasSize.height,
				fps,
			});

			const tempCanvas = document.createElement("canvas");
			tempCanvas.width = canvasSize.width;
			tempCanvas.height = canvasSize.height;

			await renderer.renderToCanvas({
				node: renderTree,
				time: renderTime,
				targetCanvas: tempCanvas,
			});

			const blob = await new Promise<Blob | null>((resolve) => {
				tempCanvas.toBlob((result) => resolve(result), "image/png");
			});

			if (!blob) {
				return { success: false, error: "Failed to create image" };
			}

			const timecode = formatTimecode({ time: renderTime, rate: fps })!.replace(/:/g, "-");
			const safeName =
				activeProject.metadata.name.replace(/[<>:"/\\|?*]/g, "-").trim() ||
				"snapshot";
			const filename = `${safeName}-${timecode}.png`;

			return { success: true, blob, filename };
		} catch (error) {
			console.error("Snapshot capture failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	async exportProject(params: {
		options: ExportOptions;
		onProgress?: ({ progress }: { progress: number }) => void;
		onCancel?: () => boolean;
	}): Promise<ExportResult> {
		// The whole export holds the render lock: the preview freezes until it ends.
		return this.runExclusive(() => this.exportProjectUnlocked(params));
	}

	private async exportProjectUnlocked({
		options,
		onProgress,
		onCancel,
	}: {
		options: ExportOptions;
		onProgress?: ({ progress }: { progress: number }) => void;
		onCancel?: () => boolean;
	}): Promise<ExportResult> {
		const { format, quality, fps, includeAudio } = options;

		try {
			const tracks = this.editor.scenes.getActiveScene().tracks;
			const mediaAssets = this.editor.media.getAssets();
			const activeProject = this.editor.project.getActive();

			if (!activeProject) {
				return { success: false, error: "No active project" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const exportFps = fps ?? activeProject.settings.fps;
			const canvasSize = activeProject.settings.canvasSize;

			let audioBuffer: AudioBuffer | null = null;
			if (includeAudio) {
				onProgress?.({ progress: 0.05 });
				audioBuffer = await createTimelineAudioBuffer({
					tracks,
					mediaAssets,
					duration,
				});
			}

			const scene = buildScene({
				tracks,
				mediaAssets,
				duration,
				canvasSize,
				background: activeProject.settings.background,
			});

			const exporter = new SceneExporter({
				width: canvasSize.width,
				height: canvasSize.height,
				fps: exportFps,
				format,
				quality,
				shouldIncludeAudio: !!includeAudio,
				audioBuffer: audioBuffer || undefined,
			});

			exporter.on("progress", (progress) => {
				const adjustedProgress = includeAudio
					? 0.05 + progress * 0.95
					: progress;
				onProgress?.({ progress: adjustedProgress });
			});

			let cancelled = false;
			const checkCancel = () => {
				if (onCancel?.()) {
					cancelled = true;
					exporter.cancel();
				}
			};

			const cancelInterval = setInterval(checkCancel, 100);

			try {
				const buffer = await exporter.export({ rootNode: scene });
				clearInterval(cancelInterval);

				if (cancelled) {
					return { success: false, cancelled: true };
				}

				if (!buffer) {
					return { success: false, error: "Export failed to produce buffer" };
				}

				return {
					success: true,
					buffer,
				};
			} finally {
				clearInterval(cancelInterval);
			}
		} catch (error) {
			console.error("Export failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown export error",
			};
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
