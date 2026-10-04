import express, {
	type Express,
	type NextFunction,
	type Request,
	type Response,
} from "express";
import { BridgeError, toBridgeError } from "./errors";
import { answerPreflight, applyCors, sendJson } from "./http-utils";
import type { EditorHub } from "./hub";
import type { Logger } from "./log";
import type { MotionService } from "./motion";
import type { ToolRegistry } from "./tools";

// HTTP routes of the motion blocks, called by the editor tab's settings panel (the MCP tools serve Claude).
// Same rule as /files and /exports: only the editor's Origin, or no Origin at all, is accepted.
//   GET  /motion/blocks            the catalogue
//   GET  /motion/media/:mediaId    what a media of the open project was rendered from, or 404
//   POST /motion/add               add_motion_block
//   POST /motion/update            update_motion_block

export const MOTION_PATH = "/motion";
const METHODS = "GET, POST, OPTIONS";

const STATUS_BY_CODE: Record<string, number> = {
	INVALID_PARAMS: 400,
	INVALID_EDIT: 409,
	NOT_FOUND: 404,
	NO_PROJECT: 409,
	EDITOR_NOT_CONNECTED: 503,
	USER_INTERACTING: 409,
	EXPORTING: 409,
};

export function registerMotionRoutes({
	app,
	hub,
	motion,
	registry,
	logger,
}: {
	app: Express;
	hub: Pick<EditorHub, "getActiveProjectId">;
	motion: MotionService;
	registry: ToolRegistry;
	logger: Logger;
}): void {
	const router = express.Router();

	router.use((req: Request, res: Response, next: NextFunction) => {
		if (req.method === "OPTIONS") {
			answerPreflight({ req, res, methods: METHODS });
			return;
		}
		if (!applyCors({ req, res, methods: METHODS })) return;
		next();
	});
	router.use(express.json({ limit: "200kb" }));

	const fail = (res: Response, error: unknown) => {
		const bridgeError = toBridgeError(error);
		sendJson({
			res,
			status: STATUS_BY_CODE[bridgeError.code] ?? 500,
			body: { error: { code: bridgeError.code, message: bridgeError.message } },
		});
	};

	const runTool = (name: "add_motion_block" | "update_motion_block") =>
		(req: Request, res: Response) => {
			const controller = new AbortController();
			res.on("close", () => {
				if (!res.writableEnded) controller.abort();
			});
			registry
				.run(name, req.body, {
					origin: { kind: "mcp" },
					signal: controller.signal,
				})
				.then((result) => sendJson({ res, status: 200, body: result.json }))
				.catch((error: unknown) => {
					logger.warn(`${name} from the panel failed`, {
						error: toBridgeError(error).message,
					});
					fail(res, error);
				});
		};

	router.get("/blocks", (_req: Request, res: Response) =>
		sendJson({ res, status: 200, body: { blocks: motion.blocks } }),
	);

	router.get("/media/:mediaId", (req: Request, res: Response) => {
		const projectId = hub.getActiveProjectId();
		if (!projectId) {
			fail(res, new BridgeError({ code: "NO_PROJECT", message: "No project is open." }));
			return;
		}
		motion
			.read(projectId)
			.then((entries) => {
				const entry = entries[String(req.params.mediaId)];
				if (!entry) {
					fail(
						res,
						new BridgeError({
							code: "NOT_FOUND",
							message: "This media is not a motion block.",
						}),
					);
					return;
				}
				sendJson({
					res,
					status: 200,
					body: { block: entry.block, props: entry.props, duration: entry.duration },
				});
			})
			.catch((error: unknown) => fail(res, error));
	});

	router.post("/add", runTool("add_motion_block"));
	router.post("/update", runTool("update_motion_block"));

	app.use(MOTION_PATH, router);
}
