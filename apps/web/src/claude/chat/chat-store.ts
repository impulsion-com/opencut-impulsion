import { z } from "zod";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
	CHAT_MODELS,
	CHAT_PROFILES,
	DEFAULT_CHAT_MODEL,
	type ChatEventMessage,
	type ChatModelId,
	type ChatProfile,
	type ChatEvent,
	type RateLimitInfo,
	type TabMessage,
} from "@opencut/claude-tools";
import type { BridgeRole, BridgeStatus } from "@/claude/bridge/client";
import type { BridgeTimers } from "@/claude/bridge/environment";
import {
	appendUserMessage,
	applyChatEvent,
	createConversation,
	forceStop,
	fromPersistedConversation,
	markDisconnected,
	markStopRequested,
	resolvePermission,
	toPersistedConversation,
	type Conversation,
} from "./chat-model";

// The chat panel's zustand store, as a factory so tests can drive it with a fake bridge and storage (the app's
// singleton lives in use-chat.ts). Conversations are keyed by sessionKey (the active project id, or "global").
// localStorage copies are written at discrete moments (a message sent, a session starting, a turn ending),
// never on every streamed delta. Every tab receives the chat events, but only the active tab can send, so only
// its copy holds the user's messages: what the sidecar streams is written by the active tab alone.

/** The slice of the bridge client the chat needs (claudeBridge satisfies it). */
export interface ChatBridge {
	getStatus(): BridgeStatus;
	subscribeStatus(callback: (status: BridgeStatus) => void): () => void;
	send(message: TabMessage): boolean;
	onChatEvent(callback: (message: ChatEventMessage) => void): () => void;
}

/** localStorage behind try/catch: reads may return null and writes may silently fail. */
export interface ChatStorage {
	read(key: string): string | null;
	write(options: { key: string; value: string }): void;
	remove(key: string): void;
}

export interface ChatStoreDeps {
	bridge: ChatBridge;
	storage: ChatStorage;
	timers: BridgeTimers;
	now: () => number;
}

export interface ChatState {
	conversations: Readonly<Record<string, Conversation>>;
	model: ChatModelId;
	profile: ChatProfile;
	/** Mirrors claudeBridge.getStatus(). */
	bridgeStatus: BridgeStatus;
	/** The socket closed at least once since it was last open (tells "offline" from "first connection"). */
	bridgeFailed: boolean;
	/** Last rate_limit info from any conversation (the quota is account-wide). */
	rateLimit: RateLimitInfo | null;
	/** When rateLimit arrived (epoch ms), to word its reset time. */
	rateLimitAt: number;
	/** The conversation the panel showed last (kept here: the panel unmounts while a project loads). */
	panelKey: string | null;
	/** A conversation the panel keeps showing although another project is open (see resolvePanelKey). */
	pinnedKey: string | null;

	/** Starts following the bridge (chat events and status). Idempotent; returns the detach function. */
	attachBridge(): () => void;
	/** Stops following the bridge; true when it was attached. */
	detachBridge(): boolean;
	/** Reads the model and profile choice from localStorage. */
	loadPreferences(): void;
	setModel(model: ChatModelId): void;
	setProfile(profile: ChatProfile): void;
	/** Loads the stored copy of a conversation the first time it is shown. */
	ensureConversation(sessionKey: string): void;
	/** Sends a user message; false (and nothing recorded) when it could not go out. */
	send(options: { sessionKey: string; text: string }): boolean;
	interrupt(sessionKey: string): void;
	/** "Nouvelle conversation": resets the sidecar session and clears the history. */
	reset(sessionKey: string): void;
	respondPermission(options: {
		sessionKey: string;
		requestId: string;
		allow: boolean;
	}): boolean;
	/** Applies one hub chat.event (wired by attachBridge; public for tests). */
	receive(message: ChatEventMessage): void;
	/** Follows a bridge status change (wired by attachBridge; public for tests). */
	setBridgeStatus(status: BridgeStatus): void;
	/** The panel reports the conversation it shows (resolvePanelKey) for the open project's key. */
	notePanelShown(options: { shownKey: string; projectKey: string }): void;
	/** "Voir la conversation de ce projet": the panel follows the open project again. */
	unpinPanel(projectKey: string): void;
}

export type ChatStore = StoreApi<ChatState>;

export const CONVERSATION_STORAGE_PREFIX = "opencut.claude.chat.v1:";
export const PREFERENCES_STORAGE_KEY = "opencut.claude.chat.prefs.v1";
/** How long Stop waits for the sidecar's turn_end before ending the turn on the panel side. */
export const STOP_FALLBACK_MS = 8_000;

export const STOP_UNREACHABLE_NOTICE =
	"Arrêt local : le sidecar est injoignable.";
export const STOP_TIMEOUT_NOTICE =
	"Le sidecar n'a pas confirmé l'arrêt : réponse interrompue côté panneau.";
const PERMISSION_DENIED_NOTE =
	"L'utilisateur a refusé cette action depuis le panneau.";

/** Events after which the conversation is written to localStorage (never the streamed deltas). */
const PERSIST_AFTER: ReadonlySet<ChatEvent["type"]> = new Set([
	"session",
	"turn_end",
	"error",
]);

const PreferencesSchema = z.object({
	model: z.string().optional(),
	profile: z.enum(CHAT_PROFILES).optional(),
});

export function isChatModelId(value: string): value is ChatModelId {
	return CHAT_MODELS.some((model) => model.id === value);
}

/**
 * The conversation the panel shows for the open project's key. A turn still running when the open project
 * changed (Claude's create_project or open_project, or the user switching) keeps its conversation on screen,
 * pinned, so its answer stays visible and a follow-up reaches the Claude session that has the context. The pin
 * holds until the user comes back to that project or asks for the project's own thread (unpinPanel).
 */
export function resolvePanelKey({
	projectKey,
	state,
}: {
	projectKey: string;
	state: Pick<ChatState, "panelKey" | "pinnedKey" | "conversations">;
}): string {
	if (state.pinnedKey !== null) return state.pinnedKey;
	const { panelKey } = state;
	if (
		panelKey !== null &&
		panelKey !== projectKey &&
		state.conversations[panelKey]?.running
	)
		return panelKey;
	return projectKey;
}

export function conversationStorageKey(sessionKey: string): string {
	return `${CONVERSATION_STORAGE_PREFIX}${sessionKey}`;
}

function parseJson(raw: string | null): unknown {
	if (raw === null) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

export function createChatStore({
	bridge,
	storage,
	timers,
	now,
}: ChatStoreDeps): ChatStore {
	let detach: (() => void) | null = null;
	const stopTimers = new Map<string, unknown>();
	/** The tab's last known role (the status drops it to null while disconnected). */
	let lastRole: BridgeRole | null = bridge.getStatus().role;

	function cancelStopTimer(sessionKey: string): void {
		const handle = stopTimers.get(sessionKey);
		if (handle === undefined) return;
		timers.cancel(handle);
		stopTimers.delete(sessionKey);
	}

	function loadConversation(sessionKey: string): Conversation {
		const stored = fromPersistedConversation(
			parseJson(storage.read(conversationStorageKey(sessionKey))),
		);
		return stored ?? createConversation();
	}

	function persist({
		sessionKey,
		conversation,
	}: {
		sessionKey: string;
		conversation: Conversation;
	}): void {
		const empty =
			conversation.items.length === 0 &&
			conversation.sessionId === null &&
			!conversation.resetPending;
		if (empty) {
			storage.remove(conversationStorageKey(sessionKey));
			return;
		}
		try {
			storage.write({
				key: conversationStorageKey(sessionKey),
				value: JSON.stringify(toPersistedConversation(conversation)),
			});
		} catch {
			// A tool input or summary that cannot be serialised: keep the in-memory copy only.
		}
	}

	function persistPreferences({
		model,
		profile,
	}: {
		model: ChatModelId;
		profile: ChatProfile;
	}): void {
		storage.write({
			key: PREFERENCES_STORAGE_KEY,
			value: JSON.stringify({ model, profile }),
		});
	}

	return createStore<ChatState>()((set, get) => {
		function getConversation(sessionKey: string): Conversation {
			return get().conversations[sessionKey] ?? loadConversation(sessionKey);
		}

		function commit({
			sessionKey,
			conversation,
			save,
		}: {
			sessionKey: string;
			conversation: Conversation;
			save: boolean;
		}): void {
			if (!conversation.running || !conversation.stopRequested) {
				cancelStopTimer(sessionKey);
			}
			if (get().conversations[sessionKey] !== conversation) {
				set((state) => ({
					conversations: { ...state.conversations, [sessionKey]: conversation },
				}));
			}
			if (save) persist({ sessionKey, conversation });
		}

		function scheduleStopFallback(sessionKey: string): void {
			cancelStopTimer(sessionKey);
			const handle = timers.schedule({
				delayMs: STOP_FALLBACK_MS,
				callback: () => {
					stopTimers.delete(sessionKey);
					const conversation = get().conversations[sessionKey];
					if (!conversation?.running || !conversation.stopRequested) return;
					commit({
						sessionKey,
						conversation: forceStop({
							conversation,
							notice: STOP_TIMEOUT_NOTICE,
						}),
						save: true,
					});
				},
			});
			stopTimers.set(sessionKey, handle);
		}

		return {
			conversations: {},
			model: DEFAULT_CHAT_MODEL,
			profile: "A",
			bridgeStatus: bridge.getStatus(),
			bridgeFailed: false,
			rateLimit: null,
			rateLimitAt: 0,
			panelKey: null,
			pinnedKey: null,

			attachBridge() {
				if (detach) return detach;
				const offEvents = bridge.onChatEvent((message) =>
					get().receive(message),
				);
				const offStatus = bridge.subscribeStatus((status) =>
					get().setBridgeStatus(status),
				);
				// The initial status is taken as is: a "closed" before the first attempt is not a failure.
				set({ bridgeStatus: bridge.getStatus() });
				const current = () => {
					offEvents();
					offStatus();
					if (detach === current) detach = null;
				};
				detach = current;
				return current;
			},

			detachBridge() {
				if (!detach) return false;
				detach();
				return true;
			},

			loadPreferences() {
				const parsed = PreferencesSchema.safeParse(
					parseJson(storage.read(PREFERENCES_STORAGE_KEY)),
				);
				if (!parsed.success) return;
				const { model, profile } = parsed.data;
				set({
					...(model !== undefined && isChatModelId(model) ? { model } : {}),
					...(profile !== undefined ? { profile } : {}),
				});
			},

			setModel(model) {
				set({ model });
				persistPreferences({ model, profile: get().profile });
			},

			setProfile(profile) {
				set({ profile });
				persistPreferences({ model: get().model, profile });
			},

			ensureConversation(sessionKey) {
				if (get().conversations[sessionKey]) return;
				commit({
					sessionKey,
					conversation: loadConversation(sessionKey),
					save: false,
				});
			},

			send({ sessionKey, text }) {
				const trimmed = text.trim();
				if (trimmed.length === 0) return false;
				const conversation = getConversation(sessionKey);
				if (conversation.running) return false;
				const { model, profile } = get();

				if (conversation.resetPending) {
					if (!bridge.send({ type: "chat.reset", sessionKey })) return false;
				}
				const canResume =
					conversation.needsResume &&
					conversation.sessionId !== null &&
					(conversation.sessionProfile === null ||
						conversation.sessionProfile === profile);
				const sent = bridge.send({
					type: "chat.send",
					sessionKey,
					text: trimmed,
					model,
					profile,
					...(canResume && conversation.sessionId
						? { resumeSessionId: conversation.sessionId }
						: {}),
				});
				if (!sent) {
					if (conversation.resetPending) {
						commit({
							sessionKey,
							conversation: { ...conversation, resetPending: false },
							save: true,
						});
					}
					return false;
				}
				commit({
					sessionKey,
					conversation: {
						...appendUserMessage({ conversation, text: trimmed, now: now() }),
						needsResume: false,
						resetPending: false,
						lastProfile: profile,
					},
					save: true,
				});
				return true;
			},

			interrupt(sessionKey) {
				const conversation = get().conversations[sessionKey];
				if (!conversation?.running) return;
				if (bridge.send({ type: "chat.interrupt", sessionKey })) {
					commit({
						sessionKey,
						conversation: markStopRequested(conversation),
						save: false,
					});
					scheduleStopFallback(sessionKey);
					return;
				}
				commit({
					sessionKey,
					conversation: forceStop({
						conversation,
						notice: STOP_UNREACHABLE_NOTICE,
					}),
					save: true,
				});
			},

			reset(sessionKey) {
				cancelStopTimer(sessionKey);
				const delivered = bridge.send({ type: "chat.reset", sessionKey });
				commit({
					sessionKey,
					conversation: {
						...createConversation(),
						needsResume: false,
						resetPending: !delivered,
					},
					save: true,
				});
			},

			respondPermission({ sessionKey, requestId, allow }) {
				const conversation = get().conversations[sessionKey];
				if (!conversation) return false;
				const sent = bridge.send({
					type: "chat.permission_response",
					sessionKey,
					requestId,
					allow,
					...(allow ? {} : { message: PERMISSION_DENIED_NOTE }),
				});
				if (!sent) return false;
				commit({
					sessionKey,
					conversation: resolvePermission({ conversation, requestId, allow }),
					save: false,
				});
				return true;
			},

			receive({ sessionKey, event }) {
				if (event.type === "rate_limit") {
					set({ rateLimit: event.info, rateLimitAt: now() });
					return;
				}
				commit({
					sessionKey,
					conversation: applyChatEvent({
						conversation: getConversation(sessionKey),
						event,
					}),
					save:
						PERSIST_AFTER.has(event.type) &&
						get().bridgeStatus.role === "active",
				});
			},

			setBridgeStatus(status) {
				const previous = get().bridgeStatus;
				const lostConnection =
					previous.connection === "open" && status.connection !== "open";
				const becameActive = status.role === "active" && lastRole === "passive";
				if (status.role !== null) lastRole = status.role;
				if (becameActive) {
					// The other tab wrote while this one was passive: its stored copies hold the user's messages this
					// tab never saw. Idle conversations are reloaded before this tab writes over them.
					const reloaded: Record<string, Conversation> = {};
					for (const [sessionKey, conversation] of Object.entries(
						get().conversations,
					)) {
						reloaded[sessionKey] = conversation.running
							? conversation
							: loadConversation(sessionKey);
					}
					set({ conversations: reloaded });
				}
				set({
					bridgeStatus: status,
					bridgeFailed:
						status.connection === "open"
							? false
							: status.connection === "closed"
								? true
								: get().bridgeFailed,
				});
				if (!lostConnection) return;
				for (const [sessionKey, conversation] of Object.entries(
					get().conversations,
				)) {
					const next = markDisconnected(conversation);
					commit({
						sessionKey,
						conversation: next,
						save: conversation.running && previous.role === "active",
					});
				}
			},

			notePanelShown({ shownKey, projectKey }) {
				const pinnedKey = shownKey === projectKey ? null : shownKey;
				const state = get();
				if (state.panelKey === shownKey && state.pinnedKey === pinnedKey) return;
				set({ panelKey: shownKey, pinnedKey });
			},

			unpinPanel(projectKey) {
				set({ panelKey: projectKey, pinnedKey: null });
			},
		};
	});
}
