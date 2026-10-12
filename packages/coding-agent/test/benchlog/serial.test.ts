import { afterEach, describe, expect, it } from "bun:test";
import * as zod from "@oh-my-pi/omptype/zod";
import { parseArgs } from "../../src/cli/args";
import { formatApprovalPrompt, requiresApproval } from "../../src/tools/approval";
import { FIXTURE_PORT_ID, SERIAL_FIXTURE_ENV, resetSerialHub } from "../../../../.omp/tools/serial/backend.ts";
import factory from "../../../../.omp/tools/serial/index.ts";

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

afterEach(() => {
	resetSerialHub();
	if (previousFixture === undefined) delete process.env[SERIAL_FIXTURE_ENV];
	else process.env[SERIAL_FIXTURE_ENV] = previousFixture;
});

describe("serial fixture capture", () => {
	it("opens the shipped boot log and reads it in order", async () => {
		process.env[SERIAL_FIXTURE_ENV] = "1";
		const listed = await call("serial_list");
		expect(listed.isError).toBeUndefined();
		expect(listed.content[0].text).toContain(FIXTURE_PORT_ID);
		expect(listed.content[0].text).toContain("fixture default: on");

		const opened = await call("serial_open");
		expect(opened.isError).toBeUndefined();
		expect(opened.content[0].text).toContain("session ser-1");
		expect(opened.content[0].text).toContain(FIXTURE_PORT_ID);

		const first = await call("serial_read", { sessionId: "ser-1", maxLines: 2 });
		expect(first.content[0].text).toContain("BenchLog fixture UART console");
		expect(first.content[0].text).toContain("board: benchlog-fixture");
		expect(first.content[0].text).toContain("eof false");

		const second = await call("serial_read", { sessionId: "ser-1", maxLines: 1 });
		expect(second.content[0].text).toContain("reset cause: power-on");
		expect(second.content[0].text).not.toContain("BenchLog fixture UART console");
	});

	it("refuses a host device path and a missing fixture flag", async () => {
		delete process.env[SERIAL_FIXTURE_ENV];
		const missing = await call("serial_open");
		expect(missing.isError).toBe(true);
		expect(missing.content[0].text).toContain(FIXTURE_PORT_ID);

		const host = await call("serial_open", { port: "/dev/ttyUSB0" });
		expect(host.isError).toBe(true);
		expect(host.content[0].text).toContain("Real UART open is not in this cut");
		expect(host.content[0].text).toContain("serial_flash");
	});

	it("opens fixture:// without the env flag", async () => {
		delete process.env[SERIAL_FIXTURE_ENV];
		const opened = await call("serial_open", { port: FIXTURE_PORT_ID });
		expect(opened.isError).toBeUndefined();
		expect(opened.content[0].text).toContain("backend fixture");
	});
});

describe("serial_write gating", () => {
	it("appends an ack the next read can see", async () => {
		const opened = await call("serial_open", { port: "fixture" });
		expect(opened.isError).toBeUndefined();
		await call("serial_read", { sessionId: "ser-1", maxLines: 200 });
		const wrote = await call("serial_write", { sessionId: "ser-1", data: "help\n" });
		expect(wrote.isError).toBeUndefined();
		expect(wrote.content[0].text).toContain("echo: help");
		const follow = await call("serial_read", { sessionId: "ser-1", maxLines: 10 });
		expect(follow.content[0].text).toContain("[fixture] tx: help");
		expect(follow.content[0].text).toContain("[fixture] rx: ack");
		expect(follow.content[0].text).toContain("eof true");
	});

	it("does not write when the session was never opened", async () => {
		const wrote = await call("serial_write", { sessionId: "ser-missing", data: "help" });
		expect(wrote.isError).toBe(true);
		expect(wrote.content[0].text).toContain("serial_open");
	});

	it("prompts for exec writes outside yolo and never prompts for reads", () => {
		const writeArgs = { sessionId: "ser-1", data: "help\n" };
		expect(requiresApproval(tool("serial_write"), writeArgs, "always-ask").required).toBe(true);
		expect(requiresApproval(tool("serial_write"), writeArgs, "write").required).toBe(true);
		expect(requiresApproval(tool("serial_write"), writeArgs, "yolo").required).toBe(false);
		expect(requiresApproval(tool("serial_list"), {}, "always-ask").required).toBe(false);
		expect(requiresApproval(tool("serial_open"), { port: FIXTURE_PORT_ID }, "always-ask").required).toBe(false);
		expect(requiresApproval(tool("serial_read"), { sessionId: "ser-1" }, "write").required).toBe(false);
		expect(requiresApproval(tool("serial_read"), { sessionId: "ser-1" }, "yolo").required).toBe(false);
		expect(formatApprovalPrompt(tool("serial_write"), writeArgs)).toContain("data: help");
	});
});

describe("omp --fixture", () => {
	it("sets the boolean flag without consuming the next token", () => {
		const result = parseArgs(["--fixture", "read the boot log"]);
		expect(result.fixture).toBe(true);
		expect(result.messages).toEqual(["read the boot log"]);
		expect(result.unrecognizedFlags).not.toContain("--fixture");
	});
});
