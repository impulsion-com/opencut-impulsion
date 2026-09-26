import { z } from "zod";
import {
	CHAT_PROFILES,
	ChatUsageSchema,
	type ChatEvent,
	type ChatEventOf,
	type ChatProfile,
} from "@opencut/claude-tools";

// The chat panel's rendered model: a flat, ordered list of items per conversation, built by folding the hub's
// ChatEvent stream (applyChatEvent) plus the user's own messages. Pure and framework-free so it can be tested
// without React, the bridge or the browser.

/** Rendered items kept per conversation in localStorage (older ones are dropped, images always). */
export const PERSISTED_ITEM_LIMIT = 100;

export const TOOL_STATUSES = [
	"running",
	"success",
	"error",
	"stopped",
] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

export const PERMISSION_STATUSES = [
	"pending",
	"allowed",
	"denied",
	"expired",
] as const;
export type PermissionStatus = (typeof PERMISSION_STATUSES)[number];

export type JobStatus = ChatEventOf<"job">["status"];
export const JOB_STATUSES = [
	"queued",
	"running",
	"done",
	"failed",
	"cancelled",
] as const satisfies readonly JobStatus[];

const ChatImageSchema = z.object({
	data: z.string().min(1),
	mimeType: z.enum(["image/jpeg", "image/png"]),
});
export type ChatImage = z.infer<typeof ChatImageSchema>;

const itemId = z.string().min(1);

export const ChatItemSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("user"),
		id: itemId,
		text: z.string(),
		createdAt: z.number(),
	}),
	/** Assistant prose, rendered as markdown. */
	z.object({
		kind: z.literal("text"),
		id: itemId,
		text: z.string(),
		streaming: z.boolean(),
	}),
	z.object({
		kind: z.literal("thinking"),
		id: itemId,
		text: z.string(),
		streaming: z.boolean(),
	}),
	z.object({
		kind: z.literal("tool"),
		id: itemId,
		toolUseId: z.string(),
		/** Bare tool name; null when a tool_end arrived without its tool_start. */
		name: z.string().nullable(),
		input: z.unknown().optional(),
		status: z.enum(TOOL_STATUSES),
		summary: z.string().optional(),
		image: ChatImageSchema.optional(),
		/** The result had an image that the persisted copy left out. */
		imageDropped: z.boolean().optional(),
	}),
	z.object({
		kind: z.literal("permission"),
		id: itemId,
		requestId: z.string(),
		toolName: z.string(),
		input: z.unknown().optional(),
		reason: z.string().optional(),
		status: z.enum(PERMISSION_STATUSES),
	}),
	z.object({
		kind: z.literal("job"),
		id: itemId,
		jobId: z.string(),
		jobKind: z.string(),
		status: z.enum(JOB_STATUSES),
		progress: z.number().min(0).max(1),
		phase: z.string().optional(),
		message: z.string().optional(),
	}),
	z.object({
		kind: z.literal("turn_end"),
		id: itemId,
		durationMs: z.number().min(0),
		/** This turn's cost: the session total minus the previous turn's total (see sessionCostUsd). */
		costUsd: z.number().min(0).optional(),
		/**
		 * The SDK's cost is the conversation's running total (it even survives a resume in a new process), so the
		 * raw value is kept to work out the next turn's own cost.
		 */
		sessionCostUsd: z.number().min(0).optional(),
		sessionId: z.string().optional(),
		usage: ChatUsageSchema.optional(),
	}),
	z.object({ kind: z.literal("error"), id: itemId, message: z.string() }),
	/** A local, panel-side note (e.g. the connection dropped mid-answer). */
	z.object({ kind: z.literal("notice"), id: itemId, text: z.string() }),
]);
export type ChatItem = z.infer<typeof ChatItemSchema>;
export type ChatItemKind = ChatItem["kind"];
export type ChatItemOf<K extends ChatItemKind> = Extract<ChatItem, { kind: K }>;

const ChatSessionInfoSchema = z.object({
	sessionId: z.string(),
	model: z.string(),
	apiKeySource: z.string(),
});
export type ChatSessionInfo = z.infer<typeof ChatSessionInfoSchema>;

export interface Conversation {
	items: readonly ChatItem[];
	/** Next item number; ids are "i<n>" and unique within the conversation. */
	seq: number;
	/** A turn is under way: the composer shows Stop instead of sending. */
	running: boolean;
	/** chat.interrupt was sent and the turn_end has not arrived yet. */
	stopRequested: boolean;
	/** From the last session event: which model and credentials the sidecar uses. */
	session: ChatSessionInfo | null;
	/** Agent SDK session id (session or turn_end), sent as resumeSessionId after a reload or a disconnect. */
	sessionId: string | null;
	/** Profile that owns sessionId: a session only resumes under the Claude profile that created it. */
	sessionProfile: ChatProfile | null;
	/** Profile of the last message sent; copied into sessionProfile when the session id arrives. */
	lastProfile: ChatProfile | null;
	/** No message was sent since the page loaded or the sidecar connection dropped. */
	needsResume: boolean;
	/** "Nouvelle conversation" could not reach the sidecar; chat.reset goes out before the next message. */
	resetPending: boolean;
}

export function createConversation(): Conversation {
	return {
		items: [],
		seq: 1,
		running: false,
		stopRequested: false,
		session: null,
		sessionId: null,
		sessionProfile: null,
		lastProfile: null,
		needsResume: true,
		resetPending: false,
	};
}

/** Frozen fallback for selectors, before a conversation has been loaded. */
export const EMPTY_CONVERSATION: Conversation = Object.freeze({
	...createConversation(),
	needsResume: false,
});

/** True when the panel should warn that the sidecar is billing an API key instead of the subscription. */
export function isApiKeyBilled(session: ChatSessionInfo | null): boolean {
	return session !== null && session.apiKeySource !== "none";
}

// ---------------------------------------------------------------------------
// Item helpers
// ---------------------------------------------------------------------------

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;
type NewItem = DistributiveOmit<ChatItem, "id">;

function pushItem({
	conversation,
	item,
}: {
	conversation: Conversation;
	item: NewItem;
}): Conversation {
	const withId: ChatItem = { ...item, id: `i${conversation.seq}` };
	return {
		...conversation,
		items: [...conversation.items, withId],
		seq: conversation.seq + 1,
	};
}

/** Replaces the items `update` changes; returns the same array (and conversation) when nothing changed. */
function mapItems({
	conversation,
	update,
}: {
	conversation: Conversation;
	update: (item: ChatItem) => ChatItem;
}): Conversation {
	let changed = false;
	const items = conversation.items.map((item) => {
		const next = update(item);
		if (next !== item) changed = true;
		return next;
	});
	return changed ? { ...conversation, items } : conversation;
}

function replaceAt({
	conversation,
	index,
	item,
}: {
	conversation: Conversation;
	index: number;
	item: ChatItem;
}): Conversation {
	const items = conversation.items.slice();
	items[index] = item;
	return { ...conversation, items };
}

function findLastIndex({
	items,
	predicate,
}: {
	items: readonly ChatItem[];
	predicate: (item: ChatItem) => boolean;
}): number {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item && predicate(item)) return index;
	}
	return -1;
}

function closeStreaming(conversation: Conversation): Conversation {
	return mapItems({
		conversation,
		update: (item) =>
			(item.kind === "text" || item.kind === "thinking") && item.streaming
				? { ...item, streaming: false }
				: item,
	});
}

/** Ends everything still open: streaming text, running tools and unanswered permission prompts. */
function settleOpenItems(conversation: Conversation): Conversation {
	return mapItems({
		conversation,
		update: (item) => {
			if (
				(item.kind === "text" || item.kind === "thinking") &&
				item.streaming
			) {
				return { ...item, streaming: false };
			}
			if (item.kind === "tool" && item.status === "running") {
				return { ...item, status: "stopped" };
			}
			if (item.kind === "permission" && item.status === "pending") {
				return { ...item, status: "expired" };
			}
			return item;
		},
	});
}

function appendDelta({
	conversation,
	kind,
	text,
}: {
	conversation: Conversation;
	kind: "text" | "thinking";
	text: string;
}): Conversation {
	const running = conversation.running
		? conversation
		: { ...conversation, running: true };
	const lastIndex = running.items.length - 1;
	const last = running.items[lastIndex];
	if (last && last.kind === kind && last.streaming) {
		return replaceAt({
			conversation: running,
			index: lastIndex,
			item: { ...last, text: last.text + text },
		});
	}
	if (text.length === 0) return running;
	return pushItem({
		conversation: closeStreaming(running),
		item: { kind, text, streaming: true },
	});
}

/** Running cost total of `sessionId` at its last turn in this thread, if known. */
function lastSessionCost({
	items,
	sessionId,
}: {
	items: readonly ChatItem[];
	sessionId: string;
}): number | undefined {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item?.kind === "turn_end" && item.sessionId === sessionId) {
			return item.sessionCostUsd;
		}
	}
	return undefined;
}

function withSessionId({
	conversation,
	sessionId,
}: {
	conversation: Conversation;
	sessionId: string;
}): Conversation {
	if (sessionId.length === 0) return conversation;
	return {
		...conversation,
		sessionId,
		sessionProfile: conversation.lastProfile ?? conversation.sessionProfile,
	};
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Folds one hub event into the conversation. Tolerant of order: a tool_end without its tool_start, a repeated
 * permission_request or deltas after a turn_end all produce something sensible. rate_limit is account-wide and
 * handled by the store, so it leaves the conversation unchanged.
 */
export function applyChatEvent({
	conversation,
	event,
}: {
	conversation: Conversation;
	event: ChatEvent;
}): Conversation {
	switch (event.type) {
		case "session":
			return withSessionId({
				conversation: {
					...conversation,
					session: {
						sessionId: event.sessionId,
						model: event.model,
						apiKeySource: event.apiKeySource,
					},
				},
				sessionId: event.sessionId,
			});

		case "text_delta":
			return appendDelta({ conversation, kind: "text", text: event.text });

		case "thinking_delta":
			return appendDelta({ conversation, kind: "thinking", text: event.text });

		case "tool_start": {
			const base = closeStreaming(
				conversation.running
					? conversation
					: { ...conversation, running: true },
			);
			const index = findLastIndex({
				items: base.items,
				predicate: (item) =>
					item.kind === "tool" && item.toolUseId === event.toolUseId,
			});
			const existing = base.items[index];
			if (existing && existing.kind === "tool") {
				return replaceAt({
					conversation: base,
					index,
					item: { ...existing, name: event.name, input: event.input },
				});
			}
			return pushItem({
				conversation: base,
				item: {
					kind: "tool",
					toolUseId: event.toolUseId,
					name: event.name,
					input: event.input,
					status: "running",
				},
			});
		}

		case "tool_end": {
			const index = findLastIndex({
				items: conversation.items,
				predicate: (item) =>
					item.kind === "tool" && item.toolUseId === event.toolUseId,
			});
			const existing = conversation.items[index];
			const status: ToolStatus = event.ok ? "success" : "error";
			if (existing && existing.kind === "tool") {
				return replaceAt({
					conversation,
					index,
					item: {
						...existing,
						status,
						summary: event.summary ?? existing.summary,
						image: event.image ?? existing.image,
					},
				});
			}
			return pushItem({
				conversation: closeStreaming(conversation),
				item: {
					kind: "tool",
					toolUseId: event.toolUseId,
					name: null,
					status,
					summary: event.summary,
					image: event.image,
				},
			});
		}

		case "assistant_done":
			return closeStreaming(conversation);

		case "permission_request": {
			const shownAt = findLastIndex({
				items: conversation.items,
				predicate: (item) =>
					item.kind === "permission" && item.requestId === event.requestId,
			});
			const shown = conversation.items[shownAt];
			if (shown?.kind === "permission") {
				// Re-sent after a reload: the stored copy marked it expired, but the turn is still waiting on it.
				if (shown.status !== "expired") return conversation;
				return replaceAt({
					conversation: conversation.running
						? conversation
						: { ...conversation, running: true },
					index: shownAt,
					item: { ...shown, status: "pending", input: event.input },
				});
			}
			return pushItem({
				conversation: closeStreaming(
					conversation.running
						? conversation
						: { ...conversation, running: true },
				),
				item: {
					kind: "permission",
					requestId: event.requestId,
					toolName: event.toolName,
					input: event.input,
					reason: event.reason,
					status: "pending",
				},
			});
		}

		case "job": {
			const index = findLastIndex({
				items: conversation.items,
				predicate: (item) => item.kind === "job" && item.jobId === event.jobId,
			});
			const existing = conversation.items[index];
			const fields = {
				jobKind: event.kind,
				status: event.status,
				progress: event.progress,
				phase: event.phase,
				message: event.message,
			};
			if (existing && existing.kind === "job") {
				return replaceAt({
					conversation,
					index,
					item: { ...existing, ...fields },
				});
			}
			return pushItem({
				conversation,
				item: { kind: "job", jobId: event.jobId, ...fields },
			});
		}

		case "turn_end": {
			const previousTotal = lastSessionCost({
				items: conversation.items,
				sessionId: event.sessionId,
			});
			const costUsd =
				event.costUsd === undefined
					? undefined
					: previousTotal !== undefined && event.costUsd >= previousTotal
						? event.costUsd - previousTotal
						: event.costUsd;
			const settled = withSessionId({
				conversation: {
					...settleOpenItems(conversation),
					running: false,
					stopRequested: false,
				},
				sessionId: event.sessionId,
			});
			return pushItem({
				conversation: settled,
				item: {
					kind: "turn_end",
					durationMs: event.durationMs,
					costUsd,
					sessionCostUsd: event.costUsd,
					sessionId: event.sessionId,
					usage: event.usage,
				},
			});
		}

		case "rate_limit":
			return conversation;

		case "error":
			return pushItem({
				conversation: {
					...settleOpenItems(conversation),
					running: false,
					stopRequested: false,
				},
				item: { kind: "error", message: event.message },
			});
	}
}

// ---------------------------------------------------------------------------
// Local transitions (user actions, connection)
// ---------------------------------------------------------------------------

export function appendUserMessage({
	conversation,
	text,
	now,
}: {
	conversation: Conversation;
	text: string;
	now: number;
}): Conversation {
	return pushItem({
		conversation: {
			...closeStreaming(conversation),
			running: true,
			stopRequested: false,
		},
		item: { kind: "user", text, createdAt: now },
	});
}

export function markStopRequested(conversation: Conversation): Conversation {
	if (!conversation.running || conversation.stopRequested) return conversation;
	return { ...conversation, stopRequested: true };
}

/** Ends the turn on the panel side only (the sidecar is unreachable or never confirmed), with a note. */
export function forceStop({
	conversation,
	notice,
}: {
	conversation: Conversation;
	notice: string;
}): Conversation {
	return pushItem({
		conversation: {
			...settleOpenItems(conversation),
			running: false,
			stopRequested: false,
		},
		item: { kind: "notice", text: notice },
	});
}

export function resolvePermission({
	conversation,
	requestId,
	allow,
}: {
	conversation: Conversation;
	requestId: string;
	allow: boolean;
}): Conversation {
	return mapItems({
		conversation,
		update: (item) =>
			item.kind === "permission" &&
			item.requestId === requestId &&
			item.status === "pending"
				? { ...item, status: allow ? "allowed" : "denied" }
				: item,
	});
}

export const DISCONNECTED_NOTICE =
	"Connexion au sidecar perdue : le panneau ne suit plus la réponse en cours, qui peut continuer côté sidecar.";

/** The socket to the sidecar closed: the next message must offer the session for resume. */
export function markDisconnected(conversation: Conversation): Conversation {
	const flagged = conversation.needsResume
		? conversation
		: { ...conversation, needsResume: true };
	if (!flagged.running) return flagged;
	return forceStop({ conversation: flagged, notice: DISCONNECTED_NOTICE });
}

// ---------------------------------------------------------------------------
// Persistence (localStorage copies: last PERSISTED_ITEM_LIMIT items, no images, no tool inputs)
// ---------------------------------------------------------------------------

const PersistedConversationSchema = z.object({
	version: z.literal(1),
	items: z.array(z.unknown()),
	seq: z.number().int().min(1),
	session: ChatSessionInfoSchema.nullable(),
	sessionId: z.string().nullable(),
	sessionProfile: z.enum(CHAT_PROFILES).nullable(),
	resetPending: z.boolean(),
});
export type PersistedConversation = z.infer<typeof PersistedConversationSchema>;

function toPersistedItem(item: ChatItem): ChatItem {
	if (item.kind === "tool") {
		const { image, input: _input, ...rest } = item;
		return image ? { ...rest, imageDropped: true } : rest;
	}
	if (item.kind === "permission") {
		const { input: _input, ...rest } = item;
		return rest;
	}
	return item;
}

export function toPersistedConversation(
	conversation: Conversation,
): PersistedConversation {
	return {
		version: 1,
		items: conversation.items
			.slice(-PERSISTED_ITEM_LIMIT)
			.map((item) => toPersistedItem(item)),
		seq: conversation.seq,
		session: conversation.session,
		sessionId: conversation.sessionId,
		sessionProfile: conversation.sessionProfile,
		resetPending: conversation.resetPending,
	};
}

/**
 * Rebuilds a conversation from a stored copy. Items that no longer parse are skipped; anything that was still
 * open when it was saved (streaming text, a running tool, a pending permission) is closed, since the turn cannot
 * continue after a reload. Returns null when the copy is unusable.
 */
export function fromPersistedConversation(raw: unknown): Conversation | null {
	const parsed = PersistedConversationSchema.safeParse(raw);
	if (!parsed.success) return null;
	const stored = parsed.data;
	const items: ChatItem[] = [];
	for (const candidate of stored.items) {
		const item = ChatItemSchema.safeParse(candidate);
		if (item.success) items.push(item.data);
	}
	const highestId = items.reduce((max, item) => {
		const number = Number.parseInt(item.id.slice(1), 10);
		return Number.isFinite(number) ? Math.max(max, number) : max;
	}, 0);
	return settleOpenItems({
		...createConversation(),
		items,
		seq: Math.max(stored.seq, highestId + 1),
		session: stored.session,
		sessionId: stored.sessionId,
		sessionProfile: stored.sessionProfile,
		resetPending: stored.resetPending,
	});
}
