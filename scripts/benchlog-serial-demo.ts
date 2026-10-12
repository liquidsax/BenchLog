/**
 * BenchLog UART demo.
 *
 * Fixture, no board and no model:
 *
 *   bun scripts/benchlog-serial-demo.ts --fixture
 *
 * Host UART (Python 3 + pyserial). Does not write to the port:
 *
 *   python3 -m pip install -r .omp/tools/serial/requirements.txt
 *   bun scripts/benchlog-serial-demo.ts --port /dev/ttyACM0
 *   bun scripts/benchlog-serial-demo.ts --port COM3 --baud 115200
 *
 * `--fixture` sets BENCHLOG_SERIAL_FIXTURE=1, which is what `omp --fixture`
 * does before a session starts. The fixture run lists, opens, probes, reads,
 * and writes the shipped boot log, and prints omp's approval decision for
 * serial_write and serial_probe.
 */
import * as zod from "@oh-my-pi/omptype/zod";
import { requiresApproval } from "../packages/coding-agent/src/tools/approval.ts";
import { FIXTURE_PORT_ID, SERIAL_FIXTURE_ENV, resetSerialHub } from "../.omp/tools/serial/backend.ts";
import factory from "../.omp/tools/serial/index.ts";

function flagValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	if (index < 0) return undefined;
	const value = process.argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
	return value;
}

const fixtureFlag = process.argv.includes("--fixture");
const hostPort = flagValue("--port");
const baudArg = flagValue("--baud");
const baud = baudArg === undefined ? undefined : Number(baudArg);
if (baudArg !== undefined && (!Number.isInteger(baud) || baud < 50)) {
	throw new Error("--baud must be an integer >= 50");
}

if (hostPort) {
	delete process.env[SERIAL_FIXTURE_ENV];
} else if (fixtureFlag || process.env[SERIAL_FIXTURE_ENV] === undefined) {
	process.env[SERIAL_FIXTURE_ENV] = "1";
}

resetSerialHub();
const tools = factory({ zod });
const byName = new Map(tools.map(tool => [tool.name, tool]));

async function call(name: string, params: Record<string, unknown> = {}): Promise<{ text: string; details: unknown }> {
	const tool = byName.get(name);
	if (!tool) throw new Error(`missing tool ${name}`);
	const result = await tool.execute("demo", params);
	if (result.isError) throw new Error(result.content[0].text);
	return { text: result.content[0].text, details: result.details };
}

function sessionIdOf(details: unknown): string {
	if (!details || typeof details !== "object" || !("sessionId" in details)) {
		throw new Error("serial_open did not return a sessionId");
	}
	const sessionId = (details as { sessionId?: unknown }).sessionId;
	if (typeof sessionId !== "string" || sessionId === "") throw new Error("serial_open sessionId was empty");
	return sessionId;
}

const writeTool = byName.get("serial_write");
const probeTool = byName.get("serial_probe");
if (!writeTool || !probeTool) throw new Error("missing serial tools");

if (hostPort) {
	console.log(`BenchLog serial host demo (${hostPort})`);
	console.log("Python 3 + pyserial required. This demo does not write to the port.");
	console.log("");
	console.log((await call("serial_list")).text);
	console.log("");
	const opened = await call("serial_open", { port: hostPort, ...(baud !== undefined ? { baud } : {}) });
	console.log(opened.text);
	const sessionId = sessionIdOf(opened.details);
	console.log("");
	console.log(await (await call("serial_probe", { sessionId })).text);
	console.log("");
	console.log((await call("serial_read", { sessionId, maxLines: 20 })).text);
} else {
	const writeArgs = { sessionId: "ser-1", data: "help\n" };
	console.log(`BenchLog serial fixture demo (${FIXTURE_PORT_ID})`);
	console.log(`${SERIAL_FIXTURE_ENV}=${process.env[SERIAL_FIXTURE_ENV]}`);
	console.log("");
	console.log((await call("serial_list")).text);
	console.log("");
	console.log((await call("serial_open")).text);
	console.log("");
	console.log((await call("serial_probe", { sessionId: "ser-1" })).text);
	console.log("");
	console.log((await call("serial_read", { sessionId: "ser-1", maxLines: 8 })).text);
	console.log("");
	console.log("approval (omp resolveApproval):");
	for (const mode of ["always-ask", "write", "yolo"] as const) {
		const writeDecision = requiresApproval(writeTool, writeArgs, mode);
		const probeFixture = requiresApproval(probeTool, { port: FIXTURE_PORT_ID }, mode);
		const probeHost = requiresApproval(probeTool, { port: hostPort ?? "/dev/ttyACM0" }, mode);
		console.log(
			`  ${mode}: write ${writeDecision.required ? "prompt" : "allow"}, probe fixture ${probeFixture.required ? "prompt" : "allow"}, probe host ${probeHost.required ? "prompt" : "allow"}`,
		);
	}
	console.log("");
	console.log((await call("serial_write", writeArgs)).text);
	console.log("");
	console.log((await call("serial_read", { sessionId: "ser-1", maxLines: 200 })).text);
}

console.log("");
console.log("Real UART, when a port exists:");
console.log("  python3 -m pip install -r .omp/tools/serial/requirements.txt");
console.log("  bun scripts/benchlog-serial-demo.ts --port /dev/ttyACM0");
console.log("serial_list then shows that port with backend uart. ST-LINK without a virtual COM port will not appear.");
console.log("RTT, SWD, OpenOCD, flash, and reset are not in this cut.");
resetSerialHub();
