/**
 * BenchLog UART tools. Discovered from `.omp/tools/serial/` when omp's cwd is
 * this repo. Parameters are JSON Schema via the host zod builder. Approval
 * tiers are declared here and resolved by omp's `resolveApproval`; this module
 * does not prompt on its own.
 */
import {
	type OpenedSession,
	type ReadChunk,
	type SerialResult,
	type WriteAck,
	getSerialHub,
	resetSerialHub,
} from "./backend.ts";

/** Minimal slice of the host schema builder (`pi.zod` / `omp.zod`). */
interface Schema {
	describe(text: string): Schema;
	optional(): Schema;
}
interface SchemaBuilder {
	object(shape: Record<string, Schema>): Schema;
	string(): Schema;
	boolean(): Schema;
	number(): Schema;
}
interface ToolHost {
	zod: SchemaBuilder;
}

interface SerialTool {
	name: string;
	label: string;
	description: string;
	parameters: Schema;
	approval: "read" | "exec";
	loadMode: "essential";
	strict: true;
	formatApprovalDetails?: (args: unknown) => string[];
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
	): Promise<{ content: [{ type: "text"; text: string }]; details: unknown; isError?: boolean }>;
	onSession?: (event: { reason?: string }) => void;
}

export const SERIAL_TOOL_APPROVAL = {
	serial_list: "read",
	serial_open: "read",
	serial_read: "read",
	serial_write: "exec",
} as const;

function textResult(text: string, details: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(isError ? { isError: true } : {}),
	};
}

function fail<T>(result: SerialResult<T>) {
	return textResult(result.ok ? "" : result.error, { error: result.ok ? undefined : result.error }, true);
}

function formatOpen(value: OpenedSession): string {
	return `session ${value.sessionId} port ${value.port} backend ${value.backend} lines ${value.lineCount}`;
}

function formatRead(value: ReadChunk): string {
	const body = value.text.length > 0 ? value.text : "(no new lines)";
	return `session ${value.sessionId} port ${value.port} offset ${value.offset} eof ${value.eof}\n${body}`;
}

function formatWrite(value: WriteAck): string {
	return `session ${value.sessionId} port ${value.port} wrote ${value.bytes} bytes\necho: ${value.echoed}`;
}

function stringField(args: unknown, key: string): string {
	if (!args || typeof args !== "object" || !(key in args)) return "";
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : "";
}

const factory = (omp: ToolHost): SerialTool[] => {
	const z = omp.zod;
	const hub = () => getSerialHub();

	const list: SerialTool = {
		name: "serial_list",
		label: "Serial list",
		description:
			"List BenchLog serial ports. This cut always includes fixture://firmware-boot, a sample firmware boot log. Real host serial devices are not enumerated.",
		parameters: z.object({}),
		approval: SERIAL_TOOL_APPROVAL.serial_list,
		loadMode: "essential",
		strict: true,
		async execute() {
			const listed = hub().list();
			const lines = listed.ports.map(port => `${port.id}  ${port.backend}  ${port.description}`);
			lines.push(`fixture default: ${listed.fixtureDefault ? "on" : "off"}`);
			lines.push("real serial ports: not enumerated in this cut");
			return textResult(lines.join("\n"), listed);
		},
	};

	const open: SerialTool = {
		name: "serial_open",
		label: "Serial open",
		description:
			"Open a BenchLog serial capture. Read-class: omp auto-approves this tier. Omit port when --fixture or BENCHLOG_SERIAL_FIXTURE=1 is set to open fixture://firmware-boot. A fixture:// port opens the sample log without that flag. Real device paths are refused. serial_flash and serial_reset are not implemented.",
		parameters: z.object({
			port: z.string().optional().describe("Port id. Use fixture://firmware-boot for the shipped boot log."),
			fixture: z.boolean().optional().describe("When true and port is omitted, open the fixture boot log."),
		}),
		approval: SERIAL_TOOL_APPROVAL.serial_open,
		loadMode: "essential",
		strict: true,
		async execute(_toolCallId, params) {
			const port = typeof params.port === "string" ? params.port : undefined;
			const fixture = typeof params.fixture === "boolean" ? params.fixture : undefined;
			const opened = hub().open({ port, fixture });
			if (!opened.ok) return fail(opened);
			return textResult(formatOpen(opened.value), opened.value);
		},
		onSession(event) {
			if (event.reason === "shutdown") resetSerialHub();
		},
	};

	const read: SerialTool = {
		name: "serial_read",
		label: "Serial read",
		description:
			"Read the next lines from an open BenchLog serial session. Read-class: omp auto-approves this tier. Defaults to 20 lines. Does not write to the port.",
		parameters: z.object({
			sessionId: z.string().describe("Session id returned by serial_open."),
			maxLines: z.number().optional().describe("Maximum lines to return (1-200, default 20)."),
		}),
		approval: SERIAL_TOOL_APPROVAL.serial_read,
		loadMode: "essential",
		strict: true,
		async execute(_toolCallId, params) {
			const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
			const maxLines = typeof params.maxLines === "number" ? params.maxLines : undefined;
			const chunk = hub().read({ sessionId, maxLines });
			if (!chunk.ok) return fail(chunk);
			return textResult(formatRead(chunk.value), chunk.value);
		},
	};

	const write: SerialTool = {
		name: "serial_write",
		label: "Serial write",
		description:
			"Write bytes to an open BenchLog serial session. Exec-class: omp prompts in always-ask and write approval modes, and auto-approves in yolo (the schema default). The fixture backend appends the payload and an ack to the capture; it does not flash or reset a board.",
		parameters: z.object({
			sessionId: z.string().describe("Session id returned by serial_open."),
			data: z.string().describe("Bytes to write. A trailing newline is optional."),
		}),
		approval: SERIAL_TOOL_APPROVAL.serial_write,
		loadMode: "essential",
		strict: true,
		formatApprovalDetails(args) {
			const data = stringField(args, "data");
			const preview = data.length > 120 ? `${data.slice(0, 120)}…` : data;
			return [`session: ${stringField(args, "sessionId")}`, `data: ${preview}`];
		},
		async execute(_toolCallId, params) {
			const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
			const data = typeof params.data === "string" ? params.data : undefined;
			const wrote = hub().write({ sessionId, data });
			if (!wrote.ok) return fail(wrote);
			return textResult(formatWrite(wrote.value), wrote.value);
		},
	};

	return [list, open, read, write];
};

export default factory;
