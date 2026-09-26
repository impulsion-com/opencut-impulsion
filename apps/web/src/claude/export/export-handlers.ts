import {
	BRIDGE_EXPORTS_PATH,
	isBridgeUrl,
	type ExportPhase,
	type ToolResult,
} from "@opencut/claude-tools";
import type { EditorCore } from "@/core";
import { getExportMimeType } from "@/export";
import {
	BridgeError,
	jsonResult,
	type TabHandlerContext,
} from "@/claude/types";
import {
	requireReadyProject,
	type HandlerArgs,
} from "@/claude/state/handler-kit";

// internal.export_start / internal.export_cancel, the tab half of start_export and cancel_job (map 4.3, 9.6).
// The export runs through ProjectManager.export (so exportState drives the UI and runAiEdit refuses edits with
// EXPORTING), then the file is POSTed to the sidecar's /exports route. The RPC only acknowledges; progress and
// the outcome travel as "export-progress" events.
//
// `progress` in those events is the job's overall progress: rendering 0..0.95, uploading 0.95..1, done 1.

const RENDER_SHARE = 0.95;
const KEPT_IN_TAB =
	"The rendered file was not lost: the user can download it from the editor's Export button.";
const PROGRESS_POLL_MS = 500;
const MAX_ERROR_CHARS = 300;

interface ExportJob {
	jobId: string;
	cancelRequested: boolean;
	upload: AbortController | null;
}

/** One export at a time: the editor has a single exportState. */
let activeJob: ExportJob | null = null;

/**
 * The job id of the export this tab is rendering for the bridge, or null. Named in EXPORTING errors: after a
 * sidecar restart only the tab still knows it, and cancel_job with it reaches the tab.
 */
export function getActiveExportJobId(): string | null {
	return activeJob?.jobId ?? null;
}

function clamp01(value: number): number {
	return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function emitProgress({
	ctx,
	jobId,
	phase,
	progress,
	error,
}: {
	ctx: TabHandlerContext;
	jobId: string;
	phase: ExportPhase;
	progress: number;
	error?: string;
}): void {
	ctx.emit({
		type: "event",
		name: "export-progress",
		payload: {
			jobId,
			phase,
			progress: clamp01(progress),
			...(error ? { error: error.slice(0, MAX_ERROR_CHARS) } : {}),
		},
	});
}

async function runExport({
	editor,
	ctx,
	job,
	input,
}: {
	editor: EditorCore;
	ctx: TabHandlerContext;
	job: ExportJob;
	input: HandlerArgs<"internal.export_start">["input"];
}): Promise<void> {
	const { jobId } = job;
	let lastProgress = 0;
	/** The sidecar stored the file; until then the rendered buffer stays in the export popover. */
	let uploaded = false;
	const report = ({
		phase,
		progress,
		error,
	}: {
		phase: ExportPhase;
		progress: number;
		error?: string;
	}) => {
		lastProgress = clamp01(progress);
		emitProgress({ ctx, jobId, phase, progress: lastProgress, error });
	};

	report({ phase: "rendering", progress: 0 });
	const poll = setInterval(() => {
		const state = editor.project.getExportState();
		if (!state.isExporting) return;
		const progress = Math.round(state.progress * RENDER_SHARE * 1000) / 1000;
		if (progress > lastProgress) report({ phase: "rendering", progress });
	}, PROGRESS_POLL_MS);

	try {
		const project = editor.project.getActive();
		const result = await editor.project.export({
			options: {
				format: input.format,
				quality: input.quality,
				includeAudio: input.includeAudio,
				// Like the export button: the project frame rate, as a FrameRate.
				fps: project.settings.fps,
			},
		});
		clearInterval(poll);
		if (result.cancelled || job.cancelRequested) {
			report({ phase: "cancelled", progress: lastProgress });
			return;
		}
		if (!result.success || !result.buffer) {
			report({
				phase: "failed",
				progress: lastProgress,
				error: result.error ?? "The export produced no file.",
			});
			return;
		}

		report({ phase: "uploading", progress: RENDER_SHARE });
		job.upload = new AbortController();
		const response = await fetch(input.uploadUrl, {
			method: "POST",
			body: result.buffer,
			headers: { "Content-Type": getExportMimeType({ format: input.format }) },
			signal: job.upload.signal,
		});
		if (!response.ok) {
			const detail = (await response.text().catch(() => "")).slice(0, 200);
			report({
				phase: "failed",
				progress: lastProgress,
				error: `The sidecar refused the upload (HTTP ${response.status}${detail ? `: ${detail}` : ""}). ${KEPT_IN_TAB}`,
			});
			return;
		}
		uploaded = true;
		report({ phase: "done", progress: 1 });
	} catch (error) {
		clearInterval(poll);
		if (job.cancelRequested) {
			report({ phase: "cancelled", progress: lastProgress });
			return;
		}
		const message = error instanceof Error ? error.message : String(error);
		const rendered = editor.project.getExportState().result?.buffer;
		report({
			phase: "failed",
			progress: lastProgress,
			error: rendered ? `${message} ${KEPT_IN_TAB}` : message,
		});
	} finally {
		clearInterval(poll);
		job.upload = null;
		// The file went to disk: the export popover must not offer this buffer for download. When the upload
		// failed (sidecar restarted, disk full...), the buffer stays there so the render is not lost.
		const state = editor.project.getExportState();
		if (!state.isExporting && (uploaded || !state.result?.success)) {
			editor.project.clearExportState();
		}
	}
}

export async function exportStart({
	input,
	ctx,
}: HandlerArgs<"internal.export_start">): Promise<ToolResult> {
	const { editor } = ctx;
	requireReadyProject(editor);
	if (!isBridgeUrl(input.uploadUrl, BRIDGE_EXPORTS_PATH)) {
		throw new BridgeError({
			code: "INVALID_PARAMS",
			message: "uploadUrl must be the sidecar's /exports route.",
		});
	}
	if (activeJob || editor.project.getExportState().isExporting) {
		throw new BridgeError({
			code: "EXPORTING",
			message: activeJob
				? `Export "${activeJob.jobId}" is still running.`
				: "An export started from the editor is running.",
			...(activeJob ? { details: { jobId: activeJob.jobId } } : {}),
		});
	}
	if (editor.timeline.getTotalDuration() <= 0) {
		throw new BridgeError({
			code: "INVALID_PARAMS",
			message: "The active scene is empty: there is nothing to export.",
		});
	}

	const job: ExportJob = {
		jobId: input.jobId,
		cancelRequested: false,
		upload: null,
	};
	activeJob = job;
	// Not awaited: the RPC acknowledges now, the export can take minutes.
	void runExport({ editor, ctx, job, input }).finally(() => {
		if (activeJob === job) activeJob = null;
	});
	return jsonResult({ accepted: true, jobId: input.jobId });
}

export async function exportCancel({
	input,
	ctx,
}: HandlerArgs<"internal.export_cancel">): Promise<ToolResult> {
	const job = activeJob;
	if (!job || job.jobId !== input.jobId) {
		return jsonResult({
			cancelled: false,
			reason: "No running export has this job id.",
		});
	}
	job.cancelRequested = true;
	if (ctx.editor.project.getExportState().isExporting) {
		// Checked by the renderer every 100 ms; the audio mix phase finishes before it stops.
		ctx.editor.project.cancelExport();
	}
	job.upload?.abort();
	return jsonResult({ cancelled: true });
}
