"use client";

import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { AiChat02Icon } from "@hugeicons/core-free-icons";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/utils/ui";
import { chatStore, useConversation } from "../use-chat";
import { ChatItemView } from "./chat-items";

export const CHAT_SUGGESTIONS = [
	"Montre-moi la timeline",
	"Coupe les silences de plus de 2 s",
	"Ajoute un titre d'accroche",
	"Exporte en MP4",
] as const;

/** Distance from the bottom (px) under which new content keeps the list scrolled to the end. */
const STICK_THRESHOLD_PX = 48;

export function ChatMessages({
	sessionKey,
	canSend,
	canAnswer,
}: {
	sessionKey: string;
	/** Connected and driving the editor: suggestions can be sent. */
	canSend: boolean;
	/** The sidecar is reachable: permission prompts can be answered. */
	canAnswer: boolean;
}) {
	const conversation = useConversation(sessionKey);
	const scrollRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);
	// Last scrollTop seen (ours or the user's): only a move UP means the user left the bottom.
	const lastTopRef = useRef(0);

	const scrollToEnd = useCallback(() => {
		const element = scrollRef.current;
		if (!element) return;
		element.scrollTop = element.scrollHeight;
		lastTopRef.current = element.scrollTop;
	}, []);

	// Follow the stream (text, thumbnails loading, progress bars) while the user is at the bottom.
	useEffect(() => {
		const content = contentRef.current;
		if (!content || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			if (stickRef.current && content.dataset.empty !== "true") scrollToEnd();
		});
		observer.observe(content);
		return () => observer.disconnect();
	}, [scrollToEnd]);

	// A new thread (project switch, new conversation) starts at the bottom.
	useEffect(() => {
		stickRef.current = true;
		scrollToEnd();
	}, [sessionKey, scrollToEnd]);

	const isEmpty = conversation.items.length === 0;
	// The empty state reads from the top when the column is short.
	useEffect(() => {
		if (isEmpty && scrollRef.current) {
			scrollRef.current.scrollTop = 0;
			lastTopRef.current = 0;
		}
	}, [isEmpty]);

	// The scroll event of our own scrollToEnd arrives a frame later, possibly after more content (a chip, a
	// thumbnail) made the list taller: judging by the distance alone would then unstick it. Content growth never
	// unsticks; scrolling up does, and coming back near the bottom sticks again.
	const handleScroll = () => {
		const element = scrollRef.current;
		if (!element) return;
		const distance =
			element.scrollHeight - element.scrollTop - element.clientHeight;
		if (distance < STICK_THRESHOLD_PX) stickRef.current = true;
		else if (element.scrollTop < lastTopRef.current - 1)
			stickRef.current = false;
		lastTopRef.current = element.scrollTop;
	};

	const sendSuggestion = (text: string) => {
		const sent = chatStore.getState().send({ sessionKey, text });
		if (!sent) toast.error("Message non envoyé : le sidecar est injoignable.");
	};

	const { items, running, stopRequested } = conversation;
	const last = items[items.length - 1];
	const lastUserId = last?.kind === "user" ? last.id : null;

	// The user's own message always scrolls into view, even if they had scrolled up.
	useEffect(() => {
		if (lastUserId === null) return;
		stickRef.current = true;
		scrollToEnd();
	}, [lastUserId, scrollToEnd]);

	const awaitingAnswer = items.some(
		(item) => item.kind === "permission" && item.status === "pending",
	);
	// A streaming item or a running chip already shows that Claude is working.
	const lastShowsProgress =
		last !== undefined &&
		(((last.kind === "text" || last.kind === "thinking") && last.streaming) ||
			(last.kind === "tool" && last.status === "running"));
	const activity = !running
		? null
		: stopRequested
			? "Arrêt en cours…"
			: awaitingAnswer
				? "En attente de ta réponse"
				: lastShowsProgress
					? null
					: "Claude travaille…";

	return (
		<div
			ref={scrollRef}
			onScroll={handleScroll}
			className="min-h-0 flex-1 overflow-y-auto scrollbar-thin"
		>
			<div
				ref={contentRef}
				data-empty={isEmpty}
				className="flex min-h-full flex-col gap-2.5 p-3"
			>
				{isEmpty ? (
					<EmptyState canSend={canSend} onPick={sendSuggestion} />
				) : (
					items.map((item) => (
						<ChatItemView
							key={item.id}
							item={item}
							sessionKey={sessionKey}
							canAnswer={canAnswer}
						/>
					))
				)}
				{activity && (
					<div className="text-muted-foreground flex items-center gap-1.5 text-xs">
						{!awaitingAnswer && <Spinner className="size-3" />}
						<span>{activity}</span>
					</div>
				)}
			</div>
		</div>
	);
}

function EmptyState({
	canSend,
	onPick,
}: {
	canSend: boolean;
	onPick: (text: string) => void;
}) {
	return (
		<div className="my-auto flex flex-col items-center gap-3 px-1 py-2 text-center">
			<div className="flex flex-col items-center gap-1">
				<p className="flex items-center gap-1.5 text-sm font-medium">
					<HugeiconsIcon
						icon={AiChat02Icon}
						className="text-muted-foreground size-4"
					/>
					Monte avec Claude
				</p>
				<p className="text-muted-foreground text-xs text-balance">
					{
						"Claude lit la timeline, regarde les images et modifie le projet. Chaque modification s'annule d'un Cmd+Z."
					}
				</p>
			</div>
			<div className="flex flex-wrap justify-center gap-1.5">
				{CHAT_SUGGESTIONS.map((suggestion) => (
					<button
						key={suggestion}
						type="button"
						disabled={!canSend}
						onClick={() => onPick(suggestion)}
						className={cn(
							"bg-accent/60 hover:bg-accent rounded-full border px-2.5 py-1 text-xs transition-colors",
							"disabled:cursor-not-allowed disabled:opacity-50",
						)}
					>
						{suggestion}
					</button>
				))}
			</div>
		</div>
	);
}
