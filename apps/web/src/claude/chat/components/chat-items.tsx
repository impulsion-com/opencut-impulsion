"use client";

import { memo, useState } from "react";
import Image from "next/image";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Alert02Icon,
	AlertCircleIcon,
	ArrowRight01Icon,
	Brain02Icon,
	Clock01Icon,
	InformationCircleIcon,
	StopCircleIcon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { ReactMarkdownWrapper } from "@/components/ui/react-markdown-wrapper";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/utils/ui";
import type { ChatImage, ChatItem, ChatItemOf } from "../chat-model";
import { formatCostUsd, formatDuration } from "../format";
import {
	getJobKindLabel,
	getJobPhaseLabel,
	getToolLabel,
} from "../tool-labels";
import { chatStore } from "../use-chat";

// One component per rendered item kind. Items are immutable and replaced only when they change, so memo keeps
// a long thread cheap while the last text item streams.

const INPUT_PREVIEW_MAX = 600;

function previewInput(input: unknown): string | null {
	if (input === undefined || input === null) return null;
	try {
		const text = JSON.stringify(input, null, 2);
		if (!text || text === "{}") return null;
		return text.length > INPUT_PREVIEW_MAX
			? `${text.slice(0, INPUT_PREVIEW_MAX)}\n…`
			: text;
	} catch {
		return null;
	}
}

function imageSrc(image: ChatImage): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

export const ChatItemView = memo(function ChatItemView({
	item,
	sessionKey,
	canAnswer,
}: {
	item: ChatItem;
	sessionKey: string;
	/** The sidecar is reachable, so a permission prompt can be answered. */
	canAnswer: boolean;
}) {
	switch (item.kind) {
		case "user":
			return <UserBubble item={item} />;
		case "text":
			return <AssistantText item={item} />;
		case "thinking":
			return <ThinkingBlock item={item} />;
		case "tool":
			return <ToolChip item={item} />;
		case "permission":
			return (
				<PermissionPrompt
					item={item}
					sessionKey={sessionKey}
					canAnswer={canAnswer}
				/>
			);
		case "job":
			return <JobProgress item={item} />;
		case "turn_end":
			return <TurnFooter item={item} />;
		case "error":
			return <ErrorLine item={item} />;
		case "notice":
			return <NoticeLine item={item} />;
	}
});

function UserBubble({ item }: { item: ChatItemOf<"user"> }) {
	return (
		<div className="flex justify-end">
			<div className="bg-secondary text-foreground border-secondary-border max-w-[88%] rounded-lg rounded-br-sm border px-2.5 py-1.5 text-[13px] leading-relaxed break-words whitespace-pre-wrap">
				{item.text}
			</div>
		</div>
	);
}

const markdownClassName = cn(
	"prose prose-sm dark:prose-invert text-foreground/90 max-w-none text-[13px] leading-relaxed break-words",
	"prose-headings:text-foreground prose-headings:mb-1 prose-headings:mt-3 prose-headings:text-[13px] prose-headings:font-semibold",
	"prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-table:text-xs",
	"prose-code:before:content-none prose-code:after:content-none",
	// The wrapper forces m-0 on paragraphs; space consecutive blocks back out.
	"[&>p:not(:first-child)]:mt-2",
	"[&_pre]:bg-accent [&_pre]:text-foreground [&_pre]:my-2 [&_pre]:rounded-md [&_pre]:p-2 [&_pre]:text-xs",
	"[&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit",
);

function AssistantText({ item }: { item: ChatItemOf<"text"> }) {
	return (
		<div className={markdownClassName}>
			<ReactMarkdownWrapper>{item.text}</ReactMarkdownWrapper>
			{item.streaming && (
				<span
					aria-hidden
					className="bg-foreground/60 ml-0.5 inline-block h-3.5 w-1.5 animate-pulse align-text-bottom"
				/>
			)}
		</div>
	);
}

function ThinkingBlock({ item }: { item: ChatItemOf<"thinking"> }) {
	const [open, setOpen] = useState(false);
	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 text-xs">
				<HugeiconsIcon
					icon={ArrowRight01Icon}
					className={cn("size-3 transition-transform", open && "rotate-90")}
				/>
				<HugeiconsIcon icon={Brain02Icon} className="size-3.5" />
				<span>Réflexion</span>
				{item.streaming && <Spinner className="size-3" />}
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="text-muted-foreground border-border mt-1 ml-1.5 max-h-64 overflow-y-auto border-l pl-2.5 text-xs leading-relaxed whitespace-pre-wrap scrollbar-thin">
					{item.text}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

function ToolStatusIcon({ status }: { status: ChatItemOf<"tool">["status"] }) {
	switch (status) {
		case "running":
			return <Spinner className="size-3 shrink-0" />;
		case "success":
			return (
				<HugeiconsIcon
					icon={Tick02Icon}
					className="text-constructive size-3.5 shrink-0"
				/>
			);
		case "error":
			return (
				<HugeiconsIcon
					icon={AlertCircleIcon}
					className="text-destructive size-3.5 shrink-0"
				/>
			);
		case "stopped":
			return (
				<HugeiconsIcon
					icon={StopCircleIcon}
					className="text-muted-foreground size-3.5 shrink-0"
				/>
			);
	}
}

const TOOL_STATUS_SUFFIX: Partial<
	Record<ChatItemOf<"tool">["status"], string>
> = {
	error: "échec",
	stopped: "interrompu",
};

function ToolChip({ item }: { item: ChatItemOf<"tool"> }) {
	const label = getToolLabel(item.name);
	const suffix = TOOL_STATUS_SUFFIX[item.status];
	const inputPreview = previewInput(item.input);
	return (
		<div className="flex flex-col items-start gap-1.5">
			<div
				title={inputPreview ?? undefined}
				className={cn(
					"bg-accent/60 flex max-w-full items-start gap-1.5 rounded-md border px-2 py-1 text-xs",
					item.status === "error" && "border-destructive/40",
				)}
			>
				<span className="mt-px flex">
					<ToolStatusIcon status={item.status} />
				</span>
				<span className="min-w-0">
					<span className="text-foreground font-medium">{label}</span>
					{suffix && <span className="text-muted-foreground"> ({suffix})</span>}
					{item.summary && (
						<span className="text-muted-foreground line-clamp-3 break-words">
							{item.summary}
						</span>
					)}
				</span>
			</div>
			{item.image && <FrameThumbnail image={item.image} label={label} />}
		</div>
	);
}

function FrameThumbnail({ image, label }: { image: ChatImage; label: string }) {
	const [open, setOpen] = useState(false);
	const src = imageSrc(image);
	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="group border-border relative block w-full max-w-64 cursor-zoom-in overflow-hidden rounded-md border bg-black"
				aria-label="Agrandir l'image"
			>
				<Image
					src={src}
					alt={`Image vue par Claude : ${label}`}
					width={1280}
					height={720}
					unoptimized
					className="h-auto max-h-44 w-full object-contain transition-opacity group-hover:opacity-90"
				/>
			</button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="max-w-[min(90vw,1400px)] overflow-hidden bg-black p-0">
					<DialogTitle className="sr-only">{`Image vue par Claude : ${label}`}</DialogTitle>
					<Image
						src={src}
						alt={`Image vue par Claude : ${label}`}
						width={1920}
						height={1080}
						unoptimized
						className="h-auto max-h-[85vh] w-full object-contain"
					/>
				</DialogContent>
			</Dialog>
		</>
	);
}

const PERMISSION_OUTCOME: Record<
	Exclude<ChatItemOf<"permission">["status"], "pending">,
	string
> = {
	allowed: "Autorisé",
	denied: "Refusé",
	expired: "Sans réponse : la demande a expiré",
};

function PermissionPrompt({
	item,
	sessionKey,
	canAnswer,
}: {
	item: ChatItemOf<"permission">;
	sessionKey: string;
	canAnswer: boolean;
}) {
	const inputPreview = previewInput(item.input);
	const answer = (allow: boolean) => {
		const sent = chatStore.getState().respondPermission({
			sessionKey,
			requestId: item.requestId,
			allow,
		});
		if (!sent) {
			toast.error("Réponse non envoyée : le sidecar est injoignable.");
		}
	};
	return (
		<div
			className={cn(
				"flex flex-col gap-2 rounded-md border p-2.5 text-xs",
				item.status === "pending"
					? "border-caution/50 bg-caution/5"
					: "border-border",
			)}
		>
			<div className="flex items-center gap-1.5">
				<HugeiconsIcon
					icon={Alert02Icon}
					className="text-caution size-3.5 shrink-0"
				/>
				<span className="text-foreground font-medium">
					Autorisation demandée : {getToolLabel(item.toolName)}
				</span>
			</div>
			{item.reason && (
				<p className="text-muted-foreground leading-relaxed">{item.reason}</p>
			)}
			{inputPreview && (
				<pre className="bg-accent text-muted-foreground max-h-28 overflow-auto rounded p-1.5 font-mono text-[11px] leading-snug whitespace-pre-wrap scrollbar-thin">
					{inputPreview}
				</pre>
			)}
			{item.status === "pending" ? (
				<div className="flex gap-2">
					<Button
						size="sm"
						className="h-7 text-xs"
						disabled={!canAnswer}
						onClick={() => answer(true)}
					>
						Autoriser
					</Button>
					<Button
						size="sm"
						variant="outline"
						className="h-7 text-xs"
						disabled={!canAnswer}
						onClick={() => answer(false)}
					>
						Refuser
					</Button>
				</div>
			) : (
				<p
					className={cn(
						"font-medium",
						item.status === "allowed" && "text-constructive",
						item.status === "denied" && "text-destructive",
						item.status === "expired" && "text-muted-foreground",
					)}
				>
					{PERMISSION_OUTCOME[item.status]}
				</p>
			)}
		</div>
	);
}

const JOB_STATUS_LABELS: Record<ChatItemOf<"job">["status"], string> = {
	queued: "En attente",
	running: "En cours",
	done: "Terminé",
	failed: "Échec",
	cancelled: "Annulé",
};

function JobProgress({ item }: { item: ChatItemOf<"job"> }) {
	const percent = Math.round(item.progress * 100);
	const phase =
		item.status === "running" && item.phase
			? getJobPhaseLabel(item.phase)
			: JOB_STATUS_LABELS[item.status];
	return (
		<div className="flex flex-col gap-1.5 rounded-md border p-2.5 text-xs">
			<div className="flex items-center justify-between gap-2">
				<span className="text-foreground font-medium">
					{getJobKindLabel(item.jobKind)}
				</span>
				<span
					className={cn(
						"text-muted-foreground tabular-nums",
						item.status === "failed" && "text-destructive",
						item.status === "done" && "text-constructive",
					)}
				>
					{phase}
					{item.status === "running" || item.status === "queued"
						? ` · ${percent} %`
						: ""}
				</span>
			</div>
			<Progress
				value={item.status === "done" ? 100 : percent}
				className="h-1.5"
				aria-label={`Progression : ${percent} %`}
			/>
			{item.message && (
				<p
					className={cn(
						"text-muted-foreground break-words",
						item.status === "failed" && "text-destructive",
					)}
				>
					{item.message}
				</p>
			)}
		</div>
	);
}

const tokenFormat = new Intl.NumberFormat("fr-FR");

function TurnFooter({ item }: { item: ChatItemOf<"turn_end"> }) {
	const usage = item.usage
		? `${tokenFormat.format(item.usage.inputTokens)} jetons en entrée, ${tokenFormat.format(item.usage.outputTokens)} en sortie`
		: undefined;
	return (
		<div
			className="text-muted-foreground/80 flex items-center gap-1.5 text-[11px]"
			title={usage}
		>
			<HugeiconsIcon icon={Clock01Icon} className="size-3" />
			<span>
				Terminé en {formatDuration(item.durationMs)}
				{item.costUsd !== undefined && ` · ≈ ${formatCostUsd(item.costUsd)}`}
			</span>
		</div>
	);
}

function ErrorLine({ item }: { item: ChatItemOf<"error"> }) {
	return (
		<div className="border-destructive/30 bg-destructive/5 text-destructive flex items-start gap-1.5 rounded-md border px-2.5 py-2 text-xs leading-relaxed">
			<HugeiconsIcon
				icon={AlertCircleIcon}
				className="mt-px size-3.5 shrink-0"
			/>
			<span className="break-words">{item.message}</span>
		</div>
	);
}

function NoticeLine({ item }: { item: ChatItemOf<"notice"> }) {
	return (
		<div className="text-muted-foreground flex items-start gap-1.5 text-xs italic">
			<HugeiconsIcon
				icon={InformationCircleIcon}
				className="mt-px size-3.5 shrink-0"
			/>
			<span>{item.text}</span>
		</div>
	);
}
