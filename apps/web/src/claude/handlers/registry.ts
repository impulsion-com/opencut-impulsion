import {
	INTERNAL_METHODS,
	TOOLS,
	type HybridToolName,
	type InternalMethod,
	type SidecarToolName,
	type TabToolName,
} from "@opencut/claude-tools";
import type {
	TabHandler,
	TabHandlerMap,
	TabMethod,
	UntypedTabHandler,
} from "@/claude/types";

// Method -> handler table for the tab. Each handler module exports a TabHandlerMap and registers it once from
// handlers/index.ts, so parallel work never edits the same file. Framework-free and dependency-free.

interface Registration {
	handler: UntypedTabHandler;
	owner: string;
}

const registrations = new Map<TabMethod, Registration>();

const TAB_METHODS = new Set<string>([
	...TOOLS.filter((tool) => tool.runsIn === "tab").map((tool) => tool.name),
	...INTERNAL_METHODS,
]);

/** True for tab tools and internal methods: what the hub may send to the tab by name. */
export function isTabMethod(method: string): method is TabMethod {
	return TAB_METHODS.has(method);
}

/**
 * Adds a module's handlers. Re-registering from the same owner replaces silently (HMR re-evaluates modules);
 * a method claimed by two owners keeps the first and logs an error. Returns the methods that were refused.
 */
export function registerTabHandlers({
	handlers,
	owner,
}: {
	handlers: TabHandlerMap;
	/** Module name for diagnostics, e.g. "core-handlers (E1)". */
	owner: string;
}): TabMethod[] {
	const refused: TabMethod[] = [];
	for (const [method, value] of Object.entries(handlers)) {
		if (!isTabMethod(method) || typeof value !== "function") continue;
		// The client validates params with the method's schema before calling, so storing it untyped is safe.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const handler = value as UntypedTabHandler;
		const existing = registrations.get(method);
		if (existing && existing.owner !== owner) {
			refused.push(method);
			console.error(
				`[claude] "${method}" already has a handler from ${existing.owner}; the one from ${owner} is ignored.`,
			);
			continue;
		}
		registrations.set(method, { handler, owner });
	}
	return refused;
}

export function getTabHandler<N extends TabMethod>(
	method: N,
): TabHandler<N> | undefined;
export function getTabHandler(method: string): UntypedTabHandler | undefined;
export function getTabHandler(method: string): UntypedTabHandler | undefined {
	return isTabMethod(method) ? registrations.get(method)?.handler : undefined;
}

/** Which module registered a method (for diagnostics). */
export function getTabHandlerOwner(method: string): string | undefined {
	return isTabMethod(method) ? registrations.get(method)?.owner : undefined;
}

/** Tests only. */
export function resetTabHandlersForTests(): void {
	registrations.clear();
}

// ---------------------------------------------------------------------------
// Coverage check
// ---------------------------------------------------------------------------

/**
 * Tab methods each sidecar-handled tool relies on (map 9.5, 9.6). Hybrid tools never reach the tab by name,
 * so their coverage is the coverage of these methods.
 */
export const SIDECAR_TOOL_TAB_DEPENDENCIES: Readonly<
	Record<HybridToolName, readonly TabMethod[]> &
		Partial<Record<SidecarToolName, readonly TabMethod[]>>
> = {
	list_disk_media: ["list_media"],
	import_media: ["internal.import_files"],
	start_export: ["internal.export_start"],
	cancel_job: ["internal.export_cancel"],
};

export interface MissingTabHandlers {
	tabTools: TabToolName[];
	internalMethods: InternalMethod[];
	/** Sidecar-handled tools whose tab-side dependencies are missing. */
	sidecarTools: {
		tool: HybridToolName | SidecarToolName;
		missing: TabMethod[];
	}[];
}

export function listMissingTabHandlers(): MissingTabHandlers {
	const tabTools: TabToolName[] = [];
	const sidecarTools: MissingTabHandlers["sidecarTools"] = [];
	for (const tool of TOOLS) {
		if (tool.runsIn === "tab") {
			if (!registrations.has(tool.name)) tabTools.push(tool.name);
			continue;
		}
		const needs: readonly TabMethod[] =
			SIDECAR_TOOL_TAB_DEPENDENCIES[tool.name] ?? [];
		const missing = needs.filter((method) => !registrations.has(method));
		if (missing.length > 0) sidecarTools.push({ tool: tool.name, missing });
	}
	const internalMethods = INTERNAL_METHODS.filter(
		(method) => !registrations.has(method),
	);
	return { tabTools, internalMethods, sidecarTools };
}

let hasWarnedMissing = false;

/** Dev only, browser only, once per page load: lists what the tab cannot serve yet. */
export function warnMissingTabHandlersOnce(): void {
	if (hasWarnedMissing) return;
	if (typeof window === "undefined" || process.env.NODE_ENV === "production")
		return;
	hasWarnedMissing = true;
	const missing = listMissingTabHandlers();
	const count = missing.tabTools.length + missing.internalMethods.length;
	if (count === 0) return;
	console.warn(
		`[claude] ${count} tab method(s) have no handler yet (calls answer INTERNAL).`,
		{
			tabTools: missing.tabTools,
			internalMethods: missing.internalMethods,
			sidecarToolsAffected: missing.sidecarTools.map((entry) => entry.tool),
		},
	);
}
