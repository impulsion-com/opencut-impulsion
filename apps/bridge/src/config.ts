import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
	BRIDGE_HOST,
	BRIDGE_PORT,
	CHAT_PROFILES,
	DEFAULT_CHAT_MODEL,
	type ChatProfile,
} from "@opencut/claude-tools";
import { z } from "zod";

// Sidecar configuration: built-in defaults, then the optional JSON file
// ~/.config/opencut-impulsion/config.json, then environment variables (highest priority).
// Every path accepts a leading "~/" and is stored absolute.

export const DEFAULT_CONFIG_DIR = path.join(
	homedir(),
	".config",
	"opencut-impulsion",
);
export const DEFAULT_CONFIG_FILE = path.join(DEFAULT_CONFIG_DIR, "config.json");

export interface BridgeConfig {
	host: string;
	port: number;
	/** Folders the sidecar may list, serve and import from (realpath-checked, no dotfiles). */
	allowedRoots: string[];
	/** Where finished exports are written. */
	exportsDir: string;
	/** Per-project media indexes live in <dataDir>/projects/<projectId>/media-index.json. */
	dataDir: string;
	/** The Claude Code binary the Agent SDK spawns (never the SDK's bundled copy). */
	claudePath: string;
	/** CLAUDE_CONFIG_DIR per chat profile (A = default ~/.claude, B = ~/.claude-b). */
	profiles: Record<ChatProfile, string>;
	defaultProfile: ChatProfile;
	defaultModel: string;
	/** Optional effort for chat turns ("low" ... "max"); unset keeps the model default. */
	chatEffort?: "low" | "medium" | "high" | "xhigh" | "max";
	ffprobePath: string;
	ffmpegPath: string;
	/** Refuse export uploads above this size. */
	maxExportBytes: number;
	/** How long a minted /files/<id> URL stays valid. */
	fileTokenTtlMs: number;
	logLevel: "debug" | "info" | "warn" | "error";
	/** Where the config was read from, if a file existed. */
	configFile: string | null;
}

const PathSchema = z.string().min(1);

/** What config.json may contain (every key optional, unknown keys refused so typos surface). */
export const ConfigFileSchema = z.strictObject({
	allowedRoots: z.array(PathSchema).optional(),
	exportsDir: PathSchema.optional(),
	dataDir: PathSchema.optional(),
	claudePath: PathSchema.optional(),
	profiles: z
		.strictObject({ A: PathSchema.optional(), B: PathSchema.optional() })
		.optional(),
	defaultProfile: z.enum(CHAT_PROFILES).optional(),
	defaultModel: z.string().min(1).optional(),
	chatEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
	ffprobePath: PathSchema.optional(),
	ffmpegPath: PathSchema.optional(),
	maxExportBytes: z.number().int().positive().optional(),
	fileTokenTtlHours: z
		.number()
		.positive()
		.max(24 * 30)
		.optional(),
	logLevel: z.enum(["debug", "info", "warn", "error"]).optional(),
});
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export function expandHome(value: string, home: string = homedir()): string {
	if (value === "~") return home;
	if (value.startsWith("~/")) return path.join(home, value.slice(2));
	return value;
}

function absolute(value: string, home: string): string {
	return path.resolve(expandHome(value.trim(), home));
}

function defaultConfig(home: string): Omit<BridgeConfig, "configFile"> {
	return {
		host: BRIDGE_HOST,
		port: BRIDGE_PORT,
		allowedRoots: [
			path.join(home, "impulsion", "videos"),
			path.join(home, "Movies"),
			path.join(home, "Downloads"),
			path.join(home, "Desktop"),
			"/Volumes",
		],
		exportsDir: path.join(home, "impulsion", "videos", "exports"),
		dataDir: path.join(home, ".config", "opencut-impulsion"),
		claudePath: path.join(home, ".local", "bin", "claude"),
		profiles: {
			A: path.join(home, ".claude"),
			B: path.join(home, ".claude-b"),
		},
		defaultProfile: "A",
		defaultModel: DEFAULT_CHAT_MODEL,
		ffprobePath: "/opt/homebrew/bin/ffprobe",
		ffmpegPath: "/opt/homebrew/bin/ffmpeg",
		maxExportBytes: 20 * 1024 ** 3,
		fileTokenTtlMs: 24 * 60 * 60 * 1000,
		logLevel: "info",
	};
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/**
 * Environment overrides:
 * OPENCUT_BRIDGE_CONFIG (config file path), OPENCUT_BRIDGE_PORT (tests only: the editor always dials 3457),
 * OPENCUT_BRIDGE_ALLOWED_ROOTS (colon-separated), OPENCUT_BRIDGE_EXPORTS_DIR, OPENCUT_BRIDGE_DATA_DIR,
 * OPENCUT_BRIDGE_CLAUDE_PATH, OPENCUT_BRIDGE_PROFILE_A, OPENCUT_BRIDGE_PROFILE_B, OPENCUT_BRIDGE_DEFAULT_PROFILE,
 * OPENCUT_BRIDGE_DEFAULT_MODEL, OPENCUT_BRIDGE_FFPROBE, OPENCUT_BRIDGE_FFMPEG, OPENCUT_BRIDGE_LOG_LEVEL.
 */
export function loadConfig({
	env = process.env,
	home = homedir(),
	configFile,
}: {
	env?: NodeJS.ProcessEnv;
	home?: string;
	configFile?: string;
} = {}): BridgeConfig {
	const config: BridgeConfig = { ...defaultConfig(home), configFile: null };
	const filePath = absolute(
		configFile ?? env.OPENCUT_BRIDGE_CONFIG ?? DEFAULT_CONFIG_FILE,
		home,
	);

	if (existsSync(filePath)) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(filePath, "utf8"));
		} catch (error) {
			throw new ConfigError(
				`${filePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
			);
		}
		const parsed = ConfigFileSchema.safeParse(raw);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			throw new ConfigError(
				`${filePath}: ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"}`,
			);
		}
		applyFile({ config, file: parsed.data, home });
		config.configFile = filePath;
	}

	applyEnv({ config, env, home });
	// A default binary path that does not exist on this machine falls back to the same binary found on PATH
	// (Intel Homebrew, npm-installed claude...). Paths set in the file or the environment were resolved above.
	config.claudePath = findBinary({ preferred: config.claudePath, env });
	config.ffprobePath = findBinary({ preferred: config.ffprobePath, env });
	config.ffmpegPath = findBinary({ preferred: config.ffmpegPath, env });
	config.allowedRoots = dedupe(config.allowedRoots);
	return config;
}

function applyFile({
	config,
	file,
	home,
}: {
	config: BridgeConfig;
	file: ConfigFile;
	home: string;
}): void {
	if (file.allowedRoots)
		config.allowedRoots = file.allowedRoots.map((root) => absolute(root, home));
	if (file.exportsDir) config.exportsDir = absolute(file.exportsDir, home);
	if (file.dataDir) config.dataDir = absolute(file.dataDir, home);
	if (file.claudePath) config.claudePath = absolute(file.claudePath, home);
	if (file.profiles?.A) config.profiles.A = absolute(file.profiles.A, home);
	if (file.profiles?.B) config.profiles.B = absolute(file.profiles.B, home);
	if (file.defaultProfile) config.defaultProfile = file.defaultProfile;
	if (file.defaultModel) config.defaultModel = file.defaultModel;
	if (file.chatEffort) config.chatEffort = file.chatEffort;
	if (file.ffprobePath) config.ffprobePath = absolute(file.ffprobePath, home);
	if (file.ffmpegPath) config.ffmpegPath = absolute(file.ffmpegPath, home);
	if (file.maxExportBytes) config.maxExportBytes = file.maxExportBytes;
	if (file.fileTokenTtlHours)
		config.fileTokenTtlMs = file.fileTokenTtlHours * 60 * 60 * 1000;
	if (file.logLevel) config.logLevel = file.logLevel;
}

function applyEnv({
	config,
	env,
	home,
}: {
	config: BridgeConfig;
	env: NodeJS.ProcessEnv;
	home: string;
}): void {
	const value = (key: string) => {
		const raw = env[key];
		return raw && raw.trim() !== "" ? raw.trim() : undefined;
	};
	const port = value("OPENCUT_BRIDGE_PORT");
	if (port !== undefined) {
		const parsed = Number(port);
		if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
			throw new ConfigError(`OPENCUT_BRIDGE_PORT: invalid port "${port}"`);
		}
		config.port = parsed;
	}
	const roots = value("OPENCUT_BRIDGE_ALLOWED_ROOTS");
	if (roots !== undefined) {
		config.allowedRoots = roots
			.split(":")
			.filter((root) => root.trim() !== "")
			.map((root) => absolute(root, home));
	}
	const paths: Array<[string, (resolved: string) => void]> = [
		[
			"OPENCUT_BRIDGE_EXPORTS_DIR",
			(resolved) => (config.exportsDir = resolved),
		],
		["OPENCUT_BRIDGE_DATA_DIR", (resolved) => (config.dataDir = resolved)],
		[
			"OPENCUT_BRIDGE_CLAUDE_PATH",
			(resolved) => (config.claudePath = resolved),
		],
		["OPENCUT_BRIDGE_PROFILE_A", (resolved) => (config.profiles.A = resolved)],
		["OPENCUT_BRIDGE_PROFILE_B", (resolved) => (config.profiles.B = resolved)],
		["OPENCUT_BRIDGE_FFPROBE", (resolved) => (config.ffprobePath = resolved)],
		["OPENCUT_BRIDGE_FFMPEG", (resolved) => (config.ffmpegPath = resolved)],
	];
	for (const [key, set] of paths) {
		const raw = value(key);
		if (raw !== undefined) set(absolute(raw, home));
	}
	const profile = value("OPENCUT_BRIDGE_DEFAULT_PROFILE");
	if (profile !== undefined) {
		if (!(CHAT_PROFILES as readonly string[]).includes(profile)) {
			throw new ConfigError(
				`OPENCUT_BRIDGE_DEFAULT_PROFILE: expected A or B, got "${profile}"`,
			);
		}
		config.defaultProfile = profile as ChatProfile;
	}
	const model = value("OPENCUT_BRIDGE_DEFAULT_MODEL");
	if (model !== undefined) config.defaultModel = model;
	const level = value("OPENCUT_BRIDGE_LOG_LEVEL");
	if (level !== undefined) {
		if (!["debug", "info", "warn", "error"].includes(level)) {
			throw new ConfigError(
				`OPENCUT_BRIDGE_LOG_LEVEL: invalid level "${level}"`,
			);
		}
		config.logLevel = level as BridgeConfig["logLevel"];
	}
}

function findBinary({
	preferred,
	env,
}: {
	preferred: string;
	env: NodeJS.ProcessEnv;
}): string {
	if (existsSync(preferred)) return preferred;
	const name = path.basename(preferred);
	const suffixes = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
	for (const dir of (env.PATH ?? "").split(path.delimiter)) {
		if (dir.trim() === "") continue;
		for (const suffix of suffixes) {
			const candidate = path.join(dir, name + suffix);
			if (existsSync(candidate)) return candidate;
		}
	}
	return preferred;
}

function dedupe(values: string[]): string[] {
	return [...new Set(values)];
}

/** One-line summary for the startup log (no secrets in the config, but keep it short). */
export function describeConfig(config: BridgeConfig): Record<string, unknown> {
	return {
		configFile: config.configFile ?? "(none)",
		roots: config.allowedRoots.join(","),
		exportsDir: config.exportsDir,
		claudePath: config.claudePath,
		defaultProfile: config.defaultProfile,
		defaultModel: config.defaultModel,
	};
}
