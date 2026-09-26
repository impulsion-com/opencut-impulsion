import { describe, expect, test } from "bun:test";
import { TOOL_NAMES } from "@opencut/claude-tools";
import {
	describeRateLimit,
	formatCostUsd,
	formatDuration,
} from "@/claude/chat/format";
import { getJobPhaseLabel, getToolLabel } from "@/claude/chat/tool-labels";
import { migratePanelState } from "@/editor/panel-store";
import {
	getHorizontalDefaultSizes,
	PANEL_CONFIG,
	type HorizontalPanelSizes,
} from "@/panels/layout";

// Intl uses narrow no-break spaces in fr-FR; compare on plain spaces.
const plain = (text: string) => text.replace(/[\u202f\u00a0]/g, " ");

describe("French formatting", () => {
	test("durations", () => {
		expect(plain(formatDuration(820))).toBe("0,8 s");
		expect(plain(formatDuration(12_340))).toBe("12,3 s");
		expect(plain(formatDuration(125_000))).toBe("2 min 05 s");
		expect(plain(formatDuration(-5))).toBe("0,0 s");
	});

	test("costs", () => {
		expect(plain(formatCostUsd(0.0421))).toBe("0,042 $");
		expect(plain(formatCostUsd(1.254))).toBe("1,25 $");
	});

	test("rate limit badge", () => {
		const now = new Date(2026, 8, 25, 10, 0).getTime();
		const resetsAt = new Date(2026, 8, 25, 14, 30).getTime() / 1000;
		expect(
			describeRateLimit({ info: { status: "allowed" }, now }),
		).toMatchObject({ label: "Quota OK", tone: "muted" });
		expect(
			describeRateLimit({
				info: { status: "allowed_warning", utilization: 0.87 },
				now,
			}),
		).toMatchObject({ label: "Quota 87 %", tone: "warning" });
		const rejected = describeRateLimit({
			info: { status: "rejected", resetsAt, rateLimitType: "five_hour" },
			now,
		});
		expect(rejected.tone).toBe("danger");
		expect(plain(rejected.label)).toBe("Quota atteint, reprise à 14:30");
		expect(plain(rejected.detail)).toBe(
			"Quota Claude, fenêtre de 5 h, réinitialisé à 14:30",
		);
	});
});

describe("tool labels", () => {
	test("every contract tool has a French label", () => {
		for (const name of TOOL_NAMES) {
			expect(getToolLabel(name)).not.toStartWith("Outil ");
		}
		expect(getToolLabel("apply_edit_plan")).toBe("Modifie la timeline");
		expect(getToolLabel("capture_frame")).toBe("Regarde l'image");
		expect(getToolLabel("get_editor_state")).toBe("Lit la timeline");
		expect(getToolLabel("import_media")).toBe("Importe des médias");
		expect(getToolLabel("start_export")).toBe("Lance l'export");
	});

	test("prefixed and unknown names", () => {
		expect(getToolLabel("mcp__opencut__apply_edit_plan")).toBe(
			"Modifie la timeline",
		);
		expect(getToolLabel("ToolSearch")).toBe("Outil ToolSearch");
		expect(getToolLabel(null)).toBe("Outil");
	});
});

describe("panel layout", () => {
	const sum = (sizes: HorizontalPanelSizes) =>
		sizes.tools + sizes.preview + sizes.properties + sizes.claude;

	test("defaults add up to 100 with the Claude column open at 24 %", () => {
		expect(PANEL_CONFIG.panels.claude).toBe(24);
		expect(PANEL_CONFIG.claudeCollapsed).toBe(false);
		expect(sum(PANEL_CONFIG.panels)).toBe(100);
	});

	test("a v2 state makes room for the Claude column", () => {
		const migrated = migratePanelState({
			panels: {
				tools: 25,
				preview: 50,
				properties: 25,
				mainContent: 60,
				timeline: 40,
			},
		});
		expect(migrated.claudeCollapsed).toBe(false);
		expect(migrated.panels.claude).toBe(24);
		expect(migrated.panels.mainContent).toBe(60);
		expect(migrated.panels.timeline).toBe(40);
		expect(sum(migrated.panels)).toBeCloseTo(100, 6);
		expect(migrated.panels.tools).toBeCloseTo(19, 6);
		expect(migrated.panels.preview).toBeCloseTo(38, 6);
	});

	test("v0 flat states and garbage", () => {
		const flat = migratePanelState({
			toolsPanel: 30,
			previewPanel: 40,
			propertiesPanel: 30,
		});
		expect(sum(flat.panels)).toBeCloseTo(100, 6);
		expect(migratePanelState("nope")).toEqual({
			panels: { ...PANEL_CONFIG.panels },
			claudeCollapsed: false,
		});
		expect(migratePanelState(null).panels).toEqual({ ...PANEL_CONFIG.panels });
	});

	test("a v3 state is kept, with the Claude width clamped", () => {
		const kept = migratePanelState({
			panels: {
				tools: 20,
				preview: 40,
				properties: 20,
				claude: 80,
				mainContent: 50,
				timeline: 50,
			},
			claudeCollapsed: true,
		});
		expect(kept.claudeCollapsed).toBe(true);
		expect(kept.panels.claude).toBe(45);
		expect(kept.panels.tools).toBe(20);
	});

	test("horizontal defaults always add up to 100", () => {
		const open = getHorizontalDefaultSizes({
			tools: 20,
			preview: 40,
			properties: 16,
			claude: 24,
			claudeCollapsed: false,
		});
		expect(open).toEqual({
			tools: 20,
			preview: 40,
			properties: 16,
			claude: 24,
		});

		// Collapsed elsewhere while the other three still leave room for it.
		const collapsed = getHorizontalDefaultSizes({
			tools: 20,
			preview: 40,
			properties: 16,
			claude: 24,
			claudeCollapsed: true,
		});
		expect(collapsed.claude).toBe(0);
		expect(sum(collapsed)).toBeCloseTo(100, 6);

		const reopened = getHorizontalDefaultSizes({
			tools: 25,
			preview: 50,
			properties: 25,
			claude: 30,
			claudeCollapsed: false,
		});
		expect(reopened.claude).toBe(30);
		expect(sum(reopened)).toBeCloseTo(100, 6);
	});
});

describe("job phase labels", () => {
	test("every phase the import and export handlers report has a French label", async () => {
		const sources = await Promise.all(
			["../../media/import-files.ts", "../../export/export-handlers.ts"].map(
				(relative) => Bun.file(new URL(relative, import.meta.url)).text(),
			),
		);
		const phases = new Set(
			sources.flatMap((source) =>
				[...source.matchAll(/phase: "([a-z_]+)"/g)].map((match) => match[1] ?? ""),
			),
		);
		expect(phases.size).toBeGreaterThan(3);
		for (const phase of phases) expect(getJobPhaseLabel(phase)).not.toBe(phase);
		expect(getJobPhaseLabel("adding")).toBe("Ajout au projet");
	});
});
