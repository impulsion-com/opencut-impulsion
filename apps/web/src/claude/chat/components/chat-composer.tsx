"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { SentIcon, StopIcon, Undo02Icon } from "@hugeicons/core-free-icons";
import { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ConnectionView } from "../format";
import { chatStore, useConversation } from "../use-chat";

const PLACEHOLDERS: Record<ConnectionView, string> = {
	active: "Demande une modification à Claude…",
	passive: "Onglet passif : pilote l'éditeur depuis cet onglet pour écrire.",
	offline: "Sidecar hors ligne.",
	connecting: "Connexion au sidecar…",
};

// The textarea is a typable element, so the editor's keybinding and paste listeners ignore keys typed in it
// (isTypableDOMElement in utils/browser.ts); only Escape blurs it. Keyed by sessionKey in the panel, so each
// project starts with an empty draft.
export function ChatComposer({
	sessionKey,
	view,
}: {
	sessionKey: string;
	view: ConnectionView;
}) {
	const conversation = useConversation(sessionKey);
	const canUndo = useEditor((editor) => editor.command.canUndo());
	const [draft, setDraft] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const enabled = view === "active";
	const { running, stopRequested } = conversation;
	const canSubmit = enabled && !running && draft.trim().length > 0;

	const submit = () => {
		if (!canSubmit) return;
		const sent = chatStore.getState().send({ sessionKey, text: draft });
		if (!sent) {
			toast.error("Message non envoyé : le sidecar est injoignable.");
			return;
		}
		setDraft("");
		textareaRef.current?.focus();
	};

	const undoLastEdit = () => {
		const editor = EditorCore.getInstance();
		if (editor.command.canUndo()) editor.command.undo();
	};

	return (
		<div className="flex shrink-0 flex-col gap-1.5 border-t p-2">
			<Textarea
				ref={textareaRef}
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={(event) => {
					if (
						event.key === "Enter" &&
						!event.shiftKey &&
						!event.nativeEvent.isComposing
					) {
						event.preventDefault();
						submit();
					}
				}}
				disabled={!enabled}
				placeholder={PLACEHOLDERS[view]}
				aria-label="Message pour Claude"
				rows={2}
				style={{ fieldSizing: "content" }}
				className="max-h-40 min-h-[3.75rem] px-2.5 py-2 text-[13px] leading-relaxed md:text-[13px]"
			/>
			<div className="flex items-center justify-between gap-2">
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className="text-muted-foreground hover:text-foreground h-7 gap-1.5 px-2 text-xs"
							disabled={!canUndo}
							onClick={undoLastEdit}
						>
							<HugeiconsIcon icon={Undo02Icon} className="!size-3.5" />
							Annuler la dernière modif
						</Button>
					</TooltipTrigger>
					<TooltipContent side="top" className="text-xs">
						{
							"Comme Cmd+Z : annule la dernière étape de l'historique, de Claude ou la tienne"
						}
					</TooltipContent>
				</Tooltip>
				{running ? (
					<Button
						size="sm"
						variant="destructive-foreground"
						className="h-7 gap-1.5 text-xs"
						disabled={stopRequested}
						onClick={() => chatStore.getState().interrupt(sessionKey)}
					>
						<HugeiconsIcon icon={StopIcon} className="!size-3.5" />
						{stopRequested ? "Arrêt…" : "Stop"}
					</Button>
				) : (
					<Button
						size="sm"
						className="h-7 gap-1.5 text-xs"
						disabled={!canSubmit}
						onClick={submit}
					>
						<HugeiconsIcon icon={SentIcon} className="!size-3.5" />
						Envoyer
					</Button>
				)}
			</div>
		</div>
	);
}
