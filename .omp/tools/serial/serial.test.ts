/**
 * Contracts for the BenchLog serial tools:
 * - fixture list/open/probe still works when the Python interpreter is missing
 * - sniff classification distinguishes AT, boot banners, ASCII, and binary
 * - a pty opened through pyserial can be listed-by-path, read, written, and probed
 * - fixture RTT works with no OpenOCD and no ST-LINK
 * - OpenOCD-missing, no-VCP, and no-RTT-control-block errors stay distinct
 * - a fake Tcl (and telnet) OpenOCD exposes channel names and a byte stream
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import { classifySniff, FIXTURE_PORT_ID, RTT_FIXTURE_PORT_ID, SERIAL_FIXTURE_ENV, resetSerialHub } from "./backend.ts";
import { stripTelnet } from "./openocd.ts";
import { classifyRttProblem, parseChip, parseRttChannels } from "./rtt.ts";
import factory from "./index.ts";

const HELPER = `${import.meta.dir}/uart.py`;
const PYTHON_OVERRIDE = "BENCHLOG_SERIAL_PYTHON";
const tools = factory({ zod });

function tool(name: string) {
	const found = tools.find(item => item.name === name);
	if (!found) throw new Error(`missing ${name}`);
	return found;
}

async function call(name: string, params: Record<string, unknown> = {}) {
	return tool(name).execute("test", params);
}

const ENV_KEYS = [
	SERIAL_FIXTURE_ENV,
	PYTHON_OVERRIDE,
	"BENCHLOG_OPENOCD",
	"BENCHLOG_RTT_ATTACH",
	"BENCHLOG_RTT_SYSFS",
	"BENCHLOG_RTT_SEARCH",
	"BENCHLOG_RTT_TARGET",
	"BENCHLOG_RTT_CHANNEL",
	"BENCHLOG_RTT_INTERFACE",
	"BENCHLOG_RTT_ID",
];
const previousEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));

afterEach(() => {
	resetSerialHub();
	for (const key of ENV_KEYS) {
		const previous = previousEnv.get(key);
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	}
});

describe("sniff classification", () => {
	it("separates empty, AT, boot banners, plain ASCII, and binary", () => {
		expect(classifySniff(new Uint8Array()).kind).toBe("empty");
		const at = classifySniff(new TextEncoder().encode("AT+GMR\r\nOK\r\n"));
		expect(at.kind).toBe("at");
		const boot = classifySniff(new TextEncoder().encode("[    0.000] firmware boot\nreset cause: power-on\n"));
		expect(boot.kind).toBe("ascii-boot");
		expect(classifySniff(new TextEncoder().encode("hello from the port\n")).kind).toBe("ascii");
		expect(classifySniff(new Uint8Array(32).fill(0xff)).kind).toBe("binary");
	});
});

describe("probe approval tier", () => {
	it("stays read for the fixture and exec for a host port or unknown session", async () => {
		delete process.env[SERIAL_FIXTURE_ENV];
		const approval = tool("serial_probe").approval;
		if (typeof approval !== "function") throw new Error("serial_probe approval should depend on the target");
		expect(approval({ port: FIXTURE_PORT_ID })).toBe("read");
		expect(approval({})).toBe("exec");
		expect(approval({ port: "/dev/ttyACM0" })).toBe("exec");
		expect(approval({ sessionId: "ser-missing" })).toBe("exec");
		const opened = await call("serial_open", { port: "fixture" });
		expect(opened.isError).toBeUndefined();
		expect(approval({ sessionId: "ser-1" })).toBe("read");
		process.env[SERIAL_FIXTURE_ENV] = "1";
		expect(approval({})).toBe("read");
	});
});

describe("fixture without a Python interpreter", () => {
	it("still lists and probes the shipped boot log", async () => {
		process.env[PYTHON_OVERRIDE] = "/no/such/benchlog-python";
		process.env[SERIAL_FIXTURE_ENV] = "1";
		const listed = await call("serial_list");
		expect(listed.isError).toBeUndefined();
		expect(listed.content[0].text).toContain(FIXTURE_PORT_ID);
		expect(listed.content[0].text).toContain("uart enumeration:");
		expect(listed.content[0].text).toContain("/no/such/benchlog-python");
		const ports = (listed.details as { ports: Array<{ id: string; backend: string }> }).ports;
		expect(ports.some(port => port.id === FIXTURE_PORT_ID && port.backend === "fixture")).toBe(true);
		expect(ports.some(port => port.id === RTT_FIXTURE_PORT_ID && port.backend === "rtt")).toBe(true);
		expect(ports.every(port => port.backend === "fixture" || port.backend === "uart" || port.backend === "rtt")).toBe(
			true,
		);

		const probed = await call("serial_probe");
		expect(probed.isError).toBeUndefined();
		const details = probed.details as { backend: string; sample: { board: string | null }; unknowns: string[] };
		expect(details.backend).toBe("fixture");
		expect(details.sample.board).toBe("benchlog-fixture");
		expect(details.unknowns).toContain("usb.serialNumber");
	});
});

describe("missing host device", () => {
	it("names the path and points at the unimplemented flash/reset cut", async () => {
		delete process.env[SERIAL_FIXTURE_ENV];
		delete process.env[PYTHON_OVERRIDE];
		const host = await call("serial_open", { port: "/dev/benchlog-no-such-uart" });
		expect(host.isError).toBe(true);
		expect(host.content[0].text).toContain("/dev/benchlog-no-such-uart");
		expect(host.content[0].text).toContain("serial_flash");
		expect(host.content[0].text).toContain("No VCP:");
		expect(host.content[0].text.includes("not in this cut")).toBe(false);
		expect(host.content[0].text.includes("OpenOCD missing:")).toBe(false);
		expect(host.content[0].text.includes("No RTT control block:")).toBe(false);
	});
});

describe("host UART through a pty", () => {
	it("opens, reads, writes, and probes bytes looped through pyserial", async () => {
		delete process.env[SERIAL_FIXTURE_ENV];
		delete process.env[PYTHON_OVERRIDE];
		const python = Bun.which("python3") ?? Bun.which("python");
		if (!python) throw new Error("python3 is required to exercise the pyserial pty contract");
		const filter = Bun.spawn([python, "-u", HELPER, "--self-test"], { stdout: "pipe", stderr: "pipe" });
		const filterText = await new Response(filter.stdout).text();
		expect(await filter.exited).toBe(0);
		expect(filterText).toContain('"ok": true');

		const peer = Bun.spawn([python, "-u", HELPER, "--pty-peer"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
		});
		try {
			const path = await readPeerPath(peer.stdout);
			const opened = await call("serial_open", { port: path, baud: 9600 });
			expect(opened.isError).toBeUndefined();
			expect(opened.content[0].text).toContain("backend uart");
			expect(opened.content[0].text).toContain("baud 9600");
			const again = await call("serial_open", { port: path, baud: 9600 });
			expect(again.content[0].text).toContain("session ser-1");

			peer.stdin.write("hello-board\n");
			await peer.stdin.flush();
			await Bun.sleep(80);
			const chunk = await call("serial_read", { sessionId: "ser-1", maxLines: 5 });
			expect(chunk.isError).toBeUndefined();
			expect(chunk.content[0].text).toContain("hello-board");
			expect(chunk.content[0].text).toContain("backend uart");
			expect(chunk.content[0].text).toContain("eof false");

			const wrote = await call("serial_write", { sessionId: "ser-1", data: "ping\n" });
			expect(wrote.isError).toBeUndefined();
			expect(wrote.content[0].text).toContain("backend uart");
			expect(wrote.content[0].text).not.toContain("echo:");
			await Bun.sleep(80);
			const ack = await call("serial_read", { sessionId: "ser-1", maxLines: 5 });
			expect(ack.content[0].text).toContain("ack:ping");

			peer.stdin.write("probe-me\n");
			await peer.stdin.flush();
			await Bun.sleep(80);
			const probed = await call("serial_probe", { sessionId: "ser-1" });
			expect(probed.isError).toBeUndefined();
			const details = probed.details as {
				backend: string;
				sniffDisposition: string;
				sniff: { kind: string; textPreview: string };
				unknowns: string[];
				usb: { vid: string | null };
			};
			expect(details.backend).toBe("uart");
			expect(details.sniffDisposition).toBe("buffered-for-serial-read");
			expect(details.sniff.textPreview).toContain("probe-me");
			expect(details.sniff.kind).toBe("ascii");
			expect(details.usb.vid).toBeNull();
			expect(details.unknowns).toContain("usb.vid");
			const replay = await call("serial_read", { sessionId: "ser-1", maxLines: 5 });
			expect(replay.content[0].text).toContain("probe-me");
			const drained = await call("serial_read", { sessionId: "ser-1", maxLines: 5 });
			expect(drained.content[0].text).toContain("(no new lines)");
			expect(drained.content[0].text).not.toContain("probe-me");
		} finally {
			try {
				peer.kill("SIGKILL");
			} catch {
				// The peer already exited.
			}
		}
	}, 15000);
});

async function readPeerPath(stdout: ReadableStream<Uint8Array> | number | undefined | null): Promise<string> {
	if (!stdout || typeof stdout === "number") throw new Error("pty peer stdout was not a pipe");
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const deadline = Date.now() + 3000;
	while (!buffer.includes("\n")) {
		if (Date.now() > deadline) throw new Error(`pty peer produced no path: ${buffer}`);
		const { value, done } = await reader.read();
		if (done) throw new Error(`pty peer exited before a path: ${buffer}`);
		buffer += decoder.decode(value, { stream: true });
	}
	const line = buffer.slice(0, buffer.indexOf("\n"));
	const parsed = JSON.parse(line) as { path?: string };
	if (!parsed.path) throw new Error(`pty peer path missing: ${line}`);
	return parsed.path;
}

describe("RTT text from OpenOCD", () => {
	it("reads channel names and sizes, and keeps the three failure labels apart", () => {
		const channels = parseRttChannels(
			[
				"Channels: up=2, down=1",
				"Up-channels:",
				"0: Terminal 1024 0",
				"1: My Logger 256 0",
				"Down-channels:",
				"0: Terminal 16 2",
			].join("\n"),
		);
		expect(channels.map(channel => `${channel.direction}:${channel.index}:${channel.name}:${channel.size}`)).toEqual([
			"up:0:Terminal:1024",
			"up:1:My Logger:256",
			"down:0:Terminal:16",
		]);
		expect(parseChip(" 0* stm32f4x.cpu cortex_m", "#0 : stm32f4x.flash (stm32f2x) at 0x08000000, size 0x1000")).toBe(
			"stm32f4x.flash (stm32f2x)",
		);
		expect(classifyRttProblem("rtt: No control block found")).toBe("no-rtt");
		expect(classifyRttProblem("Error: open failed")).toBe("no-stlink");
		expect(classifyRttProblem("ENOENT: no such file or directory, posix_spawn openocd")).toBe("openocd-missing");
		expect([...stripTelnet(Buffer.from([255, 251, 1, 65, 255, 255]))]).toEqual([65, 255]);
	});
});

describe("fixture RTT without hardware", () => {
	it("lists, probes, reads, and writes the sample, and stays read-tier", async () => {
		delete process.env[SERIAL_FIXTURE_ENV];
		delete process.env.BENCHLOG_RTT_ATTACH;
		const openApproval = tool("serial_open").approval;
		const probeApproval = tool("serial_probe").approval;
		if (typeof openApproval !== "function" || typeof probeApproval !== "function") {
			throw new Error("open and probe approval should depend on the port");
		}
		expect(openApproval({ port: RTT_FIXTURE_PORT_ID })).toBe("read");
		expect(openApproval({ port: "rtt://stlink-0" })).toBe("exec");
		expect(openApproval({ port: "/dev/ttyACM0" })).toBe("read");
		expect(probeApproval({ port: RTT_FIXTURE_PORT_ID })).toBe("read");
		expect(probeApproval({ port: "rtt://stlink-0" })).toBe("exec");

		const opened = await call("serial_open", { port: RTT_FIXTURE_PORT_ID });
		expect(opened.isError).toBeUndefined();
		expect(opened.content[0].text).toContain("backend rtt");
		expect(probeApproval({ sessionId: "ser-1" })).toBe("read");

		const probed = await call("serial_probe", { sessionId: "ser-1" });
		expect(probed.isError).toBeUndefined();
		const details = probed.details as {
			backend: string;
			rtt: {
				chip: string | null;
				adapter: string | null;
				channels: Array<{ name: string; size: number; direction: string }>;
			};
			unknowns: string[];
			sample: { board: string | null; firmware: string | null };
		};
		expect(details.backend).toBe("rtt");
		expect(details.rtt.chip).toContain("STM32F407VG");
		expect(details.rtt.adapter).toBeNull();
		expect(details.rtt.channels).toContainEqual({
			direction: "up",
			index: 0,
			name: "Terminal",
			size: 1024,
			flags: 0,
		});
		expect(details.unknowns).toContain("adapter");
		expect(details.unknowns).toContain("controlBlock");
		expect(details.sample.board).toBe("benchlog-rtt-fixture");
		expect(details.sample.firmware).toBe("rtt-fixture-1");

		const chunk = await call("serial_read", { sessionId: "ser-1", maxLines: 2 });
		expect(chunk.content[0].text).toContain("BenchLog fixture RTT console");
		expect(chunk.content[0].text).toContain("backend rtt");
		const wrote = await call("serial_write", { sessionId: "ser-1", data: "help\n" });
		expect(wrote.content[0].text).toContain("echo: help");
		const follow = await call("serial_read", { sessionId: "ser-1", maxLines: 200 });
		expect(follow.content[0].text).toContain("[rtt] tx: help");
		expect(follow.content[0].text).toContain("[rtt] rx: ack");
	});
});

describe("RTT failure labels", () => {
	it("says OpenOCD is missing without calling that a missing VCP or a missing control block", async () => {
		delete process.env.BENCHLOG_RTT_ATTACH;
		process.env.BENCHLOG_OPENOCD = "/no/such/benchlog-openocd";
		const opened = await call("serial_open", { port: "rtt://stlink-0" });
		expect(opened.isError).toBe(true);
		expect(opened.content[0].text).toContain("OpenOCD missing:");
		expect(opened.content[0].text.includes("No VCP:")).toBe(false);
		expect(opened.content[0].text.includes("No RTT control block:")).toBe(false);
		expect(opened.content[0].text).toContain(RTT_FIXTURE_PORT_ID);
	});

	it("lists rtt://stlink-0 only when OpenOCD and a real ST-LINK id are both visible", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "benchlog-rtt-"));
		try {
			await fs.mkdir(path.join(root, "1-1"), { recursive: true });
			await Bun.write(path.join(root, "1-1", "idVendor"), "0483\n");
			await Bun.write(path.join(root, "1-1", "idProduct"), "374b\n");
			await Bun.write(path.join(root, "1-1", "serial"), "SN1\n");
			await Bun.write(path.join(root, "1-1", "product"), "ST-LINK/V2.1\n");
			await fs.mkdir(path.join(root, "1-2"), { recursive: true });
			await Bun.write(path.join(root, "1-2", "idVendor"), "0483\n");
			await Bun.write(path.join(root, "1-2", "idProduct"), "5740\n");
			process.env.BENCHLOG_RTT_SYSFS = root;
			process.env.BENCHLOG_OPENOCD = path.join(import.meta.dir, "fixtures", "rtt-sample.txt");
			const listed = await call("serial_list");
			const ports = (listed.details as { ports: Array<{ id: string; backend: string }> }).ports;
			expect(ports.some(port => port.id === "rtt://stlink-0" && port.backend === "rtt")).toBe(true);
			expect(ports.some(port => port.id.includes("5740"))).toBe(false);
			expect(listed.content[0].text).toContain("rtt candidate: rtt://stlink-0");

			process.env.BENCHLOG_OPENOCD = "/no/such/benchlog-openocd";
			const hidden = await call("serial_list");
			const hiddenPorts = (hidden.details as { ports: Array<{ id: string }> }).ports;
			expect(hiddenPorts.some(port => port.id === RTT_FIXTURE_PORT_ID)).toBe(true);
			expect(hiddenPorts.some(port => port.id === "rtt://stlink-0")).toBe(false);
			expect(hidden.content[0].text).toContain("OpenOCD missing:");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("OpenOCD RTT over a fake control port", () => {
	it("reads and writes channel bytes and reports buffer names when Tcl says the control block exists", async () => {
		const fake = await startFakeOpenOcd("tcl", "ok");
		try {
			process.env.BENCHLOG_RTT_ATTACH = `127.0.0.1:${fake.port}`;
			const opened = await call("serial_open", { port: "rtt://openocd" });
			expect(opened.isError).toBeUndefined();
			expect(opened.content[0].text).toContain("backend rtt");
			const probeApproval = tool("serial_probe").approval;
			if (typeof probeApproval !== "function") throw new Error("probe approval should be a function");
			expect(probeApproval({ sessionId: "ser-1" })).toBe("exec");

			const probed = await call("serial_probe", { sessionId: "ser-1" });
			expect(probed.isError).toBeUndefined();
			const details = probed.details as {
				backend: string;
				sniffDisposition: string;
				rtt: {
					transport: string;
					chip: string | null;
					adapter: string | null;
					controlBlock: string | null;
					channels: Array<{ name: string; size: number }>;
					openocd: string | null;
				};
			};
			expect(details.backend).toBe("rtt");
			expect(details.sniffDisposition).toBe("buffered-for-serial-read");
			expect(details.rtt.transport).toBe("openocd-tcl");
			expect(details.rtt.chip).toContain("stm32f4x.flash");
			expect(details.rtt.adapter).toBe("stlink");
			expect(details.rtt.controlBlock).toBe("0x20001234");
			expect(details.rtt.channels.some(channel => channel.name === "Terminal" && channel.size === 1024)).toBe(true);
			expect(details.rtt.openocd).toBe("0.12.0");

			const replay = await call("serial_read", { sessionId: "ser-1", maxLines: 5 });
			expect(replay.content[0].text).toContain("hello-rtt");
			const wrote = await call("serial_write", { sessionId: "ser-1", data: "ping\n" });
			expect(wrote.isError).toBeUndefined();
			expect(wrote.content[0].text).not.toContain("echo:");
			const ack = await call("serial_read", { sessionId: "ser-1", maxLines: 5 });
			expect(ack.content[0].text).toContain("ack:ping");
		} finally {
			resetSerialHub();
			await fake.close();
		}
	}, 15000);

	it("reports a missing control block from Tcl without blaming the VCP or a missing binary", async () => {
		const fake = await startFakeOpenOcd("tcl", "no-rtt");
		try {
			process.env.BENCHLOG_RTT_ATTACH = `127.0.0.1:${fake.port}`;
			const opened = await call("serial_open", { port: "rtt://openocd" });
			expect(opened.isError).toBe(true);
			expect(opened.content[0].text).toContain("No RTT control block:");
			expect(opened.content[0].text.includes("No VCP:")).toBe(false);
			expect(opened.content[0].text.includes("OpenOCD missing:")).toBe(false);
		} finally {
			resetSerialHub();
			await fake.close();
		}
	}, 15000);

	it("drives the same channel stream through a telnet prompt", async () => {
		const fake = await startFakeOpenOcd("telnet", "ok");
		try {
			process.env.BENCHLOG_RTT_ATTACH = `telnet://127.0.0.1:${fake.port}`;
			const opened = await call("serial_open", { port: "rtt://openocd" });
			expect(opened.isError).toBeUndefined();
			const chunk = await call("serial_read", { sessionId: "ser-1", maxLines: 5 });
			expect(chunk.content[0].text).toContain("hello-rtt");
			const probed = await call("serial_probe", { sessionId: "ser-1" });
			const details = probed.details as { rtt: { transport: string; adapter: string | null } };
			expect(details.rtt.transport).toBe("openocd-telnet");
			expect(details.rtt.adapter).toBe("stlink");
		} finally {
			resetSerialHub();
			await fake.close();
		}
	}, 15000);
});

const RTT_CHANNEL_TABLE = [
	"Channels: up=2, down=1",
	"Up-channels:",
	"0: Terminal 1024 0",
	"1: Logger 256 0",
	"Down-channels:",
	"0: Terminal 16 0",
].join("\n");

function fakeCommand(command: string, mode: "ok" | "no-rtt"): string | undefined {
	const text = command.trim();
	if (text === "version") return "Open On-Chip Debugger 0.12.0";
	if (text === "targets") return " 0* stm32f4x.cpu cortex_m little stm32f4x.cpu running";
	if (text === "adapter driver" || text === "interface") return "stlink";
	if (text === "flash banks")
		return "#0 : stm32f4x.flash (stm32f2x) at 0x08000000, size 0x00100000, buswidth 0, chipwidth 0";
	if (text.startsWith("rtt setup") || text === "resume" || text === "shutdown") return "";
	if (text === "rtt start")
		return mode === "no-rtt" ? "rtt: No control block found" : "rtt: Control block found at 0x20001234";
	if (text === "rtt channels") return RTT_CHANNEL_TABLE;
	return undefined;
}

async function listenRttBytes(port: number): Promise<net.Server> {
	const { promise, resolve, reject } = Promise.withResolvers<net.Server>();
	const server = net.createServer(socket => {
		socket.on("error", () => undefined);
		socket.write("hello-rtt\n");
		socket.on("data", data => {
			const text = data.toString("utf8").replace(/\r?\n$/, "");
			socket.write(`ack:${text}\n`);
		});
	});
	server.once("error", reject);
	server.listen(port, "127.0.0.1", () => resolve(server));
	return promise;
}

async function startFakeOpenOcd(
	transport: "tcl" | "telnet",
	mode: "ok" | "no-rtt",
): Promise<{ port: number; close: () => Promise<void> }> {
	const extras: net.Server[] = [];
	const sockets = new Set<net.Socket>();
	const { promise, resolve, reject } = Promise.withResolvers<net.Server>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on("close", () => {
			sockets.delete(socket);
		});
		socket.on("error", () => undefined);
		if (transport === "telnet") {
			socket.write("Open On-Chip Debugger 0.12.0\r\n> ");
			let pending = "";
			socket.on("data", data => {
				pending += data.toString("utf8");
				let newline = pending.indexOf("\n");
				while (newline >= 0) {
					const line = pending.slice(0, newline).replace(/\r$/, "");
					pending = pending.slice(newline + 1);
					void answer(line);
					newline = pending.indexOf("\n");
				}
			});
			const answer = async (line: string) => {
				const port = /rtt server start (\d+)/.exec(line)?.[1];
				if (port) {
					extras.push(await listenRttBytes(Number(port)));
					socket.write("\r\n> ");
					return;
				}
				socket.write(`${fakeCommand(line, mode) ?? ""}\r\n> `);
			};
			return;
		}
		let buffer = Buffer.alloc(0);
		socket.on("data", data => {
			buffer = Buffer.concat([buffer, data]);
			void drain();
		});
		let draining = false;
		const drain = async () => {
			if (draining) return;
			draining = true;
			try {
				while (true) {
					const end = buffer.indexOf(0x1a);
					if (end < 0) return;
					const command = buffer.subarray(0, end).toString("utf8");
					buffer = buffer.subarray(end + 1);
					const port = /rtt server start (\d+)/.exec(command)?.[1];
					if (port) extras.push(await listenRttBytes(Number(port)));
					const body = fakeCommand(command, mode) ?? "";
					socket.write(Buffer.concat([Buffer.from(body, "utf8"), Buffer.from([0x1a])]));
				}
			} finally {
				draining = false;
				if (buffer.indexOf(0x1a) >= 0) void drain();
			}
		};
	});
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => resolve(server));
	const listening = await promise;
	const address = listening.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return {
		port,
		async close() {
			for (const socket of sockets) socket.destroy();
			const closing = Promise.all(
				[listening, ...extras].map(item => {
					const { promise: closed, resolve: resolveClose } = Promise.withResolvers<void>();
					item.close(() => resolveClose());
					return closed;
				}),
			);
			await Promise.race([closing, Bun.sleep(500)]);
		},
	};
}
