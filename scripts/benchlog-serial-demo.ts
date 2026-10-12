/**
 * Fixture demo for BenchLog UART tools. No board and no model required.
 *
 *   bun scripts/benchlog-serial-demo.ts --fixture
 *
 * `--fixture` sets BENCHLOG_SERIAL_FIXTURE=1, which is what `omp --fixture`
 * does before a session starts. The script then lists, opens, reads, and
 * writes the shipped boot log, and prints omp's approval decision for
 * serial_write under always-ask, write, and yolo.
 */
import * as zod from "@oh-my-pi/omptype/zod";
import { requiresApproval } from "../packages/coding-agent/src/tools/approval.ts";
import { FIXTURE_PORT_ID, SERIAL_FIXTURE_ENV, resetSerialHub } from "../.omp/tools/serial/backend.ts";
import factory from "../.omp/tools/serial/index.ts";

const fixtureFlag = process.argv.includes("--fixture");
if (fixtureFlag || process.env[SERIAL_FIXTURE_ENV] === undefined) {
	process.env[SERIAL_FIXTURE_ENV] = "1";
}

resetSerialHub();
const tools = factory({ zod });
const byName = new Map(tools.map(tool => [tool.name, tool]));

async function call(name: string, params: Record<string, unknown> = {}): Promise<string> {
	const tool = byName.get(name);
	if (!tool) throw new Error(`missing tool ${name}`);
	const result = await tool.execute("demo", params);
	if (result.isError) throw new Error(result.content[0].text);
	return result.content[0].text;
}

const writeTool = byName.get("serial_write");
if (!writeTool) throw new Error("missing serial_write");
const writeArgs = { sessionId: "ser-1", data: "help\n" };

console.log(`BenchLog serial fixture demo (${FIXTURE_PORT_ID})`);
console.log(`${SERIAL_FIXTURE_ENV}=${process.env[SERIAL_FIXTURE_ENV]}`);
console.log("");
console.log(await call("serial_list"));
console.log("");
console.log(await call("serial_open"));
console.log("");
console.log(await call("serial_read", { sessionId: "ser-1", maxLines: 8 }));
console.log("");
console.log("serial_write approval (omp resolveApproval, tier exec):");
for (const mode of ["always-ask", "write", "yolo"] as const) {
	const decision = requiresApproval(writeTool, writeArgs, mode);
	console.log(`  ${mode}: ${decision.required ? "prompt" : "allow"}`);
}
console.log("");
console.log(await call("serial_write", writeArgs));
console.log("");
console.log(await call("serial_read", { sessionId: "ser-1", maxLines: 200 }));
