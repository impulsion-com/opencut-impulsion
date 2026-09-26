export const PANEL_CONFIG = {
	panels: {
		tools: 18,
		preview: 42,
		properties: 16,
		/** The Claude chat column: its last open width (0 is never stored; see claudeCollapsed). */
		claude: 24,
		mainContent: 50,
		timeline: 50,
	},
	claudeCollapsed: false,
} as const;

/** Size limits (percent of the row) of the Claude column, shared by the panel and the store. */
export const CLAUDE_PANEL_LIMITS = { minSize: 18, maxSize: 45 } as const;

export interface HorizontalPanelSizes {
	tools: number;
	preview: number;
	properties: number;
	claude: number;
}

/**
 * Default sizes for the horizontal group (tools, preview, properties, claude) that add up to 100, with the
 * Claude column at 0 when collapsed. react-resizable-panels would otherwise rescale an inconsistent layout
 * (and warn), e.g. after the column was collapsed from another tab.
 */
export function getHorizontalDefaultSizes({
	tools,
	preview,
	properties,
	claude,
	claudeCollapsed,
}: HorizontalPanelSizes & { claudeCollapsed: boolean }): HorizontalPanelSizes {
	const claudeSize = claudeCollapsed ? 0 : claude;
	const others = tools + preview + properties;
	const available = 100 - claudeSize;
	if (others <= 0) {
		const fallback = PANEL_CONFIG.panels;
		const fallbackOthers =
			fallback.tools + fallback.preview + fallback.properties;
		const ratio = available / fallbackOthers;
		return {
			tools: fallback.tools * ratio,
			preview: fallback.preview * ratio,
			properties: fallback.properties * ratio,
			claude: claudeSize,
		};
	}
	if (Math.abs(others - available) < 0.01) {
		return { tools, preview, properties, claude: claudeSize };
	}
	const ratio = available / others;
	return {
		tools: tools * ratio,
		preview: preview * ratio,
		properties: properties * ratio,
		claude: claudeSize,
	};
}
