import type { RateLimitInfo } from "@opencut/claude-tools";
import type { BridgeStatus } from "@/claude/bridge/client";

// Small French formatters and derived views for the chat panel. Pure, so they are unit-tested.

const secondsFormat = new Intl.NumberFormat("fr-FR", {
	minimumFractionDigits: 1,
	maximumFractionDigits: 1,
});

/** "0,8 s", "12,3 s", "2 min 05 s". */
export function formatDuration(ms: number): string {
	const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
	if (safe < 60_000) return `${secondsFormat.format(safe / 1000)} s`;
	const totalSeconds = Math.round(safe / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
}

/** "0,042 $" under ten cents, "1,25 $" above. */
export function formatCostUsd(usd: number): string {
	const digits = usd < 0.1 ? 3 : 2;
	const amount = new Intl.NumberFormat("fr-FR", {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	}).format(Math.max(0, usd));
	return `${amount} $`;
}

export type BadgeTone = "muted" | "warning" | "danger";

export interface RateLimitBadge {
	label: string;
	tone: BadgeTone;
	/** Longer explanation for the tooltip. */
	detail: string;
}

const RATE_LIMIT_WINDOWS: Readonly<Record<string, string>> = {
	five_hour: "fenêtre de 5 h",
	seven_day: "fenêtre de 7 jours",
	seven_day_opus: "fenêtre de 7 jours (Opus)",
	seven_day_sonnet: "fenêtre de 7 jours (Sonnet)",
	seven_day_overage_included: "fenêtre de 7 jours",
	overage: "dépassement",
};

/** Utilization as a whole percentage; the SDK may send a 0..1 fraction or a percentage. */
function utilizationPercent(value: number | undefined): number | null {
	if (value === undefined || !Number.isFinite(value) || value < 0) return null;
	return Math.round(value <= 1 ? value * 100 : value);
}

function formatResetTime({
	resetsAt,
	now,
}: {
	resetsAt: number;
	now: number;
}): string {
	const date = new Date(resetsAt * 1000);
	const time = new Intl.DateTimeFormat("fr-FR", {
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
	const sameDay = new Date(now).toDateString() === date.toDateString();
	if (sameDay) return `à ${time}`;
	const day = new Intl.DateTimeFormat("fr-FR", { weekday: "long" }).format(
		date,
	);
	return `${day} à ${time}`;
}

/** The discreet quota badge of the panel header, from the last rate_limit event. */
export function describeRateLimit({
	info,
	now,
}: {
	info: RateLimitInfo;
	now: number;
}): RateLimitBadge {
	const percent = utilizationPercent(info.utilization);
	const window = info.rateLimitType
		? (RATE_LIMIT_WINDOWS[info.rateLimitType] ?? info.rateLimitType)
		: null;
	const reset =
		info.resetsAt !== undefined
			? formatResetTime({ resetsAt: info.resetsAt, now })
			: null;
	const detailParts = [
		window ? `Quota Claude, ${window}` : "Quota Claude",
		percent !== null ? `utilisé à ${percent} %` : null,
		reset ? `réinitialisé ${reset}` : null,
	].filter((part): part is string => part !== null);
	const detail = detailParts.join(", ");

	if (info.status === "rejected") {
		return {
			label: reset ? `Quota atteint, reprise ${reset}` : "Quota atteint",
			tone: "danger",
			detail,
		};
	}
	if (info.status === "allowed_warning") {
		return {
			label: percent !== null ? `Quota ${percent} %` : "Quota bientôt atteint",
			tone: "warning",
			detail,
		};
	}
	return {
		label: percent !== null ? `Quota ${percent} %` : "Quota OK",
		tone: "muted",
		detail,
	};
}

/** What the panel shows about the sidecar link. */
export type ConnectionView = "connecting" | "offline" | "active" | "passive";

/**
 * "offline" needs a failure seen since the last successful open: the bridge briefly reports "connecting" on
 * every retry and "closed" before its first attempt, and neither should flash "Sidecar hors ligne".
 */
export function getConnectionView({
	status,
	failed,
}: {
	status: BridgeStatus;
	failed: boolean;
}): ConnectionView {
	if (status.connection === "open") {
		if (status.role === "active") return "active";
		if (status.role === "passive") return "passive";
		return "connecting";
	}
	return failed ? "offline" : "connecting";
}
