import { z } from "zod";
import {
	EntityIdSchema,
	EXPORT_FORMATS,
	EXPORT_QUALITIES,
	TimeSecondsSchema,
} from "./common";
import { ToolResultSchema } from "./define";
import { TRACK_KEYWORDS } from "./edit-plan";
import { TOOL_NAMES, type ToolName } from "./tools";

// WebSocket protocol between the editor tab and the sidecar hub (one socket, ws://127.0.0.1:3457/editor).
// Both ends parse every message with these schemas: parseTabMessage on the hub, parseHubMessage in the tab.

export const PROTOCOL_VERSION = 1;

export const BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_PORT = 3457;
export const EDITOR_WS_PATH = "/editor";
/** The only origin the hub accepts (WebSockets bypass CORS, so the hub must check it). */
export const EDITOR_ORIGIN = "http://localhost:3456";
/** Origin of the sidecar's HTTP routes. The tab only ever fetches from, or uploads to, this origin. */
export const BRIDGE_ORIGIN = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
/** GET: serves an allow-listed disk file (Range supported) for the tab to import. */
export const BRIDGE_FILES_PATH = "/files";
/** POST: receives a rendered export and writes it to the exports folder. */
export const BRIDGE_EXPORTS_PATH = "/exports";

/** True when `value` is an absolute URL on BRIDGE_ORIGIN under `path` (the route itself or a sub-path). */
export function isBridgeUrl(value: string, path: string): boolean {
	try {
		const url = new URL(value);
		return url.origin === BRIDGE_ORIGIN && (url.pathname === path || url.pathname.startsWith(`${path}/`));
	} catch {
		return false;
	}
}

/**
 * A URL the hub asks the tab to fetch or POST to. Restricted to the sidecar's own route so that whatever holds
 * the hub port (e.g. another process while the bridge is down) cannot make the tab read or upload elsewhere.
 */
const bridgeRouteUrl = (path: string) =>
	z.string().min(1).refine((value) => isBridgeUrl(value, path), {
		message: `must be a ${BRIDGE_ORIGIN}${path} URL`,
	});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
	"EDITOR_NOT_CONNECTED",
	"NO_PROJECT",
	"PROJECT_MISMATCH",
	"USER_INTERACTING",
	"EXPORTING",
	"INVALID_PARAMS",
	"INVALID_EDIT",
	"NOT_FOUND",
	"STALE_STATE",
	"TIMEOUT",
	"CONNECTION_LOST",
	"BUSY",
	"INTERNAL",
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Model-facing remedy appended to tool errors by the bridge. English, like the rest of the tool contract. */
export const ERROR_HINTS: Readonly<Record<ErrorCode, string>> = {
	EDITOR_NOT_CONNECTED:
		"No editor tab is connected. Ask the user to open http://localhost:3456 in Chrome, then retry.",
	NO_PROJECT:
		"No project is open (or it is still loading). Use list_projects then open_project, or create_project.",
	PROJECT_MISMATCH:
		"A different project is open in the editor tab than the one this call was meant for. Call get_editor_state to see which project is open.",
	USER_INTERACTING:
		"The user is dragging or scrubbing. Wait a moment and retry once.",
	EXPORTING:
		"An export is running and edits are refused. Wait for job_status to finish or cancel_job.",
	INVALID_PARAMS:
		"The parameters do not match the tool schema. Fix the fields named in the message.",
	INVALID_EDIT:
		"The timeline refused the edit (overlap, incompatible track, out of range). Nothing was applied. Re-read the state and adjust.",
	NOT_FOUND:
		"An id does not exist (ids change after split, undo and redo). Call get_editor_state and use current ids.",
	STALE_STATE:
		"The timeline changed since the stateVersion you passed (the user or another call edited it). Nothing was applied. Call get_editor_state, check your plan still fits, then retry with the new stateVersion.",
	TIMEOUT:
		"The editor did not answer in time; the call may still have been applied. Call get_editor_state before retrying.",
	CONNECTION_LOST:
		"The editor tab disconnected or reloaded while running this call: it may or may not have been applied. Call get_editor_state (list_projects for project tools) before retrying.",
	BUSY: "The editor is busy with another operation. Retry in a few seconds.",
	INTERNAL: "Unexpected editor error. Report the message to the user.",
};

export const BridgeErrorSchema = z.object({
	code: ErrorCodeSchema,
	message: z.string(),
	details: z.unknown().optional(),
});
export type BridgeErrorPayload = z.infer<typeof BridgeErrorSchema>;

// ---------------------------------------------------------------------------
// Internal RPC methods (hub -> tab, not exposed to Claude)
// ---------------------------------------------------------------------------

/** One disk file the sidecar serves over HTTP for the tab to fetch. */
export const ImportFileSchema = z.object({
	/** Absolute disk path (the sidecar keeps the mediaId -> path index). */
	path: z.string().min(1),
	/** http://127.0.0.1:3457/files?... URL the tab fetches the bytes from (nothing else is accepted). */
	url: bridgeRouteUrl(BRIDGE_FILES_PATH),
	name: z.string().min(1),
	size: z.number().int().min(0),
	mimeType: z.string().min(1),
	lastModified: z.number().optional(),
});

export const INTERNAL_METHOD_PARAMS = {
	/** Liveness check. Result json: {ok: true}. */
	"internal.ping": z.object({}),
	/** import_media, tab half. Result json: {imported:[{path, mediaId, name, type, duration?, width?, height?}], elementIds?, skipped:[{path, reason}]}. */
	"internal.import_files": z.object({
		/** Set by the sidecar so the tab can report "job-progress" events for a long copy. */
		jobId: z.string().min(1).optional(),
		files: z.array(ImportFileSchema).min(1),
		place: z
			.object({
				start: TimeSecondsSchema.optional(),
				track: z.union([z.enum(TRACK_KEYWORDS), EntityIdSchema]).optional(),
			})
			.optional(),
	}),
	/**
	 * start_export, tab half. The tab acks at once (result json {accepted: true}), renders, POSTs the file
	 * to uploadUrl, and reports through "export-progress" events.
	 */
	"internal.export_start": z.object({
		jobId: z.string().min(1),
		format: z.enum(EXPORT_FORMATS),
		quality: z.enum(EXPORT_QUALITIES),
		includeAudio: z.boolean(),
		fileName: z.string().min(1),
		/** http://127.0.0.1:3457/exports... URL the tab POSTs the file to (nothing else is accepted). */
		uploadUrl: bridgeRouteUrl(BRIDGE_EXPORTS_PATH),
	}),
	/** cancel_job for an export. Result json: {cancelled: boolean}. */
	"internal.export_cancel": z.object({ jobId: z.string().min(1) }),
} as const;

export type InternalMethod = keyof typeof INTERNAL_METHOD_PARAMS;
export type InternalMethodParams<M extends InternalMethod> = z.infer<
	(typeof INTERNAL_METHOD_PARAMS)[M]
>;
export const INTERNAL_METHODS = Object.keys(INTERNAL_METHOD_PARAMS) as [
	InternalMethod,
	...InternalMethod[],
];

export type RpcMethod = ToolName | InternalMethod;
export const RpcMethodSchema = z.union([
	z.enum(TOOL_NAMES as [ToolName, ...ToolName[]]),
	z.enum(INTERNAL_METHODS),
]);

export function isInternalMethod(method: string): method is InternalMethod {
	return Object.prototype.hasOwnProperty.call(INTERNAL_METHOD_PARAMS, method);
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export const CHAT_PROFILES = ["A", "B"] as const;
export type ChatProfile = (typeof CHAT_PROFILES)[number];

/** Models offered in the chat panel (see map 8.6). The first one is the default. */
export const CHAT_MODELS = [
	{ id: "claude-opus-5", label: "Opus 5" },
	{ id: "claude-sonnet-5", label: "Sonnet 5" },
	{ id: "claude-haiku-4-5", label: "Haiku 4.5" },
	{ id: "claude-opus-5-5", label: "Opus 5.5" },
	{ id: "claude-fable-5-1", label: "Fable 5.1" },
] as const;
export const DEFAULT_CHAT_MODEL = "claude-opus-5";

export const ChatAttachmentSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("image"),
		/** Base64 without the data: prefix. */
		data: z.string().min(1),
		mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
		name: z.string().optional(),
	}),
	z.object({
		type: z.literal("text"),
		name: z.string().min(1),
		text: z.string(),
	}),
]);
export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>;

export const ChatUsageSchema = z.object({
	inputTokens: z.number().int().min(0),
	outputTokens: z.number().int().min(0),
	cacheReadTokens: z.number().int().min(0).optional(),
	cacheCreationTokens: z.number().int().min(0).optional(),
});
export type ChatUsage = z.infer<typeof ChatUsageSchema>;

/** Subset of the Agent SDK rate_limit_event info; unknown fields pass through. */
export const RateLimitInfoSchema = z.looseObject({
	status: z.string().optional(),
	/** Epoch seconds. */
	resetsAt: z.number().optional(),
	rateLimitType: z.string().optional(),
	utilization: z.number().optional(),
});
export type RateLimitInfo = z.infer<typeof RateLimitInfoSchema>;

/**
 * UI-oriented projection of the Agent SDK stream. The sidecar maps SDKMessage to these so the web app
 * never depends on SDK types.
 */
export const ChatEventSchema = z.discriminatedUnion("type", [
	/** First event of a query: which session, model and credentials are in use (warn if apiKeySource !== "none"). */
	z.object({
		type: z.literal("session"),
		sessionId: z.string(),
		model: z.string(),
		apiKeySource: z.string(),
	}),
	z.object({ type: z.literal("text_delta"), text: z.string() }),
	z.object({ type: z.literal("thinking_delta"), text: z.string() }),
	/** A tool call began. `name` is the bare tool name (the mcp__opencut__ prefix is stripped). */
	z.object({
		type: z.literal("tool_start"),
		toolUseId: z.string(),
		name: z.string(),
		input: z.unknown(),
	}),
	z.object({
		type: z.literal("tool_end"),
		toolUseId: z.string(),
		ok: z.boolean(),
		/** One-line outcome for the status chip. */
		summary: z.string().optional(),
		/** First image of the result (e.g. a captured frame), for a thumbnail. */
		image: z
			.object({
				data: z.string().min(1),
				mimeType: z.enum(["image/jpeg", "image/png"]),
			})
			.optional(),
	}),
	/** The current assistant message is complete (more may follow after tool calls). */
	z.object({ type: z.literal("assistant_done") }),
	/** The whole turn is over; keep sessionId to resume. */
	z.object({
		type: z.literal("turn_end"),
		sessionId: z.string(),
		durationMs: z.number().min(0),
		usage: ChatUsageSchema.optional(),
		costUsd: z.number().min(0).optional(),
	}),
	/**
	 * canUseTool asks before a destructive tool runs (e.g. remove_media). The panel answers with
	 * chat.permission_response; the tool waits until then.
	 */
	z.object({
		type: z.literal("permission_request"),
		requestId: z.string().min(1),
		/** Bare tool name, like tool_start. */
		toolName: z.string(),
		input: z.unknown(),
		/** One-line French explanation for the prompt, when the sidecar has one. */
		reason: z.string().optional(),
	}),
	/** Progress of a background job started from this chat (export, long import...). */
	z.object({
		type: z.literal("job"),
		jobId: z.string().min(1),
		kind: z.string(),
		status: z.enum(["queued", "running", "done", "failed", "cancelled"]),
		/** 0..1 */
		progress: z.number().min(0).max(1),
		phase: z.string().optional(),
		message: z.string().optional(),
	}),
	z.object({ type: z.literal("rate_limit"), info: RateLimitInfoSchema }),
	z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ChatEvent = z.infer<typeof ChatEventSchema>;
export type ChatEventType = ChatEvent["type"];
export type ChatEventOf<K extends ChatEventType> = Extract<ChatEvent, { type: K }>;

// ---------------------------------------------------------------------------
// Tab -> hub
// ---------------------------------------------------------------------------

export const HelloMessageSchema = z.object({
	type: z.literal("hello"),
	protocolVersion: z.number().int(),
	/** Random id per tab load. */
	tabId: z.string().min(1),
	/** location.pathname, e.g. "/editor/<id>" or "/projects". */
	path: z.string(),
	projectId: z.string().nullable(),
	appVersion: z.string(),
});

export const RpcResultMessageSchema = z.discriminatedUnion("ok", [
	z.object({
		type: z.literal("rpc-result"),
		id: z.string().min(1),
		ok: z.literal(true),
		result: ToolResultSchema,
	}),
	z.object({
		type: z.literal("rpc-result"),
		id: z.string().min(1),
		ok: z.literal(false),
		error: BridgeErrorSchema,
	}),
]);

export const TAB_EVENT_NAMES = ["state-changed", "project-changed", "export-progress", "job-progress"] as const;
export type TabEventName = (typeof TAB_EVENT_NAMES)[number];

export const EXPORT_PHASES = ["rendering", "uploading", "done", "failed", "cancelled"] as const;
export type ExportPhase = (typeof EXPORT_PHASES)[number];

export const TabEventMessageSchema = z.discriminatedUnion("name", [
	/** Any timeline/project change, manual or not; `version` increases monotonically per tab. */
	z.object({
		type: z.literal("event"),
		name: z.literal("state-changed"),
		payload: z.object({
			version: z.number().int().min(0),
			projectId: z.string().nullable(),
		}),
	}),
	/** Another project was opened or closed in the tab. */
	z.object({
		type: z.literal("event"),
		name: z.literal("project-changed"),
		payload: z.object({
			projectId: z.string().nullable(),
			name: z.string().nullable(),
			path: z.string(),
		}),
	}),
	z.object({
		type: z.literal("event"),
		name: z.literal("export-progress"),
		payload: z.object({
			jobId: z.string().min(1),
			phase: z.enum(EXPORT_PHASES),
			/** 0..1 */
			progress: z.number().min(0).max(1),
			error: z.string().optional(),
		}),
	}),
	/** Progress of tab-side work that is not an export, e.g. copying big rushes during import_media. */
	z.object({
		type: z.literal("event"),
		name: z.literal("job-progress"),
		payload: z.object({
			jobId: z.string().min(1),
			/** e.g. "import". */
			kind: z.string().min(1),
			/** Free-form step, e.g. "copying", "probing". */
			phase: z.string(),
			/** 0..1 */
			progress: z.number().min(0).max(1),
			message: z.string().optional(),
		}),
	}),
]);

export const ChatSendMessageSchema = z.object({
	type: z.literal("chat.send"),
	/** Chat thread key chosen by the panel (e.g. per project). */
	sessionKey: z.string().min(1),
	text: z.string(),
	model: z.string().min(1).optional(),
	profile: z.enum(CHAT_PROFILES).optional(),
	/**
	 * Agent SDK session id from an earlier turn_end, to resume that conversation when the sidecar no longer has a
	 * live session for sessionKey (e.g. after a restart). Ignored while a live session exists.
	 */
	resumeSessionId: z.string().min(1).optional(),
	attachments: z.array(ChatAttachmentSchema).max(10).optional(),
});

/** Answer to a permission_request chat event. */
export const ChatPermissionResponseMessageSchema = z.object({
	type: z.literal("chat.permission_response"),
	sessionKey: z.string().min(1),
	requestId: z.string().min(1),
	allow: z.boolean(),
	/** Optional note passed back to Claude when refusing. */
	message: z.string().optional(),
});

/** A passive tab asks to drive the editor tools again (the user clicked "take control" in it). */
export const ClaimActiveMessageSchema = z.object({
	type: z.literal("claim-active"),
});

export const ChatInterruptMessageSchema = z.object({
	type: z.literal("chat.interrupt"),
	sessionKey: z.string().min(1),
});

export const ChatResetMessageSchema = z.object({
	type: z.literal("chat.reset"),
	sessionKey: z.string().min(1),
});

export const TabMessageSchema = z.discriminatedUnion("type", [
	HelloMessageSchema,
	RpcResultMessageSchema,
	TabEventMessageSchema,
	ChatSendMessageSchema,
	ChatInterruptMessageSchema,
	ChatResetMessageSchema,
	ChatPermissionResponseMessageSchema,
	ClaimActiveMessageSchema,
]);
export type TabMessage = z.infer<typeof TabMessageSchema>;
export type TabMessageType = TabMessage["type"];
export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type RpcResultMessage = z.infer<typeof RpcResultMessageSchema>;
export type TabEventMessage = z.infer<typeof TabEventMessageSchema>;
export type TabEventOf<N extends TabEventName> = Extract<TabEventMessage, { name: N }>;
export type ChatSendMessage = z.infer<typeof ChatSendMessageSchema>;
export type ChatInterruptMessage = z.infer<typeof ChatInterruptMessageSchema>;
export type ChatResetMessage = z.infer<typeof ChatResetMessageSchema>;
export type ChatPermissionResponseMessage = z.infer<typeof ChatPermissionResponseMessageSchema>;
export type ClaimActiveMessage = z.infer<typeof ClaimActiveMessageSchema>;

// ---------------------------------------------------------------------------
// Hub -> tab
// ---------------------------------------------------------------------------

/** Sent after hello, and again whenever the tab's role changes (the latest tab becomes active). */
export const WelcomeMessageSchema = z.object({
	type: z.literal("welcome"),
	protocolVersion: z.number().int(),
	role: z.enum(["active", "passive"]),
	sidecarVersion: z.string(),
	/** The tab that drives the editor tools (this one when role is "active"), so a passive tab can say which. */
	activeTab: z
		.object({
			tabId: z.string().min(1),
			projectId: z.string().nullable(),
			projectName: z.string().nullable(),
			path: z.string(),
		})
		.nullable(),
});

export const RpcMessageSchema = z.object({
	type: z.literal("rpc"),
	id: z.string().min(1),
	method: RpcMethodSchema,
	/** Raw params; the tab validates them with the tool's input schema (or INTERNAL_METHOD_PARAMS). */
	params: z.unknown(),
	/** When set, the tab answers PROJECT_MISMATCH if another project is open. */
	projectId: z.string().nullable().optional(),
	/** How long the hub waits before failing with TIMEOUT, so the tab can skip stale work. */
	timeoutMs: z.number().int().positive().optional(),
	/**
	 * Set by the hub, one per Claude tool call, and re-sent unchanged if the hub re-delivers the call after the tab
	 * reconnects. The tab remembers the results of recent keys (a few minutes) and answers a repeat with the first
	 * result instead of applying the edit twice. In-flight calls on a socket that closes fail with CONNECTION_LOST.
	 */
	idempotencyKey: z.string().min(1).max(200).optional(),
});

export const ChatEventMessageSchema = z.object({
	type: z.literal("chat.event"),
	sessionKey: z.string().min(1),
	event: ChatEventSchema,
});

export const HubMessageSchema = z.discriminatedUnion("type", [
	WelcomeMessageSchema,
	RpcMessageSchema,
	ChatEventMessageSchema,
]);
export type HubMessage = z.infer<typeof HubMessageSchema>;
export type HubMessageType = HubMessage["type"];
export type WelcomeMessage = z.infer<typeof WelcomeMessageSchema>;
export type RpcMessage = z.infer<typeof RpcMessageSchema>;
export type ChatEventMessage = z.infer<typeof ChatEventMessageSchema>;

// ---------------------------------------------------------------------------
// Parsing helpers (JSON text in, typed message or error out)
// ---------------------------------------------------------------------------

export type ParseMessageResult<T> =
	| { ok: true; message: T }
	| { ok: false; error: string };

function parseWith<T>(schema: z.ZodType<T>, raw: unknown): ParseMessageResult<T> {
	let value: unknown = raw;
	if (typeof raw === "string") {
		try {
			value = JSON.parse(raw);
		} catch {
			return { ok: false, error: "invalid JSON" };
		}
	}
	const result = schema.safeParse(value);
	if (result.success) return { ok: true, message: result.data };
	const first = result.error.issues[0];
	const where = first && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
	return { ok: false, error: `${where}${first?.message ?? "invalid message"}` };
}

/** Hub side: parse a frame received from the tab (JSON string or already-parsed value). */
export function parseTabMessage(raw: unknown): ParseMessageResult<TabMessage> {
	return parseWith(TabMessageSchema, raw);
}

/** Tab side: parse a frame received from the hub (JSON string or already-parsed value). */
export function parseHubMessage(raw: unknown): ParseMessageResult<HubMessage> {
	return parseWith(HubMessageSchema, raw);
}

/** Serialises a message after validating it (throws on a malformed message: a programming error). */
export function encodeTabMessage(message: TabMessage): string {
	return JSON.stringify(TabMessageSchema.parse(message));
}

export function encodeHubMessage(message: HubMessage): string {
	return JSON.stringify(HubMessageSchema.parse(message));
}
