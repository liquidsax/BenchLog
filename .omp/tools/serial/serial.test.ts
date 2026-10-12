/**
 * Contracts for the BenchLog serial tools:
 * - fixture list/open/probe still works when the Python interpreter is missing
 * - sniff classification distinguishes AT, boot banners, ASCII, and binary
 * - a pty opened through pyserial can be listed-by-path, read, written, and probed
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as zod from "@oh-my-pi/omptype/zod";
import { classifySniff, FIXTURE_PORT_ID, SERIAL_FIXTURE_ENV, resetSerialHub } from "./backend.ts";
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

const previousFixture = process.env[SERIAL_FIXTURE_ENV];
const previousPython = process.env[PYTHON_OVERRIDE];

afterEach(() => {
	resetSerialHub();
	if (previousFixture === undefined) delete process.env[SERIAL_FIXTURE_ENV];
	else process.env[SERIAL_FIXTURE_ENV] = previousFixture;
	if (previousPython === undefined) delete process.env[PYTHON_OVERRIDE];
	else process.env[PYTHON_OVERRIDE] = previousPython;
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
		expect(ports.every(port => port.backend === "fixture" || port.backend === "uart")).toBe(true);

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
		expect(host.content[0].text.includes("not in this cut")).toBe(false);
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
