import { useEffect } from "react";
import { useStore } from "zustand";
import { claudeBridge } from "@/claude/bridge/client";
import { browserTimers } from "@/claude/bridge/environment";
import { useEditor } from "@/editor/use-editor";
import {
	createChatStore,
	resolvePanelKey,
	type ChatState,
	type ChatStorage,
	type ChatStore,
} from "./chat-store";
import { EMPTY_CONVERSATION, type Conversation } from "./chat-model";
import { getConnectionView, type ConnectionView } from "./format";

// The app's chat store (one per tab) and the hooks the panel components use.

/** localStorage with every access behind try/catch (private windows, blocked site data, quota). */
export const browserChatStorage: ChatStorage = {
	read(key) {
		try {
			return window.localStorage.getItem(key);
		} catch {
			return null;
		}
	},
	write({ key, value }) {
		try {
			window.localStorage.setItem(key, value);
		} catch {
			// Quota or blocked storage: the conversation still lives in memory.
		}
	},
	remove(key) {
		try {
			window.localStorage.removeItem(key);
		} catch {
			// Nothing to clean up.
		}
	},
};

export const chatStore: ChatStore = createChatStore({
	bridge: claudeBridge,
	storage: browserChatStorage,
	timers: browserTimers,
	now: () => Date.now(),
});

// HMR re-evaluates this module: detach the previous store from the bridge and carry its conversations over,
// so a code edit neither duplicates chat events nor wipes the thread on screen.
const GLOBAL_KEY = "__opencutClaudeChat";

function isChatStore(value: unknown): value is ChatStore {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "getState") === "function" &&
		typeof Reflect.get(value, "setState") === "function"
	);
}

const previousStore: unknown = Reflect.get(globalThis, GLOBAL_KEY);
Reflect.set(globalThis, GLOBAL_KEY, chatStore);
if (isChatStore(previousStore) && previousStore !== chatStore) {
	try {
		const previous = previousStore.getState();
		previous.detachBridge();
		chatStore.setState({
			conversations: previous.conversations,
			model: previous.model,
			profile: previous.profile,
			rateLimit: previous.rateLimit,
			rateLimitAt: previous.rateLimitAt,
			bridgeFailed: previous.bridgeFailed,
		});
	} catch (error) {
		console.warn("[claude] could not hand the chat over after HMR", error);
	}
}

if (typeof window !== "undefined") {
	chatStore.getState().loadPreferences();
	// Kept for the page's lifetime: a turn that finishes while the panel is collapsed, or while the user is on
	// /projects, still lands in its conversation.
	chatStore.getState().attachBridge();
}

export function useChat<T>(selector: (state: ChatState) => T): T {
	return useStore(chatStore, selector);
}

/** The chat thread key: the open project's id, or "global" outside a project. */
export function useChatSessionKey(): string {
	const projectId = useEditor(
		(editor) => editor.project.getActiveOrNull()?.metadata.id ?? null,
	);
	return projectId ?? "global";
}

/**
 * The conversation the panel shows and the open project's key: they differ while a conversation whose turn was
 * running when the project changed stays pinned on screen (resolvePanelKey).
 */
export function usePanelSessionKey(): {
	sessionKey: string;
	projectKey: string;
} {
	const projectKey = useChatSessionKey();
	const sessionKey = useChat((state) => resolvePanelKey({ projectKey, state }));
	useEffect(() => {
		chatStore.getState().notePanelShown({ shownKey: sessionKey, projectKey });
	}, [sessionKey, projectKey]);
	return { sessionKey, projectKey };
}

export function useConversation(sessionKey: string): Conversation {
	return useChat(
		(state) => state.conversations[sessionKey] ?? EMPTY_CONVERSATION,
	);
}

export function useConnectionView(): ConnectionView {
	return useChat((state) =>
		getConnectionView({
			status: state.bridgeStatus,
			failed: state.bridgeFailed,
		}),
	);
}
