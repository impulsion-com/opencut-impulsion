// Structured console logging: one line per event, ISO timestamp, level, scope, message, then key=value fields.
// Never log secrets, tokens, prompts or file contents: callers pass ids, paths, counts and codes only.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
	debug(message: string, fields?: LogFields): void;
	info(message: string, fields?: LogFields): void;
	warn(message: string, fields?: LogFields): void;
	error(message: string, fields?: LogFields): void;
	child(scope: string): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};
const MAX_FIELD_LENGTH = 300;

function formatValue(value: unknown): string {
	if (value instanceof Error) return JSON.stringify(value.message);
	if (typeof value === "string") {
		const clipped =
			value.length > MAX_FIELD_LENGTH
				? `${value.slice(0, MAX_FIELD_LENGTH)}...`
				: value;
		return /[\s="]/.test(clipped) || clipped === ""
			? JSON.stringify(clipped)
			: clipped;
	}
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		value === null ||
		value === undefined
	) {
		return String(value);
	}
	try {
		const json = JSON.stringify(value);
		return json.length > MAX_FIELD_LENGTH
			? `${json.slice(0, MAX_FIELD_LENGTH)}...`
			: json;
	} catch {
		return "[unserialisable]";
	}
}

export function formatLogLine({
	at,
	level,
	scope,
	message,
	fields,
}: {
	at: Date;
	level: LogLevel;
	scope: string;
	message: string;
	fields?: LogFields;
}): string {
	const parts = [
		at.toISOString(),
		level.toUpperCase().padEnd(5),
		`[${scope}]`,
		message,
	];
	for (const [key, value] of Object.entries(fields ?? {})) {
		if (value === undefined) continue;
		parts.push(`${key}=${formatValue(value)}`);
	}
	return parts.join(" ");
}

export function createLogger({
	scope = "bridge",
	level = "info",
	write,
}: {
	scope?: string;
	level?: LogLevel;
	/** Defaults to console.log / console.error. Tests pass a collector. */
	write?: (line: string, level: LogLevel) => void;
} = {}): Logger {
	const sink =
		write ??
		((line: string, lineLevel: LogLevel) => {
			if (lineLevel === "error" || lineLevel === "warn") console.error(line);
			else console.log(line);
		});
	const threshold = LEVEL_ORDER[level];
	const emit = (lineLevel: LogLevel, message: string, fields?: LogFields) => {
		if (LEVEL_ORDER[lineLevel] < threshold) return;
		sink(
			formatLogLine({
				at: new Date(),
				level: lineLevel,
				scope,
				message,
				fields,
			}),
			lineLevel,
		);
	};
	return {
		debug: (message, fields) => emit("debug", message, fields),
		info: (message, fields) => emit("info", message, fields),
		warn: (message, fields) => emit("warn", message, fields),
		error: (message, fields) => emit("error", message, fields),
		child: (childScope) =>
			createLogger({ scope: `${scope}:${childScope}`, level, write: sink }),
	};
}

/** A logger that drops everything (tests). */
export const silentLogger: Logger = createLogger({ write: () => {} });
