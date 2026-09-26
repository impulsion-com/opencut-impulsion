import type { IncomingMessage, ServerResponse } from "node:http";
import { EDITOR_ORIGIN } from "@opencut/claude-tools";

// CORS for the two routes the editor tab calls (/files and /exports). Only EDITOR_ORIGIN is ever allowed; a
// request carrying any other Origin is refused outright (not just left without CORS headers), so another website
// cannot even trigger a read or an upload. Requests without Origin (curl, local tools) are allowed.

const EXPOSED_HEADERS =
	"Content-Length, Content-Range, Accept-Ranges, Content-Type, Last-Modified";

export function originOf(req: IncomingMessage): string | undefined {
	const origin = req.headers.origin;
	return Array.isArray(origin) ? origin[0] : origin;
}

/** Sets the CORS headers; returns false (after answering 403) when the Origin is not the editor's. */
export function applyCors({
	req,
	res,
	methods,
}: {
	req: IncomingMessage;
	res: ServerResponse;
	methods: string;
}): boolean {
	const origin = originOf(req);
	res.setHeader("Vary", "Origin");
	if (origin === undefined) return true;
	if (origin !== EDITOR_ORIGIN) {
		sendJson({ res, status: 403, body: { error: "forbidden origin" } });
		return false;
	}
	res.setHeader("Access-Control-Allow-Origin", EDITOR_ORIGIN);
	res.setHeader("Access-Control-Allow-Methods", methods);
	res.setHeader("Access-Control-Expose-Headers", EXPOSED_HEADERS);
	return true;
}

/** Answers an OPTIONS preflight from the editor (Range, Content-Type and custom upload headers). */
export function answerPreflight({
	req,
	res,
	methods,
}: {
	req: IncomingMessage;
	res: ServerResponse;
	methods: string;
}): void {
	if (!applyCors({ req, res, methods })) return;
	res.setHeader(
		"Access-Control-Allow-Headers",
		"Range, Content-Type, Content-Length, X-File-Name",
	);
	res.setHeader("Access-Control-Max-Age", "600");
	// Chrome's Private Network Access preflight (localhost page calling 127.0.0.1).
	if (req.headers["access-control-request-private-network"] === "true") {
		res.setHeader("Access-Control-Allow-Private-Network", "true");
	}
	res.statusCode = 204;
	res.end();
}

export function sendJson({
	res,
	status,
	body,
}: {
	res: ServerResponse;
	status: number;
	body: unknown;
}): void {
	if (res.headersSent) {
		res.end();
		return;
	}
	const text = JSON.stringify(body);
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("Content-Length", Buffer.byteLength(text));
	res.setHeader("Cache-Control", "no-store");
	res.end(text);
}
