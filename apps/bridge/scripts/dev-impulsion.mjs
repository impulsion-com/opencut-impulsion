#!/usr/bin/env node
// Starts the editor (Next, http://localhost:3456) and the sidecar (127.0.0.1:3457) together, with prefixed output.
// Ctrl+C stops both; if one of them exits, the other is stopped too. A service already listening on its port is
// left alone (not started twice). No dependency: plain Node.
// Usage (repo root): bun run dev:impulsion

import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
);
const colors = { web: "\x1b[36m", bridge: "\x1b[35m", reset: "\x1b[0m" };
const useColor = process.stdout.isTTY;

const services = [
	{
		name: "web",
		cwd: path.join(repo, "apps", "web"),
		command: "bun",
		args: ["run", "dev"],
		probe: { host: "localhost", port: 3456 },
		url: "http://localhost:3456",
	},
	{
		name: "bridge",
		cwd: path.join(repo, "apps", "bridge"),
		command: process.execPath,
		args: ["--import", "tsx", "src/main.ts"],
		probe: { host: "127.0.0.1", port: 3457 },
		url: "http://127.0.0.1:3457/health",
	},
];

function prefix(name) {
	const label = `[${name}]`.padEnd(9);
	return useColor ? `${colors[name]}${label}${colors.reset}` : label;
}

function say(name, line) {
	process.stdout.write(`${prefix(name)} ${line}\n`);
}

function isListening({ host, port }) {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
		const done = (value) => {
			socket.destroy();
			resolve(value);
		};
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
		socket.setTimeout(500, () => done(false));
	});
}

function pipeLines(stream, name) {
	let buffer = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		buffer += chunk;
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() ?? "";
		for (const line of lines) say(name, line);
	});
	stream.on("end", () => {
		if (buffer) say(name, buffer);
	});
}

const running = new Map();
let stopping = false;

function stopAll(code) {
	if (stopping) return;
	stopping = true;
	for (const [name, child] of running) {
		say(name, "arrêt...");
		try {
			// Each service runs in its own process group: signal the whole group (Next spawns workers).
			process.kill(-child.pid, "SIGINT");
		} catch {
			child.kill("SIGINT");
		}
	}
	const force = setTimeout(() => {
		for (const child of running.values()) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		process.exit(code);
	}, 5000);
	force.unref();
	const check = setInterval(() => {
		if (running.size === 0) {
			clearInterval(check);
			process.exit(code);
		}
	}, 100);
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

for (const service of services) {
	if (await isListening(service.probe)) {
		say(
			service.name,
			`déjà lancé (${service.url}), je ne le démarre pas une seconde fois.`,
		);
		continue;
	}
	const child = spawn(service.command, service.args, {
		cwd: service.cwd,
		env: { ...process.env, FORCE_COLOR: useColor ? "1" : "0" },
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	running.set(service.name, child);
	say(service.name, `démarrage : ${service.url}`);
	pipeLines(child.stdout, service.name);
	pipeLines(child.stderr, service.name);
	child.on("error", (error) =>
		say(service.name, `impossible de lancer : ${error.message}`),
	);
	child.on("exit", (code, signal) => {
		running.delete(service.name);
		say(service.name, `terminé (${signal ?? `code ${code}`})`);
		if (!stopping) stopAll(code ?? 1);
	});
}

if (running.size === 0) {
	process.stdout.write("Tout tourne déjà : rien à démarrer.\n");
	process.exit(0);
}
