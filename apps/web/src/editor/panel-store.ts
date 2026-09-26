import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { CLAUDE_PANEL_LIMITS, PANEL_CONFIG } from "@/panels/layout";

export interface PanelSizes {
	tools: number;
	preview: number;
	properties: number;
	/** Last open width of the Claude column (the collapsed state lives in claudeCollapsed). */
	claude: number;
	mainContent: number;
	timeline: number;
}

export type PanelId = keyof PanelSizes;

interface PersistedPanelState {
	panels: PanelSizes;
	claudeCollapsed: boolean;
}

interface PanelState extends PersistedPanelState {
	setPanel: (args: { panel: PanelId; size: number }) => void;
	setPanels: (sizes: Partial<PanelSizes>) => void;
	setClaudeCollapsed: (collapsed: boolean) => void;
	resetPanels: () => void;
}

export const PANEL_STORE_VERSION = 3;

function clampClaudeSize(size: number): number {
	return Math.min(
		CLAUDE_PANEL_LIMITS.maxSize,
		Math.max(CLAUDE_PANEL_LIMITS.minSize, size),
	);
}

const PanelSizeSchema = z.number().finite().nonnegative();

const LegacyPanelStateSchema = z.object({
	panels: z
		.object({
			tools: PanelSizeSchema.optional(),
			preview: PanelSizeSchema.optional(),
			properties: PanelSizeSchema.optional(),
			claude: PanelSizeSchema.optional(),
			mainContent: PanelSizeSchema.optional(),
			timeline: PanelSizeSchema.optional(),
		})
		.nullish(),
	claudeCollapsed: z.boolean().optional(),
	// v0/v1 kept the sizes at the top level, some with a "Panel" suffix.
	toolsPanel: PanelSizeSchema.optional(),
	previewPanel: PanelSizeSchema.optional(),
	propertiesPanel: PanelSizeSchema.optional(),
	tools: PanelSizeSchema.optional(),
	preview: PanelSizeSchema.optional(),
	properties: PanelSizeSchema.optional(),
	mainContent: PanelSizeSchema.optional(),
	timeline: PanelSizeSchema.optional(),
});

function defaultPanelState(): PersistedPanelState {
	return {
		panels: { ...PANEL_CONFIG.panels },
		claudeCollapsed: PANEL_CONFIG.claudeCollapsed,
	};
}

/**
 * Brings a persisted "panel-sizes" state of any earlier version to v3. v3 added the Claude column: the three
 * existing horizontal panels are scaled down to make room for it, so the row still adds up to 100.
 */
export function migratePanelState(persisted: unknown): PersistedPanelState {
	const parsed = LegacyPanelStateSchema.safeParse(persisted);
	if (!parsed.success) return defaultPanelState();
	const state = parsed.data;
	const defaults = PANEL_CONFIG.panels;
	const nested = state.panels ?? {};

	const tools = nested.tools ?? state.tools ?? state.toolsPanel;
	const preview = nested.preview ?? state.preview ?? state.previewPanel;
	const properties =
		nested.properties ?? state.properties ?? state.propertiesPanel;
	const mainContent =
		nested.mainContent ?? state.mainContent ?? defaults.mainContent;
	const timeline = nested.timeline ?? state.timeline ?? defaults.timeline;

	if (nested.claude !== undefined) {
		return {
			panels: {
				tools: tools ?? defaults.tools,
				preview: preview ?? defaults.preview,
				properties: properties ?? defaults.properties,
				claude: clampClaudeSize(nested.claude),
				mainContent,
				timeline,
			},
			claudeCollapsed: state.claudeCollapsed ?? PANEL_CONFIG.claudeCollapsed,
		};
	}

	if (
		tools === undefined &&
		preview === undefined &&
		properties === undefined
	) {
		return {
			...defaultPanelState(),
			panels: { ...defaults, mainContent, timeline },
		};
	}

	// Pre-v3 row without the Claude column: make room for it at its default width.
	const legacyTools = tools ?? 25;
	const legacyPreview = preview ?? 50;
	const legacyProperties = properties ?? 25;
	const total = legacyTools + legacyPreview + legacyProperties;
	const ratio = total > 0 ? (100 - defaults.claude) / total : 0;
	if (ratio === 0) {
		return {
			...defaultPanelState(),
			panels: { ...defaults, mainContent, timeline },
		};
	}
	return {
		panels: {
			tools: legacyTools * ratio,
			preview: legacyPreview * ratio,
			properties: legacyProperties * ratio,
			claude: defaults.claude,
			mainContent,
			timeline,
		},
		claudeCollapsed: PANEL_CONFIG.claudeCollapsed,
	};
}

export const usePanelStore = create<PanelState>()(
	persist(
		(set) => ({
			...defaultPanelState(),
			setPanel: ({ panel, size }) =>
				set((state) => ({
					panels: {
						...state.panels,
						[panel]: panel === "claude" ? clampClaudeSize(size) : size,
					},
				})),
			setPanels: (sizes) =>
				set((state) => ({
					panels: {
						...state.panels,
						...sizes,
						...(sizes.claude !== undefined
							? { claude: clampClaudeSize(sizes.claude) }
							: {}),
					},
				})),
			setClaudeCollapsed: (collapsed) => set({ claudeCollapsed: collapsed }),
			resetPanels: () => set(defaultPanelState()),
		}),
		{
			name: "panel-sizes",
			version: PANEL_STORE_VERSION,
			migrate: (persistedState) => migratePanelState(persistedState),
			partialize: (state) => ({
				panels: state.panels,
				claudeCollapsed: state.claudeCollapsed,
			}),
		},
	),
);
