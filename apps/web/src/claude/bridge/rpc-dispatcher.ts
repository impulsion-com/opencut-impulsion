import {
	formatIssues,
	INTERNAL_METHOD_PARAMS,
	isInternalMethod,
	isToolName,
	parseToolInput,
	RpcMethodSchema,
	TOOLS,
	ToolResultSchema,
	type BridgeErrorPayload,
	type RpcMessage,
	type TabEventMessage,
	type ToolResult,
} from "@opencut/claude-tools";
import type { EditorCore } from "@/core";
import { isTabMethod } from "@/claude/handlers/registry";
import {
	BridgeError,
	toBridgeErrorPayload,
	type TabHandlerContext,
	type TabMethod,
	type TabProgressReport,
	type UntypedTabHandler,
} from "@/claude/types";
import type { BridgeTimers } from "./environment";

// Serves "rpc" calls from the hub: checks the project, validates params with the contract schema, runs the
// registered tab handler with a per-call AbortController, and maps every failure to a wire error. Mutating calls
// that carry an idempotencyKey are remembered for a few minutes so a re-delivery after a reconnect is not
// re-applied. Read-only calls are never remembered: running them again is harmless, and their results (frames,
// contact sheets) are the heavy ones.

const PROGRESS_THROTTLE_MS = 100;
const IDEMPOTENCY_TTL_MS = 5 * 60_000;
const IDEMPOTENCY_MAX_ENTRIES = 200;
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(
	TOOLS.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name),
);
const MAX_REPORTED_ISSUES = 20;

export type RpcOutcome =
	| { ok: true; result: ToolResult }
	| { ok: false; error: BridgeErrorPayload };

export interface RpcDispatcher {
	/** Runs the call, or replays the first outcome of a repeated idempotencyKey. `respond` gets it once. */
	dispatch(options: {
		message: RpcMessage;
		respond: (outcome: RpcOutcome) => void;
	}): void;
	/** Aborts the signal of every running call (the bridge stops). */
	abortAll(): void;
}

function parseParams({
	method,
	params,
}: {
	method: TabMethod;
	params: unknown;
}): unknown {
	if (isInternalMethod(method)) {
		const parsed = INTERNAL_METHOD_PARAMS[method].safeParse(params ?? {});
		if (parsed.success) return parsed.data;
		throw new BridgeError({
			code: "INVALID_PARAMS",
			message: formatIssues(parsed.error.issues),
			details: { issues: parsed.error.issues.slice(0, MAX_REPORTED_ISSUES) },
		});
	}
	if (isToolName(method)) {
		const parsed = parseToolInput(method, params);
		if (parsed.ok) return parsed.data;
		throw new BridgeError({
			code: "INVALID_PARAMS",
			message: parsed.message,
			details: { issues: parsed.issues.slice(0, MAX_REPORTED_ISSUES) },
		});
	}
	throw new BridgeError({
		code: "INTERNAL",
		message: `Unknown method "${method}".`,
	});
}

function defaultProgressKind(method: string): string {
	if (method === "internal.import_files") return "import";
	if (method === "internal.export_start") return "export";
	return method;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/**
 * For an rpc frame the schema refused (unknown method, bad field): the id and error to answer with, so the hub
 * does not wait for its timeout. Null when the frame is not an answerable rpc.
 */
export function outcomeForMalformedRpc({
	raw,
	error,
}: {
	raw: unknown;
	error: string;
}): { id: string; outcome: RpcOutcome } | null {
	if (typeof raw !== "object" || raw === null) return null;
	const type: unknown = Reflect.get(raw, "type");
	const id: unknown = Reflect.get(raw, "id");
	const method: unknown = Reflect.get(raw, "method");
	if (type !== "rpc" || typeof id !== "string" || id.length === 0) return null;
	const unknownMethod =
		typeof method === "string" && !RpcMethodSchema.safeParse(method).success;
	return {
		id,
		outcome: {
			ok: false,
			error: unknownMethod
				? {
						code: "INTERNAL",
						message: `The editor tab does not know the method "${String(method)}" (tab and sidecar versions differ?).`,
					}
				: { code: "INVALID_PARAMS", message: `Malformed rpc frame: ${error}` },
		},
	};
}

export function createRpcDispatcher({
	getHandler,
	whenHandlersReady,
	bindEditor,
	getStateVersion,
	sendEvent,
	timers,
	now,
}: {
	getHandler: (method: string) => UntypedTabHandler | undefined;
	/** Resolves once the handler modules are registered (never rejects). */
	whenHandlersReady: () => Promise<unknown>;
	/** The editor to serve, resolved fresh for every call. */
	bindEditor: () => EditorCore | null;
	getStateVersion: () => number;
	/** Sends a tab event on the current socket (dropped while disconnected). */
	sendEvent: (event: TabEventMessage) => void;
	timers: BridgeTimers;
	now: () => number;
}): RpcDispatcher {
	const inflight = new Set<AbortController>();
	const outcomes = new Map<
		string,
		{ outcome: Promise<RpcOutcome>; at: number }
	>();
	const progressSentAt = new Map<string, { at: number; phase: string }>();

	function reportProgress({
		method,
		report,
	}: {
		method: TabMethod;
		report: TabProgressReport;
	}): void {
		const phase = report.phase ?? "running";
		const progress = clamp01(report.progress);
		const last = progressSentAt.get(report.jobId);
		const at = now();
		const throttled =
			last !== undefined &&
			last.phase === phase &&
			progress < 1 &&
			at - last.at < PROGRESS_THROTTLE_MS;
		if (throttled) return;
		if (progress >= 1) progressSentAt.delete(report.jobId);
		else progressSentAt.set(report.jobId, { at, phase });
		sendEvent({
			type: "event",
			name: "job-progress",
			payload: {
				jobId: report.jobId,
				kind: report.kind ?? defaultProgressKind(method),
				phase,
				progress,
				...(report.message === undefined ? {} : { message: report.message }),
			},
		});
	}

	async function run(message: RpcMessage): Promise<RpcOutcome> {
		const controller = new AbortController();
		inflight.add(controller);
		const timeout =
			message.timeoutMs === undefined
				? null
				: timers.schedule({
						callback: () => controller.abort(),
						delayMs: message.timeoutMs,
					});
		try {
			await whenHandlersReady();
			const editor = bindEditor();
			if (!editor) {
				throw new BridgeError({
					code: "INTERNAL",
					message: "The editor core is not available in this tab.",
				});
			}
			if (typeof message.projectId === "string") {
				const openId = editor.project.getActiveOrNull()?.metadata.id ?? null;
				if (openId !== message.projectId) {
					throw new BridgeError({
						code: "PROJECT_MISMATCH",
						message: openId
							? `Project "${openId}" is open in the editor tab, not "${message.projectId}".`
							: `No project is open in the editor tab (expected "${message.projectId}").`,
						details: { expected: message.projectId, open: openId },
					});
				}
			}
			const method = message.method;
			if (!isTabMethod(method)) {
				throw new BridgeError({
					code: "INTERNAL",
					message: `"${method}" is handled by the sidecar, not by the editor tab.`,
				});
			}
			const handler = getHandler(method);
			if (!handler) {
				throw new BridgeError({
					code: "INTERNAL",
					message: `The editor tab has no handler for "${method}" yet.`,
				});
			}
			const input = parseParams({ method, params: message.params });
			const ctx: TabHandlerContext = {
				editor,
				signal: controller.signal,
				method,
				reportProgress: (report) => reportProgress({ method, report }),
				emit: sendEvent,
				getStateVersion,
			};
			const result = await handler(input, ctx);
			const checked = ToolResultSchema.safeParse(result ?? {});
			if (!checked.success) {
				throw new BridgeError({
					code: "INTERNAL",
					message: `The "${method}" handler returned an invalid result: ${formatIssues(checked.error.issues)}`,
				});
			}
			return { ok: true, result: checked.data };
		} catch (error) {
			return { ok: false, error: toBridgeErrorPayload(error) };
		} finally {
			if (timeout !== null) timers.cancel(timeout);
			inflight.delete(controller);
		}
	}

	function dropExpired(at: number): void {
		for (const [entryKey, entry] of outcomes) {
			if (at - entry.at > IDEMPOTENCY_TTL_MS) outcomes.delete(entryKey);
		}
	}

	function remember({
		key,
		outcome,
	}: {
		key: string;
		outcome: Promise<RpcOutcome>;
	}): void {
		const at = now();
		dropExpired(at);
		while (outcomes.size >= IDEMPOTENCY_MAX_ENTRIES) {
			const oldest = outcomes.keys().next().value;
			if (oldest === undefined) break;
			outcomes.delete(oldest);
		}
		outcomes.set(key, { outcome, at });
	}

	return {
		dispatch({ message, respond }) {
			dropExpired(now());
			const key =
				message.idempotencyKey && !READ_ONLY_METHODS.has(message.method)
					? `${message.method}:${message.idempotencyKey}`
					: null;
			const cached = key ? outcomes.get(key) : undefined;
			let outcome: Promise<RpcOutcome>;
			if (key && cached && now() - cached.at <= IDEMPOTENCY_TTL_MS) {
				outcome = cached.outcome;
			} else {
				outcome = run(message);
				if (key) remember({ key, outcome });
			}
			void outcome.then(respond);
		},
		abortAll() {
			for (const controller of inflight) controller.abort();
			inflight.clear();
		},
	};
}
