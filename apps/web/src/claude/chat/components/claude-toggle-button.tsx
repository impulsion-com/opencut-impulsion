"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { AiChat02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePanelStore } from "@/editor/panel-store";
import { cn } from "@/utils/ui";
import type { ConnectionView } from "../format";
import { toggleClaudePanel } from "../panel-toggle-store";
import { useChat, useConnectionView } from "../use-chat";

const DOT: Record<ConnectionView, string> = {
	active: "bg-constructive",
	passive: "bg-caution",
	offline: "bg-muted-foreground/60",
	connecting: "bg-muted-foreground/60",
};

/** Header button (EditorHeader's Claude slot) that shows or hides the Claude column. */
export function ClaudeToggleButton() {
	const isOpen = usePanelStore((state) => !state.claudeCollapsed);
	const view = useConnectionView();
	const isWorking = useChat((state) =>
		Object.values(state.conversations).some(
			(conversation) => conversation.running,
		),
	);
	const tooltip = isOpen
		? "Masquer le panneau Claude"
		: "Ouvrir le panneau Claude";

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant={isOpen ? "secondary" : "ghost"}
					size="sm"
					className="h-8 gap-1.5 px-2.5 text-[0.875rem]"
					aria-pressed={isOpen}
					aria-label={tooltip}
					onClick={toggleClaudePanel}
				>
					<span className="relative flex">
						<HugeiconsIcon icon={AiChat02Icon} className="!size-4" />
						<span
							className={cn(
								"ring-background absolute -top-0.5 -right-0.5 size-1.5 rounded-full ring-2",
								DOT[view],
								isWorking && "animate-pulse",
							)}
						/>
					</span>
					Claude
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom" className="text-xs">
				{tooltip}
			</TooltipContent>
		</Tooltip>
	);
}
