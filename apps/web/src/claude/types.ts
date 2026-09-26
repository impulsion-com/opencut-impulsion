import {
	ERROR_CODES,
	formatIssues,
	type BridgeErrorPayload,
	type ErrorCode,
	type InternalMethod,
	type InternalMethodParams,
	type TabEventMessage,
	type TabToolName,
	type ToolImage,
	type ToolInput,
	type ToolName,
	type ToolResult,
} from "@opencut/claude-tools";
import type { z } from "zod";
import type { EditorCore } from "@/core";

// Shared types for the tab side of the Claude bridge. Handlers (apps/web/src/claude/**) are typed against the
// contract in @opencut/claude-tools: the client validates params with the method's schema, then calls the handler.

/** Methods the tab can receive: tab tools (forwarded unchanged by the hub) and internal methods. Never hybrid tools. */
export type TabMethod = TabToolName | InternalMethod;

/** Parsed params a handler receives for method N (after zod parsing). */
export type TabMethodInput<N extends ToolName | InternalMethod> =
	N extends ToolName
		? ToolInput<N>
		: N extends InternalMethod
			? InternalMethodParams<N>
			: never;

export interface TabProgressReport {
	jobId: string;
	/** 0..1, clamped. */
	progress: number;
	message?: string;
	/** Defaults to "import" for internal.import_files, "export" for internal.export_start, else the method name. */
	kind?: string;
	/** Free-form step, e.g. "copying", "probing". Defaults to "running". */
	phase?: string;
}

export interface TabHandlerContext {
	/** Resolved fresh for every call with EditorCore.getInstance() (survives HMR). */
	readonly editor: EditorCore;
	/** Aborted when the hub's timeoutMs elapses or the bridge stops: skip stale work. */
	readonly signal?: AbortSignal;
	/** The RPC method being served. */
	readonly method: TabMethod;
	/** Sends a throttled "job-progress" event (for tab-side work that is not an export). */
	reportProgress(report: TabProgressReport): void;
	/** Sends any tab event right away (e.g. "export-progress"). Dropped while disconnected. */
	emit(event: TabEventMessage): void;
	/** Current stateVersion (same value as getStateVersion() from the bridge client). */
	getStateVersion(): number;
}

export type TabHandler<N extends ToolName | InternalMethod> = (
	input: TabMethodInput<N>,
	ctx: TabHandlerContext,
) => Promise<ToolResult>;

/** What each handler module exports and passes to registerTabHandlers. */
export type TabHandlerMap = { readonly [N in TabMethod]?: TabHandler<N> };

/** Registry storage type: the client validated `input` against the method's schema before calling. */
export type UntypedTabHandler = (
	input: unknown,
	ctx: TabHandlerContext,
) => Promise<ToolResult>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Model-facing defaults (English, like the contract); the sidecar appends ERROR_HINTS[code]. */
const DEFAULT_ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
	EDITOR_NOT_CONNECTED: "No editor tab is connected.",
	NO_PROJECT: "No project is open in the editor (or it is still loading).",
	PROJECT_MISMATCH: "Another project is open in the editor tab.",
	USER_INTERACTING: "The user is dragging or scrubbing in the timeline.",
	EXPORTING: "An export is running; edits are refused until it ends.",
	INVALID_PARAMS: "Invalid parameters.",
	INVALID_EDIT: "The timeline refused the edit. Nothing was applied.",
	NOT_FOUND: "Not found.",
	STALE_STATE:
		"The timeline changed since the given stateVersion. Nothing was applied.",
	TIMEOUT: "The call was cancelled because it took too long.",
	CONNECTION_LOST: "The connection to the sidecar was lost.",
	BUSY: "The editor is busy with another operation.",
	INTERNAL: "Unexpected editor error.",
};

export interface BridgeErrorInit {
	code: ErrorCode;
	/** Model-facing, English. Defaults to a short sentence per code. */
	message?: string;
	/** JSON-safe extra data (ids, issues...). */
	details?: unknown;
}

/**
 * Throw it from handlers: the client replies with its code, message and details.
 * `new BridgeError({ code: "NOT_FOUND", message: 'Element "e9" does not exist.', details: { elementId: "e9" } })`
 */
export class BridgeError extends Error {
	readonly code: ErrorCode;
	readonly details?: unknown;

	constructor({ code, message, details }: BridgeErrorInit) {
		super(message ?? DEFAULT_ERROR_MESSAGES[code]);
		this.name = "BridgeError";
		this.code = code;
		this.details = details;
	}

	toPayload(): BridgeErrorPayload {
		return {
			code: this.code,
			message: this.message,
			...(this.details === undefined ? {} : { details: this.details }),
		};
	}
}

const ERROR_CODE_SET = new Set<string>(ERROR_CODES);

/** Duck-typed on purpose: after an HMR update, errors thrown by old modules come from an older class. */
export function isBridgeError(error: unknown): error is BridgeError {
	if (error instanceof BridgeError) return true;
	if (
		!(error instanceof Error) ||
		error.name !== "BridgeError" ||
		!("code" in error)
	)
		return false;
	return typeof error.code === "string" && ERROR_CODE_SET.has(error.code);
}

function isZodLikeError(
	error: unknown,
): error is Error & { issues: readonly z.core.$ZodIssue[] } {
	return (
		error instanceof Error &&
		error.name === "ZodError" &&
		"issues" in error &&
		Array.isArray(error.issues)
	);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/** Maps anything a handler throws to the wire error: BridgeError keeps its code, zod errors become INVALID_PARAMS. */
export function toBridgeErrorPayload(error: unknown): BridgeErrorPayload {
	if (isBridgeError(error)) {
		return {
			code: error.code,
			message: error.message,
			...(error.details === undefined ? {} : { details: error.details }),
		};
	}
	if (isZodLikeError(error)) {
		const issues = error.issues.slice(0, 20);
		return {
			code: "INVALID_PARAMS",
			message: formatIssues(issues),
			details: {
				issues: issues.map((issue) => ({
					path: issue.path.map(String),
					message: issue.message,
					...(issue.code ? { code: issue.code } : {}),
				})),
			},
		};
	}
	if (isAbortError(error)) {
		return { code: "TIMEOUT", message: DEFAULT_ERROR_MESSAGES.TIMEOUT };
	}
	if (error instanceof Error) {
		return { code: "INTERNAL", message: error.message || error.name };
	}
	return {
		code: "INTERNAL",
		message:
			typeof error === "string" ? error : DEFAULT_ERROR_MESSAGES.INTERNAL,
	};
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/** The usual result: JSON only (the sidecar sends it as compact JSON text). */
export function jsonResult(json: unknown): ToolResult {
	return { json };
}

export function textResult(text: string): ToolResult {
	return { text };
}

/** Any combination of JSON, text and images, omitting what is undefined. */
export function toolResult({
	json,
	text,
	images,
}: {
	json?: unknown;
	text?: string;
	images?: readonly ToolImage[];
}): ToolResult {
	return {
		...(json === undefined ? {} : { json }),
		...(text === undefined ? {} : { text }),
		...(images === undefined ? {} : { images: images.map(normalizeImage) }),
	};
}

const DATA_URL_PATTERN = /^data:image\/(jpeg|png);base64,/;

function mimeTypeOf(subtype: string | undefined): ToolImage["mimeType"] {
	return subtype === "png" ? "image/png" : "image/jpeg";
}

/** Accepts raw base64 or a canvas data URL ("data:image/jpeg;base64,..."); the prefix is stripped. */
function normalizeImage(image: ToolImage): ToolImage {
	const match = DATA_URL_PATTERN.exec(image.data);
	if (!match) return image;
	return {
		...image,
		data: image.data.slice(match[0].length),
		mimeType: mimeTypeOf(match[1]),
	};
}

/** One or more images (JPEG or PNG), each followed by its caption, plus optional JSON and text. */
export function imageResult({
	images,
	json,
	text,
}: {
	images: ToolImage | readonly ToolImage[];
	json?: unknown;
	text?: string;
}): ToolResult {
	const list: readonly ToolImage[] = "data" in images ? [images] : images;
	return toolResult({ images: list, json, text });
}

/** Converts canvas.toDataURL("image/jpeg" | "image/png") output. Throws INTERNAL for any other data URL. */
export function toolImageFromDataUrl({
	dataUrl,
	caption,
}: {
	dataUrl: string;
	caption?: string;
}): ToolImage {
	const match = DATA_URL_PATTERN.exec(dataUrl);
	if (!match || dataUrl.length === match[0].length) {
		throw new BridgeError({
			code: "INTERNAL",
			message: "Expected a base64 JPEG or PNG data URL.",
		});
	}
	return {
		data: dataUrl.slice(match[0].length),
		mimeType: mimeTypeOf(match[1]),
		...(caption === undefined ? {} : { caption }),
	};
}
