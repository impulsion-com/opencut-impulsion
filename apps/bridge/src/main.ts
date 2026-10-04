import { accountOverrideVariables } from "./chat";
import { ConfigError, describeConfig, loadConfig } from "./config";
import { createLogger } from "./log";
import { createBridgeServer } from "./server";
import { BRIDGE_VERSION } from "./version";

// Entry point: `node --import tsx src/main.ts` (Node 22). Loads the config, starts the sidecar on 127.0.0.1:3457,
// and shuts down cleanly on Ctrl+C / SIGTERM (chat sessions, MCP sessions, tab sockets, then the HTTP server).

async function main(): Promise<void> {
	let config;
	try {
		config = loadConfig();
	} catch (error) {
		if (error instanceof ConfigError) {
			console.error(`[bridge] configuration invalide : ${error.message}`);
			process.exit(1);
		}
		throw error;
	}
	const logger = createLogger({ level: config.logLevel });
	logger.info("starting opencut bridge", {
		version: BRIDGE_VERSION,
		node: process.version,
		...describeConfig(config),
	});
	for (const key of accountOverrideVariables(process.env)) {
		logger.warn(
			"variable ignored by the chat (the subscription login of the chosen profile is used)",
			{ variable: key },
		);
	}

	const bridge = createBridgeServer({ config, logger });
	try {
		await bridge.listen();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EADDRINUSE") {
			logger.error(
				`port ${config.port} already in use: is another sidecar running? (lsof -nP -iTCP:${config.port} -sTCP:LISTEN)`,
			);
		} else {
			logger.error("could not start", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		process.exit(1);
	}

	// The first motion block should not wait for the Remotion bundle: build it while the user settles in.
	setTimeout(() => bridge.motion.prewarm(), 3000).unref();

	let stopping = false;
	const shutdown = (signal: string) => {
		if (stopping) {
			logger.warn("forced exit");
			process.exit(1);
		}
		stopping = true;
		logger.info("shutting down", { signal });
		const force = setTimeout(() => {
			logger.warn("shutdown timed out, exiting");
			process.exit(0);
		}, 5000);
		force.unref();
		bridge
			.close()
			.then(() => {
				logger.info("stopped");
				process.exit(0);
			})
			.catch((error: unknown) => {
				logger.error("shutdown failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				process.exit(1);
			});
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("unhandledRejection", (reason) => {
		logger.error("unhandled rejection", {
			error: reason instanceof Error ? reason.message : String(reason),
		});
	});
}

void main();
