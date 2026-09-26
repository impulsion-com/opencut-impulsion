"use client";

import { useEffect } from "react";
import { chatStore, useConnectionView, usePanelSessionKey } from "../use-chat";
import { ChatComposer } from "./chat-composer";
import { ChatHeader, ChatNotices } from "./chat-header";
import { ChatMessages } from "./chat-messages";

/**
 * The Claude column of the editor (4th ResizablePanel of EditorLayout). A docked panel rather than a
 * Sheet/Dialog on purpose: overlays raise overlayDepth, which switches every editor shortcut off.
 * One conversation per project (sessionKey = project id); a conversation whose turn was running when the
 * project changed stays on screen until the user switches (usePanelSessionKey).
 */
export function ClaudeChatPanel() {
	const { sessionKey, projectKey } = usePanelSessionKey();
	const view = useConnectionView();

	useEffect(() => {
		chatStore.getState().ensureConversation(sessionKey);
	}, [sessionKey]);

	return (
		<div className="panel bg-background flex h-full min-w-0 flex-col overflow-hidden rounded-sm border">
			<ChatHeader sessionKey={sessionKey} view={view} />
			<ChatNotices sessionKey={sessionKey} projectKey={projectKey} view={view} />
			<ChatMessages
				sessionKey={sessionKey}
				canSend={view === "active"}
				canAnswer={view === "active" || view === "passive"}
			/>
			<ChatComposer key={sessionKey} sessionKey={sessionKey} view={view} />
		</div>
	);
}
