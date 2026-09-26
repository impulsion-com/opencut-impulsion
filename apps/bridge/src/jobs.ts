import { randomUUID } from "node:crypto";
import type { TabEventMessage } from "@opencut/claude-tools";
import type { Logger } from "./log";

// Background jobs (imports and exports). The sidecar owns the table: tools create jobs, tab events
// ("job-progress", "export-progress") and the /exports upload move them forward, job_status reads them.
// `message` is French (shown in the chat panel), `error` is English (returned to the model).

export type JobKind = "import" | "export";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** Who started a job: a Claude Code session over /mcp, or the in-app chat (its sessionKey). */
export type ToolOrigin =
	| { kind: "mcp"; sessionId?: string }
	| { kind: "chat"; sessionKey: string };

export interface ExportJobInfo {
	/** File name with extension, before the unique suffix. */
	fileName: string;
	format: string;
	/** Where the file is expected to land (the final name may get a " (2)" suffix). */
	outputPath: string;
	upload: "none" | "receiving" | "done";
	/** Hub connection that accepted internal.export_start (its disconnect fails the job). */
	connectionId?: string;
}

export interface Job {
	id: string;
	kind: JobKind;
	status: JobStatus;
	/** 0..1 */
	progress: number;
	phase?: string;
	message?: string;
	result?: unknown;
	error?: string;
	origin: ToolOrigin;
	projectId: string | null;
	createdAt: number;
	updatedAt: number;
	finishedAt?: number;
	export?: ExportJobInfo;
}

/** job_status JSON, as the contract describes it. */
export interface JobSnapshot {
	jobId: string;
	kind: JobKind;
	status: JobStatus;
	progress: number;
	phase?: string;
	startedAt: string;
	finishedAt?: string;
	result?: unknown;
	error?: string;
}

export interface JobTable {
	create(options: {
		kind: JobKind;
		origin: ToolOrigin;
		projectId: string | null;
		export?: ExportJobInfo;
		status?: JobStatus;
	}): Job;
	get(id: string): Job | undefined;
	update(
		id: string,
		patch: Partial<Pick<Job, "status" | "progress" | "phase" | "message">> & {
			export?: Partial<ExportJobInfo>;
		},
	): Job | undefined;
	finish(
		id: string,
		outcome: {
			status: "done" | "failed" | "cancelled";
			result?: unknown;
			error?: string;
			message?: string;
		},
	): Job | undefined;
	/** Applies a tab "job-progress" or "export-progress" event (unknown or finished jobs are ignored). */
	applyTabEvent(event: TabEventMessage): void;
	/** Fails the running exports rendered by a tab connection that just closed. */
	failJobsOfConnection(connectionId: string): void;
	/** Resolves when the job is finished, the timeout elapses or the signal aborts (with its latest state). */
	waitFor(
		id: string,
		options: { timeoutMs: number; signal?: AbortSignal },
	): Promise<Job | undefined>;
	subscribe(listener: (job: Job) => void): () => void;
	snapshot(job: Job): JobSnapshot;
	list(): Job[];
	dispose(): void;
}

const FINISHED: ReadonlySet<JobStatus> = new Set([
	"done",
	"failed",
	"cancelled",
]);
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_JOBS = 500;
/** How long an export may sit at "done" (tab side) without its upload having arrived. */
const DONE_WITHOUT_UPLOAD_GRACE_MS = 15_000;

export function isFinished(job: Job): boolean {
	return FINISHED.has(job.status);
}

const EXPORT_PHASE_MESSAGES: Record<string, string> = {
	rendering: "Rendu de l'export en cours",
	uploading: "Enregistrement du fichier sur le disque",
};

export function createJobTable({
	logger,
	now = () => Date.now(),
	doneGraceMs = DONE_WITHOUT_UPLOAD_GRACE_MS,
}: {
	logger: Logger;
	now?: () => number;
	doneGraceMs?: number;
}): JobTable {
	const jobs = new Map<string, Job>();
	const listeners = new Set<(job: Job) => void>();
	const waiters = new Map<string, Set<() => void>>();
	const graceTimers = new Map<string, NodeJS.Timeout>();

	function emit(job: Job): void {
		for (const listener of listeners) {
			try {
				listener(job);
			} catch (error) {
				logger.warn("job listener failed", { error });
			}
		}
		if (isFinished(job)) {
			const pending = waiters.get(job.id);
			waiters.delete(job.id);
			for (const wake of pending ?? []) wake();
		}
	}

	function prune(): void {
		const at = now();
		for (const [id, job] of jobs) {
			if (
				isFinished(job) &&
				job.finishedAt !== undefined &&
				at - job.finishedAt > RETENTION_MS
			)
				jobs.delete(id);
		}
		for (const [id, job] of jobs) {
			if (jobs.size < MAX_JOBS) break;
			if (isFinished(job)) jobs.delete(id);
		}
	}

	function clearGrace(id: string): void {
		const timer = graceTimers.get(id);
		if (timer) clearTimeout(timer);
		graceTimers.delete(id);
	}

	const table: JobTable = {
		create({ kind, origin, projectId, export: exportInfo, status = "queued" }) {
			prune();
			const at = now();
			const job: Job = {
				id: randomUUID(),
				kind,
				status,
				progress: 0,
				origin,
				projectId,
				createdAt: at,
				updatedAt: at,
				...(exportInfo ? { export: { ...exportInfo } } : {}),
			};
			jobs.set(job.id, job);
			logger.info("job created", { jobId: job.id, kind });
			emit(job);
			return job;
		},

		get: (id) => jobs.get(id),

		update(id, patch) {
			const job = jobs.get(id);
			if (!job || isFinished(job)) return job;
			const { export: exportPatch, ...rest } = patch;
			Object.assign(job, rest);
			if (exportPatch && job.export) Object.assign(job.export, exportPatch);
			job.progress = clamp01(job.progress);
			job.updatedAt = now();
			emit(job);
			return job;
		},

		finish(id, { status, result, error, message }) {
			const job = jobs.get(id);
			if (!job || isFinished(job)) return job;
			clearGrace(id);
			job.status = status;
			job.updatedAt = now();
			job.finishedAt = job.updatedAt;
			if (status === "done") job.progress = 1;
			if (result !== undefined) job.result = result;
			if (error !== undefined) job.error = error;
			job.message = message ?? defaultFinishMessage(job);
			job.phase = status;
			logger.info("job finished", { jobId: id, kind: job.kind, status, error });
			emit(job);
			return job;
		},

		applyTabEvent(event) {
			if (event.name !== "job-progress" && event.name !== "export-progress")
				return;
			const job = jobs.get(event.payload.jobId);
			if (!job || isFinished(job)) return;
			if (event.name === "job-progress") {
				table.update(job.id, {
					status: "running",
					progress: event.payload.progress,
					phase: event.payload.phase,
					...(event.payload.message === undefined
						? {}
						: { message: event.payload.message }),
				});
				return;
			}
			const { phase, progress, error } = event.payload;
			switch (phase) {
				case "rendering":
				case "uploading":
					table.update(job.id, {
						status: "running",
						progress,
						phase,
						message: EXPORT_PHASE_MESSAGES[phase],
					});
					return;
				case "failed":
					table.finish(job.id, {
						status: "failed",
						error: error ?? "The editor reported that the export failed.",
						message: "L'export a échoué",
					});
					return;
				case "cancelled":
					table.finish(job.id, {
						status: "cancelled",
						message: "Export annulé",
					});
					return;
				case "done": {
					// The tab says done once its POST returned; the upload handler finishes the job. If no upload is
					// running or finished shortly after, the file never arrived.
					if (job.export?.upload === "done") return;
					table.update(job.id, {
						status: "running",
						progress: 1,
						phase: "uploading",
					});
					if (job.export?.upload === "receiving" || graceTimers.has(job.id))
						return;
					const timer = setTimeout(() => {
						graceTimers.delete(job.id);
						const current = jobs.get(job.id);
						if (
							!current ||
							isFinished(current) ||
							current.export?.upload !== "none"
						)
							return;
						table.finish(job.id, {
							status: "failed",
							error:
								"The editor reported the export as done but no file reached the sidecar.",
							message: "L'export est terminé mais le fichier n'est pas arrivé",
						});
					}, doneGraceMs);
					timer.unref?.();
					graceTimers.set(job.id, timer);
					return;
				}
			}
		},

		failJobsOfConnection(connectionId) {
			for (const job of jobs.values()) {
				if (
					isFinished(job) ||
					job.kind !== "export" ||
					job.export?.connectionId !== connectionId
				)
					continue;
				if (job.export.upload === "receiving") continue;
				table.finish(job.id, {
					status: "failed",
					error: "The editor tab closed or reloaded during the export.",
					message: "L'onglet de l'éditeur s'est fermé pendant l'export",
				});
			}
		},

		async waitFor(id, { timeoutMs, signal }) {
			const job = jobs.get(id);
			if (!job || isFinished(job) || timeoutMs <= 0 || signal?.aborted)
				return job;
			await new Promise<void>((resolve) => {
				let timer: NodeJS.Timeout | undefined;
				const wake = () => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", wake);
					waiters.get(id)?.delete(wake);
					resolve();
				};
				timer = setTimeout(wake, timeoutMs);
				signal?.addEventListener("abort", wake, { once: true });
				let set = waiters.get(id);
				if (!set) {
					set = new Set();
					waiters.set(id, set);
				}
				set.add(wake);
			});
			return jobs.get(id);
		},

		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		snapshot(job) {
			return {
				jobId: job.id,
				kind: job.kind,
				status: job.status,
				progress: round3(job.progress),
				...(job.phase === undefined ? {} : { phase: job.phase }),
				startedAt: new Date(job.createdAt).toISOString(),
				...(job.finishedAt === undefined
					? {}
					: { finishedAt: new Date(job.finishedAt).toISOString() }),
				...(job.result === undefined ? {} : { result: job.result }),
				...(job.error === undefined ? {} : { error: job.error }),
			};
		},

		list: () => [...jobs.values()],

		dispose() {
			for (const timer of graceTimers.values()) clearTimeout(timer);
			graceTimers.clear();
			for (const set of waiters.values()) for (const wake of set) wake();
			waiters.clear();
		},
	};
	return table;
}

function defaultFinishMessage(job: Job): string {
	const what = job.kind === "export" ? "L'export" : "L'import";
	if (job.status === "done") return `${what} est terminé`;
	if (job.status === "cancelled") return `${what} a été annulé`;
	return `${what} a échoué`;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}
