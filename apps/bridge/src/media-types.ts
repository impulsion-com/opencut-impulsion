import path from "node:path";

// Extension tables for the media the editor can import. The editor classifies a File by its MIME prefix
// (video/, audio/, image/), so every entry here must map to one of those.

export type MediaKind = "video" | "audio" | "image";

const TYPES: Record<string, { kind: MediaKind; mime: string }> = {
	mp4: { kind: "video", mime: "video/mp4" },
	m4v: { kind: "video", mime: "video/x-m4v" },
	mov: { kind: "video", mime: "video/quicktime" },
	webm: { kind: "video", mime: "video/webm" },
	mkv: { kind: "video", mime: "video/x-matroska" },
	avi: { kind: "video", mime: "video/x-msvideo" },
	mpg: { kind: "video", mime: "video/mpeg" },
	mpeg: { kind: "video", mime: "video/mpeg" },
	mts: { kind: "video", mime: "video/mp2t" },
	m2ts: { kind: "video", mime: "video/mp2t" },
	"3gp": { kind: "video", mime: "video/3gpp" },
	mp3: { kind: "audio", mime: "audio/mpeg" },
	wav: { kind: "audio", mime: "audio/wav" },
	m4a: { kind: "audio", mime: "audio/mp4" },
	aac: { kind: "audio", mime: "audio/aac" },
	flac: { kind: "audio", mime: "audio/flac" },
	ogg: { kind: "audio", mime: "audio/ogg" },
	opus: { kind: "audio", mime: "audio/opus" },
	aif: { kind: "audio", mime: "audio/aiff" },
	aiff: { kind: "audio", mime: "audio/aiff" },
	caf: { kind: "audio", mime: "audio/x-caf" },
	jpg: { kind: "image", mime: "image/jpeg" },
	jpeg: { kind: "image", mime: "image/jpeg" },
	png: { kind: "image", mime: "image/png" },
	webp: { kind: "image", mime: "image/webp" },
	gif: { kind: "image", mime: "image/gif" },
	heic: { kind: "image", mime: "image/heic" },
	heif: { kind: "image", mime: "image/heif" },
	avif: { kind: "image", mime: "image/avif" },
	bmp: { kind: "image", mime: "image/bmp" },
	tif: { kind: "image", mime: "image/tiff" },
	tiff: { kind: "image", mime: "image/tiff" },
	svg: { kind: "image", mime: "image/svg+xml" },
};

/** Extensions listed by list_disk_media when the caller gives none (all importable types). */
export const DEFAULT_MEDIA_EXTENSIONS: readonly string[] = Object.keys(TYPES);

export function extensionOf(filePath: string): string {
	return path.extname(filePath).slice(1).toLowerCase();
}

export function mediaTypeOf(
	filePath: string,
): { kind: MediaKind; mime: string } | null {
	return TYPES[extensionOf(filePath)] ?? null;
}

/** Content-Type for any served file (media types first, then a generic fallback). */
export function contentTypeOf(filePath: string): string {
	return mediaTypeOf(filePath)?.mime ?? "application/octet-stream";
}
