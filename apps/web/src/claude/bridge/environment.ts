// What the bridge client needs from its environment, as small interfaces: tests pass fakes, the browser
// singleton uses the defaults below. Nothing here runs at import time.

export interface BridgeSocketEvents {
	onOpen(): void;
	onMessage(data: unknown): void;
	onClose(): void;
}

export interface BridgeSocket {
	send(data: string): void;
	close(): void;
	isOpen(): boolean;
}

export type CreateBridgeSocket = (options: {
	url: string;
	events: BridgeSocketEvents;
}) => BridgeSocket;

export interface BridgeTimers {
	schedule(options: { callback: () => void; delayMs: number }): unknown;
	cancel(handle: unknown): void;
}

const TAB_ID_STORAGE_KEY = "opencut.claude.tabId";
const ROLE_STORAGE_KEY = "opencut.claude.role";

/** The tab's last role from the hub, kept across reloads, HMR and sidecar restarts. */
export interface BridgeRoleMemory {
	read(): "active" | "passive" | null;
	write(role: "active" | "passive"): void;
}

export const sessionRoleMemory: BridgeRoleMemory = {
	read() {
		try {
			const value = window.sessionStorage.getItem(ROLE_STORAGE_KEY);
			return value === "active" || value === "passive" ? value : null;
		} catch {
			return null;
		}
	},
	write(role) {
		try {
			window.sessionStorage.setItem(ROLE_STORAGE_KEY, role);
		} catch {
			// Blocked storage: the tab then behaves like a newly opened one on its next connection.
		}
	},
};

export function isDocumentVisible(): boolean {
	return (
		typeof document === "undefined" || document.visibilityState === "visible"
	);
}

/** True in a top-level browser tab only. */
export const isBrowserEnvironment = (): boolean =>
	typeof window !== "undefined" &&
	typeof WebSocket !== "undefined" &&
	isTopLevelWindow();

/**
 * A framed copy of the editor (any site can embed localhost:3456, and its Origin is ours) must never connect:
 * its hello would take the active role away from the real tab.
 */
function isTopLevelWindow(): boolean {
	try {
		return window.self === window.top;
	} catch {
		// Browsers that throw on a cross-origin top: framed.
		return false;
	}
}

export function createBrowserSocket({
	url,
	events,
}: {
	url: string;
	events: BridgeSocketEvents;
}): BridgeSocket {
	const socket = new WebSocket(url);
	socket.onopen = () => events.onOpen();
	socket.onmessage = (event) => events.onMessage(event.data);
	socket.onclose = () => events.onClose();
	return {
		send: (data) => socket.send(data),
		close: () => socket.close(1000, "tab closing bridge"),
		isOpen: () => socket.readyState === WebSocket.OPEN,
	};
}

export const browserTimers: BridgeTimers = {
	schedule: ({ callback, delayMs }) => setTimeout(callback, delayMs),
	// The handle always comes from schedule() above.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function randomId(): string {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Random per tab, kept in sessionStorage so a reload of the same tab keeps its id. */
export function getSessionTabId(): string {
	try {
		const existing = window.sessionStorage.getItem(TAB_ID_STORAGE_KEY);
		if (existing) return existing;
		const created = randomId();
		window.sessionStorage.setItem(TAB_ID_STORAGE_KEY, created);
		return created;
	} catch {
		return randomId();
	}
}

export function getBrowserPath(): string {
	return typeof window === "undefined" ? "" : window.location.pathname;
}
