import { BRIDGE_ORIGIN } from "@opencut/claude-tools";
import {
	MOTION_BLOCKS,
	type MotionBlock,
	type MotionProps,
} from "@opencut/motion-blocks/catalog";

// The editor's side of the motion blocks: the settings panel and the "Motion" assets view talk to the sidecar
// over HTTP (/motion), which renders with Remotion and then edits this tab like any Claude tool call.

const MOTION_URL = `${BRIDGE_ORIGIN}/motion`;

/** Rendered files are named by the sidecar: this is how a video asset is recognised as a block at a glance. */
const MOTION_FILE_PATTERN = /^bloc-[A-Za-z][A-Za-z0-9]*-[0-9a-f]{8}\.(webm|mp4)$/;

export function isMotionAssetName(name: string | undefined): boolean {
	return name !== undefined && MOTION_FILE_PATTERN.test(name);
}

export interface MotionMediaInfo {
	block: string;
	props: MotionProps;
	/** Seconds. */
	duration: number;
}

export class MotionRequestError extends Error {
	readonly code: string;
	constructor({ code, message }: { code: string; message: string }) {
		super(message);
		this.name = "MotionRequestError";
		this.code = code;
	}
}

/** French message for the panel: the sidecar speaks English to Claude. */
export function describeMotionError(error: unknown): string {
	if (error instanceof MotionRequestError) {
		switch (error.code) {
			case "OFFLINE":
				return "Le pont Claude ne répond pas. Lance l'éditeur avec « bun run dev:impulsion ».";
			case "EDITOR_NOT_CONNECTED":
				return "Cet onglet n'est pas celui qui pilote l'éditeur.";
			case "NOT_FOUND":
				return "Ce bloc n'est plus reconnu (ses réglages ne sont pas sur cette machine).";
			case "INVALID_EDIT":
				return "La nouvelle durée chevauche l'élément suivant sur la piste. Déplace-le ou choisis une durée plus courte.";
			case "USER_INTERACTING":
				return "Termine ton geste dans la timeline, puis réessaie.";
			case "EXPORTING":
				return "Un export est en cours. Réessaie quand il est terminé.";
			default:
				return error.message;
		}
	}
	return error instanceof Error ? error.message : String(error);
}

async function request<T>({
	path,
	body,
	signal,
}: {
	path: string;
	body?: unknown;
	signal?: AbortSignal;
}): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`${MOTION_URL}${path}`, {
			method: body === undefined ? "GET" : "POST",
			...(body === undefined
				? {}
				: {
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					}),
			signal,
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") throw error;
		throw new MotionRequestError({ code: "OFFLINE", message: "sidecar offline" });
	}
	const json: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const failure: unknown =
			typeof json === "object" && json !== null ? Reflect.get(json, "error") : null;
		const code: unknown =
			typeof failure === "object" && failure !== null
				? Reflect.get(failure, "code")
				: null;
		const message: unknown =
			typeof failure === "object" && failure !== null
				? Reflect.get(failure, "message")
				: null;
		throw new MotionRequestError({
			code: typeof code === "string" ? code : "INTERNAL",
			message: typeof message === "string" ? message : `HTTP ${response.status}`,
		});
	}
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return json as T;
}

/**
 * The catalogue as the sidecar sees it: the built-in blocks plus the local packs. Falls back to the built-in
 * list when the sidecar is offline, so the panel still shows something useful.
 */
export async function fetchMotionBlocks(signal?: AbortSignal): Promise<MotionBlock[]> {
	try {
		const { blocks } = await request<{ blocks: MotionBlock[] }>({
			path: "/blocks",
			signal,
		});
		return blocks;
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") throw error;
		return [...MOTION_BLOCKS];
	}
}

export function fetchMotionMedia({
	mediaId,
	signal,
}: {
	mediaId: string;
	signal?: AbortSignal;
}): Promise<MotionMediaInfo> {
	return request({ path: `/media/${encodeURIComponent(mediaId)}`, signal });
}

export function addMotionBlock(input: {
	block: string;
	props?: MotionProps;
	start: number;
	duration?: number;
}): Promise<{ elementId?: string; mediaId: string }> {
	return request({ path: "/add", body: input });
}

export function updateMotionBlock(input: {
	elementId: string;
	props?: MotionProps;
	duration?: number;
}): Promise<MotionMediaInfo & { elementId: string; mediaId: string }> {
	return request({ path: "/update", body: input });
}
