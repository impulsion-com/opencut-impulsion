"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
	AiChat02Icon,
	Alert02Icon,
	BubbleChatAddIcon,
	Key01Icon,
	SidebarRight01Icon,
	WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import {
	CHAT_MODELS,
	CHAT_PROFILES,
	type ChatProfile,
} from "@opencut/claude-tools";
import { claudeBridge } from "@/claude/bridge/client";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/utils/ui";
import { isApiKeyBilled } from "../chat-model";
import { isChatModelId } from "../chat-store";
import {
	describeRateLimit,
	type BadgeTone,
	type ConnectionView,
} from "../format";
import { closeClaudePanel } from "../panel-toggle-store";
import { chatStore, useChat, useConversation } from "../use-chat";

export const PROFILE_LABELS: Record<ChatProfile, string> = {
	A: "Profil A (~/.claude)",
	B: "Profil B (~/.claude-b)",
};

function isChatProfile(value: string): value is ChatProfile {
	return CHAT_PROFILES.some((profile) => profile === value);
}

const STATUS: Record<ConnectionView, { label: string; dot: string }> = {
	active: { label: "Connecté", dot: "bg-constructive" },
	passive: { label: "Onglet passif", dot: "bg-caution" },
	offline: { label: "Sidecar hors ligne", dot: "bg-destructive" },
	connecting: { label: "Connexion…", dot: "bg-muted-foreground animate-pulse" },
};

export function ConnectionStatus({ view }: { view: ConnectionView }) {
	const { label, dot } = STATUS[view];
	return (
		<span
			className="text-muted-foreground flex items-center gap-1.5 text-xs whitespace-nowrap"
			role="status"
		>
			<span className={cn("size-1.5 shrink-0 rounded-full", dot)} />
			{label}
		</span>
	);
}

const BADGE_TONES: Record<BadgeTone, string> = {
	muted: "text-muted-foreground border-border",
	warning: "text-caution border-caution/40 bg-caution/5",
	danger: "text-destructive border-destructive/40 bg-destructive/5",
};

function RateLimitBadge() {
	const info = useChat((state) => state.rateLimit);
	const receivedAt = useChat((state) => state.rateLimitAt);
	if (!info) return null;
	const badge = describeRateLimit({ info, now: receivedAt });
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					className={cn(
						"max-w-36 truncate rounded border px-1.5 py-px text-[10px] leading-4 whitespace-nowrap",
						BADGE_TONES[badge.tone],
					)}
				>
					{badge.label}
				</span>
			</TooltipTrigger>
			<TooltipContent side="bottom" className="text-xs">
				{badge.detail}
			</TooltipContent>
		</Tooltip>
	);
}

export function ChatHeader({
	sessionKey,
	view,
}: {
	sessionKey: string;
	view: ConnectionView;
}) {
	const model = useChat((state) => state.model);
	const profile = useChat((state) => state.profile);

	return (
		<div className="flex shrink-0 flex-col border-b">
			<div className="flex h-11 items-center justify-between gap-2 pr-1.5 pl-3">
				<div className="flex min-w-0 items-center gap-2.5">
					<span className="flex items-center gap-1.5 text-sm font-medium">
						<HugeiconsIcon icon={AiChat02Icon} className="size-4" />
						Claude
					</span>
					<ConnectionStatus view={view} />
				</div>
				<div className="flex shrink-0 items-center gap-0.5">
					<RateLimitBadge />
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								aria-label="Nouvelle conversation"
								onClick={() => chatStore.getState().reset(sessionKey)}
							>
								<HugeiconsIcon icon={BubbleChatAddIcon} />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom" className="text-xs">
							Nouvelle conversation
						</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								aria-label="Masquer le panneau Claude"
								onClick={closeClaudePanel}
							>
								<HugeiconsIcon icon={SidebarRight01Icon} />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom" className="text-xs">
							Masquer le panneau Claude
						</TooltipContent>
					</Tooltip>
				</div>
			</div>
			<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.45fr)] gap-1.5 px-2 pb-2">
				<Select
					value={model}
					onValueChange={(value) => {
						if (isChatModelId(value)) chatStore.getState().setModel(value);
					}}
				>
					<SelectTrigger
						size="sm"
						className="h-7 w-full text-xs"
						aria-label="Modèle"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{CHAT_MODELS.map((option) => (
							<SelectItem key={option.id} value={option.id} className="text-xs">
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select
					value={profile}
					onValueChange={(value) => {
						if (isChatProfile(value)) chatStore.getState().setProfile(value);
					}}
				>
					<SelectTrigger
						size="sm"
						className="h-7 w-full text-xs"
						aria-label="Profil Claude"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{CHAT_PROFILES.map((option) => (
							<SelectItem key={option} value={option} className="text-xs">
								{PROFILE_LABELS[option]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
		</div>
	);
}

/**
 * Banners under the header: a conversation kept from another project, how to start the sidecar, how to take
 * control, and the API key warning.
 */
export function ChatNotices({
	sessionKey,
	projectKey,
	view,
}: {
	sessionKey: string;
	projectKey: string;
	view: ConnectionView;
}) {
	const conversation = useConversation(sessionKey);
	const session = conversation.session;
	const activeTab = useChat((state) => state.bridgeStatus.activeTab ?? null);

	return (
		<>
			{sessionKey !== projectKey && (
				<div className="bg-accent/50 flex shrink-0 items-start gap-2 border-b px-3 py-2 text-xs leading-relaxed">
					<HugeiconsIcon
						icon={AiChat02Icon}
						className="text-muted-foreground mt-px size-3.5 shrink-0"
					/>
					<div className="flex min-w-0 flex-col gap-1.5">
						<span className="text-muted-foreground">
							{conversation.running
								? "Claude poursuit la conversation commencée dans un autre projet."
								: "Cette conversation a commencé dans un autre projet."}
						</span>
						<Button
							variant="outline"
							size="sm"
							className="h-6 self-start px-2 text-[11px]"
							onClick={() => chatStore.getState().unpinPanel(projectKey)}
						>
							Voir la conversation de ce projet
						</Button>
					</div>
				</div>
			)}
			{isApiKeyBilled(session) && session && (
				<div className="border-destructive/30 bg-destructive/5 text-destructive flex shrink-0 items-start gap-2 border-b px-3 py-2 text-xs leading-relaxed">
					<HugeiconsIcon icon={Key01Icon} className="mt-px size-3.5 shrink-0" />
					<span>
						Attention : une clé API serait facturée (source :{" "}
						<code className="font-mono">{session.apiKeySource}</code>).{" "}
						{
							"Le chat doit passer par l'abonnement Max : retire ANTHROPIC_API_KEY de l'environnement du sidecar."
						}
					</span>
				</div>
			)}
			{view === "offline" && (
				<div className="bg-accent/50 flex shrink-0 items-start gap-2 border-b px-3 py-2 text-xs leading-relaxed">
					<HugeiconsIcon
						icon={WifiDisconnected01Icon}
						className="text-muted-foreground mt-px size-3.5 shrink-0"
					/>
					<div className="flex min-w-0 flex-col gap-1.5">
						<span className="text-muted-foreground">
							Lance{" "}
							<code className="bg-background text-foreground rounded px-1 py-px font-mono text-[11px]">
								bun run dev:impulsion
							</code>{" "}
							dans{" "}
							<code className="bg-background text-foreground rounded px-1 py-px font-mono text-[11px]">
								~/impulsion/opencut
							</code>
						</span>
						<Button
							variant="outline"
							size="sm"
							className="h-6 self-start px-2 text-[11px]"
							onClick={() => claudeBridge.reconnect()}
						>
							Réessayer maintenant
						</Button>
					</div>
				</div>
			)}
			{view === "passive" && (
				<div className="border-caution/30 bg-caution/5 flex shrink-0 items-start gap-2 border-b px-3 py-2 text-xs leading-relaxed">
					<HugeiconsIcon
						icon={Alert02Icon}
						className="text-caution mt-px size-3.5 shrink-0"
					/>
					<div className="flex min-w-0 flex-col gap-1.5">
						<span className="text-muted-foreground">
							{"L'éditeur est piloté depuis un autre onglet"}
							{activeTab?.projectName ? ` (${activeTab.projectName})` : ""}.
						</span>
						<Button
							size="sm"
							className="h-6 self-start px-2 text-[11px]"
							onClick={() => claudeBridge.claimActive()}
						>
							Piloter depuis cet onglet
						</Button>
					</div>
				</div>
			)}
		</>
	);
}
