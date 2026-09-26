import {
	ERROR_CODES,
	formatIssues,
	type BridgeErrorPayload,
	type ErrorCode,
} from "@opencut/claude-tools";
import { ZodError } from "zod";

// Errors thrown by sidecar code and by hub calls. The code is one of the contract's ERROR_CODES, so the MCP
// layer can append ERROR_HINTS; messages are English (model-facing), like the rest of the tool contract.

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
	EDITOR_NOT_CONNECTED: "No editor tab is connected to the sidecar.",
	NO_PROJECT: "No project is open in the editor.",
	PROJECT_MISMATCH: "A different project is open in the editor tab.",
	USER_INTERACTING: "The user is interacting with the timeline.",
	EXPORTING: "An export is running.",
	INVALID_PARAMS: "Invalid parameters.",
	INVALID_EDIT: "The edit was refused. Nothing was applied.",
	NOT_FOUND: "Not found.",
	STALE_STATE: "The timeline changed since the given stateVersion.",
	TIMEOUT: "The editor did not answer in time.",
	CONNECTION_LOST: "The editor tab disconnected during the call.",
	BUSY: "The editor is busy.",
	INTERNAL: "Unexpected error.",
};

export class BridgeError extends Error {
	readonly code: ErrorCode;
	readonly details?: unknown;

	constructor({
		code,
		message,
		details,
	}: {
		code: ErrorCode;
		message?: string;
		details?: unknown;
	}) {
		super(message ?? DEFAULT_MESSAGES[code]);
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

export function isErrorCode(value: unknown): value is ErrorCode {
	return (
		typeof value === "string" &&
		(ERROR_CODES as readonly string[]).includes(value)
	);
}

/** Rebuilds a BridgeError from a wire payload (rpc-result error). */
export function bridgeErrorFromPayload(
	payload: BridgeErrorPayload,
): BridgeError {
	return new BridgeError({
		code: payload.code,
		message: payload.message,
		details: payload.details,
	});
}

/** Any thrown value to a BridgeError: BridgeErrors pass through, zod errors become INVALID_PARAMS. */
export function toBridgeError(error: unknown): BridgeError {
	if (error instanceof BridgeError) return error;
	if (error instanceof ZodError) {
		return new BridgeError({
			code: "INVALID_PARAMS",
			message: formatIssues(error.issues),
			details: { issues: error.issues.slice(0, 20) },
		});
	}
	if (error instanceof Error && error.name === "AbortError") {
		return new BridgeError({
			code: "TIMEOUT",
			message: "The call was cancelled before it finished.",
		});
	}
	const message = error instanceof Error ? error.message : String(error);
	return new BridgeError({
		code: "INTERNAL",
		message: message || DEFAULT_MESSAGES.INTERNAL,
	});
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
