import { spawn } from "node:child_process";
import type { Logger } from "./log";

// ffprobe/ffmpeg helpers: media metadata for list_disk_media (cached by path + size + mtime, a few processes at a
// time) and image downscaling for chat thumbnails. Every call is best effort: failures return null.

export interface ProbeInfo {
	/** Seconds. */
	duration?: number;
	width?: number;
	height?: number;
	fps?: number;
	hasAudio?: boolean;
}

const PROBE_TIMEOUT_MS = 10_000;
const CACHE_LIMIT = 5000;

function runProcess({
	command,
	args,
	input,
	timeoutMs,
}: {
	command: string;
	args: string[];
	input?: Buffer;
	timeoutMs: number;
}): Promise<Buffer | null> {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
		} catch {
			resolve(null);
			return;
		}
		const chunks: Buffer[] = [];
		let settled = false;
		const finish = (value: Buffer | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(null);
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.on("error", () => finish(null));
		child.on("close", (code) =>
			finish(code === 0 ? Buffer.concat(chunks) : null),
		);
		child.stdin.on("error", () => {});
		if (input) child.stdin.end(input);
		else child.stdin.end();
	});
}

function parseRate(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const [num, den] = value.split("/").map(Number);
	if (!num || !Number.isFinite(num)) return undefined;
	const fps = den ? num / den : num;
	return Number.isFinite(fps) && fps > 0 && fps < 1000
		? Math.round(fps * 1000) / 1000
		: undefined;
}

/** Parses `ffprobe -print_format json -show_format -show_streams` output. */
export function parseProbeOutput(json: unknown): ProbeInfo | null {
	if (typeof json !== "object" || json === null) return null;
	const streams: unknown[] = Array.isArray(Reflect.get(json, "streams"))
		? Reflect.get(json, "streams")
		: [];
	const format: unknown = Reflect.get(json, "format");
	const info: ProbeInfo = {};
	const video = streams.find(
		(stream) =>
			typeof stream === "object" &&
			stream !== null &&
			Reflect.get(stream, "codec_type") === "video" &&
			Reflect.get(Reflect.get(stream, "disposition") ?? {}, "attached_pic") !==
				1,
	) as Record<string, unknown> | undefined;
	const audio = streams.some(
		(stream) =>
			typeof stream === "object" &&
			stream !== null &&
			Reflect.get(stream, "codec_type") === "audio",
	);
	if (video) {
		if (typeof video.width === "number") info.width = video.width;
		if (typeof video.height === "number") info.height = video.height;
		const fps =
			parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate);
		if (fps !== undefined) info.fps = fps;
	}
	info.hasAudio = audio;
	const durationText =
		typeof format === "object" && format !== null
			? Reflect.get(format, "duration")
			: undefined;
	const duration = Number(durationText);
	if (Number.isFinite(duration) && duration > 0)
		info.duration = Math.round(duration * 1000) / 1000;
	return info;
}

export interface Prober {
	probe(options: {
		path: string;
		size: number;
		mtimeMs: number;
	}): Promise<ProbeInfo | null>;
}

export function createProber({
	ffprobePath,
	concurrency = 4,
	logger,
}: {
	ffprobePath: string;
	concurrency?: number;
	logger: Logger;
}): Prober {
	const cache = new Map<string, ProbeInfo | null>();
	let running = 0;
	const queue: Array<() => void> = [];
	let warned = false;

	async function withSlot<T>(task: () => Promise<T>): Promise<T> {
		if (running >= concurrency)
			await new Promise<void>((resolve) => queue.push(resolve));
		running += 1;
		try {
			return await task();
		} finally {
			running -= 1;
			queue.shift()?.();
		}
	}

	return {
		async probe({ path, size, mtimeMs }) {
			const key = `${path}\0${size}\0${mtimeMs}`;
			if (cache.has(key)) return cache.get(key) ?? null;
			const info = await withSlot(async () => {
				const output = await runProcess({
					command: ffprobePath,
					args: [
						"-v",
						"error",
						"-print_format",
						"json",
						"-show_format",
						"-show_streams",
						path,
					],
					timeoutMs: PROBE_TIMEOUT_MS,
				});
				if (!output) {
					if (!warned) {
						warned = true;
						logger.warn("ffprobe failed (metadata left out)", { ffprobePath });
					}
					return null;
				}
				try {
					return parseProbeOutput(JSON.parse(output.toString("utf8")));
				} catch {
					return null;
				}
			});
			if (cache.size >= CACHE_LIMIT) {
				const oldest = cache.keys().next().value;
				if (oldest !== undefined) cache.delete(oldest);
			}
			cache.set(key, info);
			return info;
		},
	};
}

/** Downscales an image to a JPEG whose long edge is at most `maxEdge` px. Returns base64, or null on failure. */
export async function downscaleImage({
	ffmpegPath,
	data,
	maxEdge,
}: {
	ffmpegPath: string;
	data: Buffer;
	maxEdge: number;
}): Promise<string | null> {
	const scale = `scale='if(gt(iw,ih),min(${maxEdge},iw),-2)':'if(gt(iw,ih),-2,min(${maxEdge},ih))'`;
	const output = await runProcess({
		command: ffmpegPath,
		args: [
			"-v",
			"error",
			"-i",
			"pipe:0",
			"-vf",
			scale,
			"-frames:v",
			"1",
			"-q:v",
			"5",
			"-f",
			"image2pipe",
			"-c:v",
			"mjpeg",
			"pipe:1",
		],
		input: data,
		timeoutMs: PROBE_TIMEOUT_MS,
	});
	return output && output.length > 0 ? output.toString("base64") : null;
}
