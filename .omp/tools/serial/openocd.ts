/**
 * OpenOCD RTT wiring hypothesis. Discard this if a board needs a different
 * sequence. BenchLog does not flash and does not send `reset`.
 *
 * Spawn (only when `BENCHLOG_RTT_ATTACH` is unset):
 *   openocd -f <interface> -f <target>
 *     -c "tcl port <free>" -c "telnet port disabled" -c "gdb port disabled" -c "init"
 * Default interface is `interface/stlink.cfg`. Default target is `target/stm32f4x.cfg`
 * (`BENCHLOG_RTT_TARGET` / `serial_open` `target`). Both are guesses for a
 * generic ST-LINK plus STM32, not a detected chip.
 *
 * Control channel is the Tcl RPC socket: each command is one string ending in
 * 0x1a, and the reply ends in 0x1a (OpenOCD user's guide, Tcl RPC). On current
 * OpenOCD, `command_print` output becomes the Jim result, so `rtt channels`
 * comes back on that socket. The process log is scraped as well because
 * "Control block found" is LOG_INFO, and older builds may print tables only
 * on the console. `BENCHLOG_RTT_ATTACH=telnet://host:port` uses the telnet
 * prompt instead of 0x1a. `BENCHLOG_RTT_ATTACH=host:port` is Tcl.
 *
 * After init the Tcl session runs, best-effort and in this order:
 *   targets / adapter driver / flash banks / version
 *   rtt setup <address> <size> {<id>}     default 0x20000000, 131072 bytes, "SEGGER RTT"
 *   resume                                so a halted core can reach SEGGER_RTT_Init
 *   rtt start                             this is the control-block search, not the TCP server
 *   rtt channels
 *   rtt server start <port> <channel>     raw TCP bridge for that channel index
 * Channel bytes are the TCP server, not the Tcl socket. Default channel is 0
 * (`BENCHLOG_RTT_CHANNEL`). The 128KiB search is wider than the 2048-byte
 * example in the OpenOCD manual because that window misses a control block
 * placed later in SRAM. `rtt start` searches once.
 */
import { Buffer } from "node:buffer";
import * as net from "node:net";
import {
	type RttIdentity,
	type RttSearch,
	classifyRttProblem,
	formatOpenOcdMissing,
	formatRttProblem,
	parseAdapter,
	parseChip,
	parseControlBlock,
	parseOpenOcdVersion,
	parseRttChannels,
	scriptArg,
} from "./rtt.ts";

const START_TIMEOUT_MS = 8000;
const COMMAND_TIMEOUT_MS = 4000;
const LOG_CAP = 64_000;

type StreamEvent = { type: "data"; data: Buffer } | { type: "timeout" } | { type: "close" };

class ByteQueue {
	#chunks: Buffer[] = [];
	#waiters: Array<(event: StreamEvent) => void> = [];
	#closed = false;

	push(data: Buffer): void {
		if (data.length === 0) return;
		const waiter = this.#waiters.shift();
		if (waiter) waiter({ type: "data", data });
		else this.#chunks.push(data);
	}

	close(): void {
		this.#closed = true;
		const waiters = this.#waiters;
		this.#waiters = [];
		for (const waiter of waiters) waiter({ type: "close" });
	}

	next(timeoutMs: number): Promise<StreamEvent> {
		const queued = this.#chunks.shift();
		if (queued) return Promise.resolve({ type: "data", data: queued });
		if (this.#closed) return Promise.resolve({ type: "close" });
		const { promise, resolve } = Promise.withResolvers<StreamEvent>();
		let settled = false;
		const finish = (event: StreamEvent) => {
			if (settled) {
				if (event.type === "data") this.#chunks.push(event.data);
				return;
			}
			settled = true;
			resolve(event);
		};
		const waiter = (event: StreamEvent) => {
			clearTimeout(timer);
			finish(event);
		};
		const timer = setTimeout(
			() => {
				const index = this.#waiters.indexOf(waiter);
				if (index >= 0) this.#waiters.splice(index, 1);
				finish({ type: "timeout" });
			},
			Math.max(1, timeoutMs),
		);
		this.#waiters.push(waiter);
		return promise;
	}
}

function writeAll(socket: net.Socket, payload: Buffer): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	socket.write(payload, error => {
		if (error) reject(error);
		else resolve();
	});
	return promise;
}

function connectTcp(port: number, host: string, timeoutMs: number): Promise<net.Socket> {
	const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
	const socket = net.connect({ port, host });
	const timer = setTimeout(() => {
		socket.destroy();
		reject(new Error(`timed out connecting to ${host}:${port}`));
	}, timeoutMs);
	socket.once("connect", () => {
		clearTimeout(timer);
		resolve(socket);
	});
	socket.once("error", error => {
		clearTimeout(timer);
		reject(error);
	});
	return promise;
}

function listenPort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const server = net.createServer();
	server.unref();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		server.close(() => resolve(port));
	});
	return promise;
}

function pumpLog(stream: ReadableStream<Uint8Array> | number | null | undefined, log: (text: string) => void): void {
	if (!stream || typeof stream === "number") return;
	const reader = stream.getReader();
	void (async () => {
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				if (!value || value.byteLength === 0) continue;
				log(Buffer.from(value).toString("utf8"));
			}
		} catch {
			// The process was killed.
		}
	})();
}

function attachSocket(socket: net.Socket, queue: ByteQueue): void {
	socket.on("data", (data: Buffer) => {
		queue.push(data);
	});
	socket.on("error", () => {
		queue.close();
	});
	socket.on("close", () => {
		queue.close();
	});
}

interface Control {
	exec(command: string, timeoutMs: number): Promise<string>;
	close(): void;
}

class TclControl implements Control {
	#socket: net.Socket;
	#queue = new ByteQueue();
	#buffer = Buffer.alloc(0);

	constructor(socket: net.Socket) {
		this.#socket = socket;
		attachSocket(socket, this.#queue);
	}

	async exec(command: string, timeoutMs: number): Promise<string> {
		await writeAll(this.#socket, Buffer.from(`${command}\x1a`, "utf8"));
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const end = this.#buffer.indexOf(0x1a);
			if (end >= 0) {
				const body = this.#buffer.subarray(0, end).toString("utf8");
				this.#buffer = this.#buffer.subarray(end + 1);
				return body;
			}
			const event = await this.#queue.next(deadline - Date.now());
			if (event.type === "data") {
				this.#buffer = Buffer.concat([this.#buffer, event.data]);
				continue;
			}
			if (event.type === "close") throw new Error("OpenOCD Tcl connection closed");
			break;
		}
		throw new Error(`OpenOCD Tcl timed out after ${timeoutMs}ms`);
	}

	close(): void {
		this.#socket.destroy();
		this.#queue.close();
	}
}

/** Drop Telnet IAC negotiations. 0xff 0xff is an escaped 0xff byte. */
export function stripTelnet(input: Buffer): Buffer {
	const out: number[] = [];
	for (let index = 0; index < input.length; index++) {
		const byte = input[index];
		if (byte !== 255) {
			if (byte !== undefined) out.push(byte);
			continue;
		}
		const command = input[index + 1];
		if (command === undefined) break;
		if (command === 255) {
			out.push(255);
			index += 1;
			continue;
		}
		if (command === 250) {
			const end = input.indexOf(240, index + 2);
			if (end < 0) break;
			index = end;
			continue;
		}
		index += 2;
	}
	return Buffer.from(out);
}

class TelnetControl implements Control {
	#socket: net.Socket;
	#queue = new ByteQueue();
	#text = "";

	constructor(socket: net.Socket) {
		this.#socket = socket;
		attachSocket(socket, this.#queue);
	}

	async #readUntilPrompt(timeoutMs: number): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const prompt = /(^|\n)> $/.exec(this.#text);
			if (prompt && typeof prompt.index === "number") {
				const body = this.#text.slice(0, prompt.index);
				this.#text = this.#text.slice(prompt.index + prompt[0].length);
				return body;
			}
			const event = await this.#queue.next(deadline - Date.now());
			if (event.type === "data") {
				this.#text += stripTelnet(event.data).toString("utf8");
				continue;
			}
			if (event.type === "close") throw new Error("OpenOCD telnet connection closed");
			break;
		}
		throw new Error(`OpenOCD telnet timed out after ${timeoutMs}ms`);
	}

	async banner(timeoutMs: number): Promise<void> {
		await this.#readUntilPrompt(timeoutMs);
	}

	async exec(command: string, timeoutMs: number): Promise<string> {
		await writeAll(this.#socket, Buffer.from(`${command}\r\n`, "utf8"));
		let body = await this.#readUntilPrompt(timeoutMs);
		const echo = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		body = body.replace(new RegExp(`^\\s*${echo}\\s*\\r?\\n?`), "");
		return body.trim();
	}

	close(): void {
		this.#socket.destroy();
		this.#queue.close();
	}
}

const liveProcs = new Set<Bun.Subprocess>();
let exitHooked = false;

function trackProc(proc: Bun.Subprocess): void {
	liveProcs.add(proc);
	proc.unref();
	if (exitHooked) return;
	exitHooked = true;
	process.on("exit", () => {
		for (const child of liveProcs) {
			try {
				child.kill("SIGKILL");
			} catch {
				// The helper already exited.
			}
		}
	});
}

function childEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") env[key] = value;
	}
	return env;
}

function looksLikeCommandError(text: string): boolean {
	return /invalid command|unknown command|command not found|is not a valid/i.test(text);
}

export interface OpenRttOptions {
	attach: string | undefined;
	openocd: string | null;
	target: string;
	interfaceCfg: string;
	search: RttSearch;
	channel: number;
}

export class OpenOcdLink {
	readonly transport: "openocd-tcl" | "openocd-telnet";
	info: RttIdentity;
	#control: Control;
	#channel: net.Socket;
	#channelQueue = new ByteQueue();
	#partial = "";
	#proc: Bun.Subprocess | undefined;
	#log: string;
	#closed = false;

	constructor(input: {
		transport: "openocd-tcl" | "openocd-telnet";
		info: RttIdentity;
		control: Control;
		channel: net.Socket;
		proc?: Bun.Subprocess;
		log: string;
	}) {
		this.transport = input.transport;
		this.info = input.info;
		this.#control = input.control;
		this.#channel = input.channel;
		this.#proc = input.proc;
		this.#log = input.log;
		attachSocket(input.channel, this.#channelQueue);
	}

	log(): string {
		return this.#log;
	}

	async refreshChannels(): Promise<void> {
		const text = await this.#control.exec("rtt channels", COMMAND_TIMEOUT_MS);
		const channels = parseRttChannels(`${text}\n${this.#log}`);
		if (channels.length > 0) this.info = { ...this.info, channels };
		const controlBlock = parseControlBlock(`${text}\n${this.#log}`);
		if (controlBlock) this.info = { ...this.info, controlBlock };
	}

	async readLines(maxLines: number, timeoutMs: number): Promise<{ lines: string[]; raw: Uint8Array }> {
		const lines: string[] = [];
		const rawParts: Buffer[] = [];
		const deadline = Date.now() + timeoutMs;
		while (lines.length < maxLines) {
			this.#takeLines(lines, maxLines);
			if (lines.length >= maxLines) break;
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			const slice = lines.length > 0 ? Math.min(remaining, 40) : remaining;
			const event = await this.#channelQueue.next(slice);
			if (event.type === "data") {
				rawParts.push(event.data);
				this.#partial += event.data.toString("utf8");
				continue;
			}
			if (event.type === "close" || lines.length > 0) break;
		}
		this.#takeLines(lines, maxLines);
		const raw = rawParts.length > 0 ? Buffer.concat(rawParts) : Buffer.alloc(0);
		return { lines, raw: new Uint8Array(raw) };
	}

	async write(data: string): Promise<number> {
		const payload = Buffer.from(data, "utf8");
		await writeAll(this.#channel, payload);
		return payload.length;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		try {
			void this.#control.exec("shutdown", 300).catch(() => undefined);
		} catch {
			// The control socket is already gone.
		}
		this.#control.close();
		this.#channel.destroy();
		this.#channelQueue.close();
		const proc = this.#proc;
		if (proc) {
			liveProcs.delete(proc);
			if (proc.exitCode === null) {
				try {
					proc.kill("SIGKILL");
				} catch {
					// The process already exited.
				}
			}
		}
	}

	#takeLines(lines: string[], maxLines: number): void {
		while (lines.length < maxLines) {
			const newline = this.#partial.indexOf("\n");
			if (newline < 0) return;
			const line = this.#partial.slice(0, newline).replace(/\r$/, "");
			this.#partial = this.#partial.slice(newline + 1);
			lines.push(line);
		}
	}
}

function parseAttach(
	attach: string,
): { transport: "openocd-tcl" | "openocd-telnet"; host: string; port: number } | undefined {
	const telnet = /^telnet:\/\/([^:/]+):(\d+)$/.exec(attach.trim());
	if (telnet?.[1] && telnet[2]) return { transport: "openocd-telnet", host: telnet[1], port: Number(telnet[2]) };
	const tcl = /^([^:/]+):(\d+)$/.exec(attach.trim());
	if (tcl?.[1] && tcl[2]) return { transport: "openocd-tcl", host: tcl[1], port: Number(tcl[2]) };
	return undefined;
}

async function openControl(transport: "openocd-tcl" | "openocd-telnet", host: string, port: number): Promise<Control> {
	const socket = await connectTcp(port, host, 2000);
	if (transport === "openocd-telnet") {
		const telnet = new TelnetControl(socket);
		await telnet.banner(COMMAND_TIMEOUT_MS);
		return telnet;
	}
	return new TclControl(socket);
}

export async function openRttLink(
	options: OpenRttOptions,
): Promise<{ ok: true; link: OpenOcdLink } | { ok: false; error: string }> {
	const attach = options.attach?.trim() ?? "";
	if (attach !== "") return openAttached(options, attach);
	if (!options.openocd)
		return { ok: false, error: formatOpenOcdMissing("BENCHLOG_OPENOCD is unset and `openocd` is not on PATH.") };
	return openSpawned(options, options.openocd);
}

async function openAttached(
	options: OpenRttOptions,
	attach: string,
): Promise<{ ok: true; link: OpenOcdLink } | { ok: false; error: string }> {
	const parsed = parseAttach(attach);
	if (!parsed) {
		return {
			ok: false,
			error: formatOpenOcdMissing(
				`BENCHLOG_RTT_ATTACH must be host:port (Tcl) or telnet://host:port. Got ${JSON.stringify(attach)}.`,
			),
		};
	}
	let control: Control;
	try {
		control = await openControl(parsed.transport, parsed.host, parsed.port);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			error: formatOpenOcdMissing(
				`nothing accepted ${parsed.transport} at ${parsed.host}:${parsed.port} (${message}).`,
			),
		};
	}
	return handshake(options, {
		transport: parsed.transport,
		control,
		log: "",
		appendLog: () => undefined,
		proc: undefined,
	});
}

async function openSpawned(
	options: OpenRttOptions,
	binary: string,
): Promise<{ ok: true; link: OpenOcdLink } | { ok: false; error: string }> {
	const tclPort = await listenPort();
	const args = [
		binary,
		"-f",
		scriptArg("interface", options.interfaceCfg),
		"-f",
		scriptArg("target", options.target),
		"-c",
		`tcl port ${tclPort}`,
		"-c",
		"telnet port disabled",
		"-c",
		"gdb port disabled",
		"-c",
		"init",
	];
	let proc: Bun.Subprocess;
	try {
		proc = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: childEnv() });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const kind = classifyRttProblem(message) ?? "openocd-missing";
		return { ok: false, error: formatRttProblem(kind, options.search, message) };
	}
	trackProc(proc);
	let log = "";
	const appendLog = (text: string) => {
		log = `${log}${text}`.slice(-LOG_CAP);
	};
	pumpLog(proc.stdout, appendLog);
	pumpLog(proc.stderr, appendLog);

	const deadline = Date.now() + START_TIMEOUT_MS;
	let control: Control | undefined;
	let lastError = "";
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) {
			await Bun.sleep(30);
			const kind = classifyRttProblem(log);
			liveProcs.delete(proc);
			if (kind)
				return {
					ok: false,
					error: formatRttProblem(kind, options.search, log || lastError || "OpenOCD exited during init"),
				};
			const detail = (log || lastError || "no log").trim().slice(0, 500);
			return { ok: false, error: `OpenOCD exited during init. ${detail}` };
		}
		try {
			control = await openControl("openocd-tcl", "127.0.0.1", tclPort);
			break;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			await Bun.sleep(50);
		}
	}
	if (!control) {
		try {
			proc.kill("SIGKILL");
		} catch {
			// already gone
		}
		liveProcs.delete(proc);
		const kind = classifyRttProblem(log);
		if (kind) return { ok: false, error: formatRttProblem(kind, options.search, log || lastError) };
		return {
			ok: false,
			error: formatOpenOcdMissing(`OpenOCD did not accept Tcl on 127.0.0.1:${tclPort}. ${log || lastError}`),
		};
	}
	return handshake(options, {
		transport: "openocd-tcl",
		control,
		log,
		appendLog: (text: string) => {
			log = `${log}${text}`.slice(-LOG_CAP);
		},
		proc,
		readLog: () => log,
	});
}

async function handshake(
	options: OpenRttOptions,
	session: {
		transport: "openocd-tcl" | "openocd-telnet";
		control: Control;
		log: string;
		appendLog: (text: string) => void;
		proc?: Bun.Subprocess;
		readLog?: () => string;
	},
): Promise<{ ok: true; link: OpenOcdLink } | { ok: false; error: string }> {
	const transcript: string[] = [];
	const exec = async (command: string): Promise<string> => {
		const text = await session.control.exec(command, COMMAND_TIMEOUT_MS);
		transcript.push(text);
		session.appendLog(text.endsWith("\n") ? text : `${text}\n`);
		return text;
	};
	const fail = (error: string) => {
		session.control.close();
		if (session.proc) {
			liveProcs.delete(session.proc);
			try {
				session.proc.kill("SIGKILL");
			} catch {
				// already exited
			}
		}
		return { ok: false as const, error };
	};
	const currentLog = () => `${session.readLog ? session.readLog() : session.log}\n${transcript.join("\n")}`;

	try {
		const versionText = await exec("version");
		const targets = await exec("targets");
		let adapterText = await exec("adapter driver");
		if (looksLikeCommandError(adapterText) || parseAdapter(adapterText) === null) {
			const fallback = await exec("interface");
			if (parseAdapter(fallback)) adapterText = fallback;
		}
		const flash = await exec("flash banks");
		const setup = `rtt setup ${options.search.address} ${options.search.size} {${options.search.id}}`;
		const setupText = await exec(setup);
		const setupKind = classifyRttProblem(`${setupText}\n${currentLog()}`);
		if (setupKind === "no-stlink" || setupKind === "openocd-missing") {
			return fail(formatRttProblem(setupKind, options.search, currentLog()));
		}
		try {
			await exec("resume");
		} catch {
			// Already running, or this target has no resume. The search still runs.
		}
		const started = await exec("rtt start");
		const startedKind = classifyRttProblem(`${started}\n${currentLog()}`);
		if (startedKind) return fail(formatRttProblem(startedKind, options.search, currentLog()));
		const channelsText = await exec("rtt channels");
		const channels = parseRttChannels(`${channelsText}\n${currentLog()}`);
		const controlBlock = parseControlBlock(currentLog());
		const afterChannels = classifyRttProblem(`${channelsText}\n${currentLog()}`);
		if (channels.length === 0 && (afterChannels === "no-rtt" || !controlBlock)) {
			return fail(formatRttProblem("no-rtt", options.search, currentLog()));
		}
		const serverPort = await listenPort();
		const serverText = await exec(`rtt server start ${serverPort} ${options.channel}`);
		const serverKind = classifyRttProblem(`${serverText}\n${currentLog()}`);
		if (serverKind) return fail(formatRttProblem(serverKind, options.search, serverText || currentLog()));
		if (/couldn't|could not|error:|failed/i.test(serverText)) {
			return fail(
				`RTT channel: OpenOCD refused \`rtt server start\` (${serverText.trim().slice(0, 400)}). The control block step already finished.`,
			);
		}
		let channel: net.Socket;
		try {
			channel = await connectTcp(serverPort, "127.0.0.1", 2000);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return fail(
				`RTT channel: \`rtt server start ${serverPort} ${options.channel}\` did not accept a TCP client (${message}). ${serverText.trim()}`.trim(),
			);
		}
		const info: RttIdentity = {
			transport: session.transport,
			chip: parseChip(targets, flash),
			adapter: parseAdapter(adapterText),
			controlBlock,
			channels,
			openocd: parseOpenOcdVersion(`${versionText}\n${currentLog()}`),
			search: options.search,
		};
		return {
			ok: true,
			link: new OpenOcdLink({
				transport: session.transport,
				info,
				control: session.control,
				channel,
				proc: session.proc,
				log: currentLog(),
			}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const kind = classifyRttProblem(`${message}\n${currentLog()}`) ?? "no-rtt";
		return fail(formatRttProblem(kind, options.search, message));
	}
}
