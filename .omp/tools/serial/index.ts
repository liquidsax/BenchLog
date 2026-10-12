/**
 * BenchLog UART tools. Discovered from `.omp/tools/serial/` when omp's cwd is
 * this repo. Parameters are JSON Schema via the host zod builder. Approval
 * tiers are declared here and resolved by omp's `resolveApproval`; this module
 * does not prompt on its own.
 *
 * Host UART needs Python 3 and pyserial
 * (`python3 -m pip install -r .omp/tools/serial/requirements.txt`).
 * The fixture port does not.
 */
import {
	type OpenedSession,
	type ProbeReport,
	type ReadChunk,
	type SerialResult,
	type WriteAck,
	envRequestsFixture,
	getSerialHub,
	isFixturePort,
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

type ApprovalTier = "read" | "exec";

interface SerialTool {
	name: string;
	label: string;
	description: string;
	parameters: Schema;
	approval: ApprovalTier | ((args: unknown) => ApprovalTier);
	loadMode: "essential";
	strict: true;
	formatApprovalDetails?: (args: unknown) => string[];
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
	): Promise<{ content: [{ type: "text"; text: string }]; details: unknown; isError?: boolean }>;
	onSession?: (event: { reason?: string }) => void;
}

/**
 * Fixture-only probes stay read-tier. Anything that can open a host UART is
 * exec. An unknown sessionId fails closed to exec.
 */
export function serialProbeApproval(args: unknown): ApprovalTier {
	const sessionId = stringField(args, "sessionId").trim();
	const port = stringField(args, "port").trim();
	if (sessionId !== "") {
		const backend = getSerialHub().sessionBackend(sessionId);
		return backend === "fixture" ? "read" : "exec";
	}
	if (port !== "" && isFixturePort(port)) return "read";
	if (port === "" && envRequestsFixture()) return "read";
	return "exec";
}

export const SERIAL_TOOL_APPROVAL = {
	serial_list: "read",
	serial_open: "read",
	serial_read: "read",
	serial_write: "exec",
	serial_probe: serialProbeApproval,
} as const;

function textResult(text: string, details: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(isError ? { isError: true } : {}),
	};
}

function fail<T>(result: Extract<SerialResult<T>, { ok: false }>) {
	return textResult(result.error, result.details ?? { error: result.error }, true);
}

function formatOpen(value: OpenedSession): string {
	const parts = [`session ${value.sessionId}`, `port ${value.port}`, `backend ${value.backend}`];
	if (value.baud !== undefined) parts.push(`baud ${value.baud}`);
	if (value.lineCount !== undefined) parts.push(`lines ${value.lineCount}`);
	return parts.join(" ");
}

function formatRead(value: ReadChunk): string {
	const body = value.text.length > 0 ? value.text : "(no new lines)";
	return `session ${value.sessionId} port ${value.port} backend ${value.backend} offset ${value.offset} eof ${value.eof}\n${body}`;
}

function formatWrite(value: WriteAck): string {
	const head = `session ${value.sessionId} port ${value.port} backend ${value.backend} wrote ${value.bytes} bytes`;
	return value.echoed !== undefined ? `${head}\necho: ${value.echoed}` : head;
}

function formatProbe(value: ProbeReport): string {
	return JSON.stringify(value, null, 2);
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
			"List BenchLog serial ports. Always includes fixture://firmware-boot, the shipped firmware boot log. Also lists host UART devices when Python 3 and pyserial can enumerate them (COM ports, /dev/ttyACM*, /dev/ttyUSB*, cu.*). The fixture port is listed even if Python or pyserial is missing. Install with: python3 -m pip install -r .omp/tools/serial/requirements.txt",
		parameters: z.object({}),
		approval: SERIAL_TOOL_APPROVAL.serial_list,
		loadMode: "essential",
		strict: true,
		async execute() {
			const listed = await hub().list();
			const lines = listed.ports.map(port => `${port.id}  ${port.backend}  ${port.description}`);
			lines.push(`fixture default: ${listed.fixtureDefault ? "on" : "off"}`);
			if (listed.uartError) lines.push(`uart enumeration: ${listed.uartError}`);
			else if (listed.skipped && listed.skipped > 0) {
				lines.push(
					`hid ${listed.skipped} host ports with no USB serial identity; pass the path to serial_open if you need one`,
				);
			}
			return textResult(lines.join("\n"), listed);
		},
	};

	const open: SerialTool = {
		name: "serial_open",
		label: "Serial open",
		description:
			"Open a BenchLog serial capture. Read-class: omp auto-approves this tier. Omit port when --fixture or BENCHLOG_SERIAL_FIXTURE=1 is set to open fixture://firmware-boot. A fixture:// port opens the sample log without that flag. A host path such as /dev/ttyACM0 or COM3 opens a UART through pyserial at baud (default 115200, 8N1). Requires Python 3 and pyserial for host ports. serial_flash and serial_reset are not implemented.",
		parameters: z.object({
			port: z
				.string()
				.optional()
				.describe("fixture://firmware-boot, or a host UART path such as /dev/ttyACM0 or COM3."),
			fixture: z.boolean().optional().describe("When true and port is omitted, open the fixture boot log."),
			baud: z.number().optional().describe("Baud for a host UART. Default 115200. Ignored for fixture:// ports."),
		}),
		approval: SERIAL_TOOL_APPROVAL.serial_open,
		loadMode: "essential",
		strict: true,
		async execute(_toolCallId, params) {
			const port = typeof params.port === "string" ? params.port : undefined;
			const fixture = typeof params.fixture === "boolean" ? params.fixture : undefined;
			const baud = typeof params.baud === "number" ? params.baud : undefined;
			const opened = await hub().open({ port, fixture, baud });
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
			"Read the next lines from an open BenchLog serial session. Read-class: omp auto-approves this tier. Defaults to 20 lines. Works for the fixture log and for a host UART opened with pyserial. A quiet UART returns no new lines. Does not write to the port.",
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
			const chunk = await hub().read({ sessionId, maxLines });
			if (!chunk.ok) return fail(chunk);
			return textResult(formatRead(chunk.value), chunk.value);
		},
	};

	const write: SerialTool = {
		name: "serial_write",
		label: "Serial write",
		description:
			"Write bytes to an open BenchLog serial session. Exec-class: omp prompts in always-ask and write approval modes, and auto-approves in yolo (the schema default). The fixture backend appends the payload and an ack to the capture. A host UART write sends the bytes through pyserial. It does not flash or reset a board.",
		parameters: z.object({
			sessionId: z.string().describe("Session id returned by serial_open."),
			data: z.string().describe("Bytes to write. A trailing newline is optional and is not added for you."),
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
			const wrote = await hub().write({ sessionId, data });
			if (!wrote.ok) return fail(wrote);
			return textResult(formatWrite(wrote.value), wrote.value);
		},
	};

	const probe: SerialTool = {
		name: "serial_probe",
		label: "Serial probe",
		description:
			"Inspect a BenchLog port after serial_open, or by port path. Returns USB description, manufacturer, VID/PID, and serial number when the host provides them, plus explicit unknowns, a baud hint, and a short sniff classified as AT, ASCII boot, ASCII, mixed, or binary. Fixture sessions and fixture:// ports are read-class. A host UART probe is exec-class because it touches hardware. Python 3 and pyserial are required for host ports. RTT, SWD, OpenOCD, flash, and reset are not part of this tool.",
		parameters: z.object({
			sessionId: z.string().optional().describe("Open session from serial_open. Preferred when already connected."),
			port: z
				.string()
				.optional()
				.describe("fixture://firmware-boot or a host UART path. Used when sessionId is omitted."),
			baud: z
				.number()
				.optional()
				.describe("Baud when probing a host path that is not already open. Default 115200."),
		}),
		approval: SERIAL_TOOL_APPROVAL.serial_probe,
		loadMode: "essential",
		strict: true,
		formatApprovalDetails(args) {
			const sessionId = stringField(args, "sessionId");
			const port = stringField(args, "port");
			return [`session: ${sessionId || "(none)"}`, `port: ${port || "(session or fixture default)"}`];
		},
		async execute(_toolCallId, params) {
			const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
			const port = typeof params.port === "string" ? params.port : undefined;
			const baud = typeof params.baud === "number" ? params.baud : undefined;
			const probed = await hub().probe({ sessionId, port, baud });
			if (!probed.ok) return fail(probed);
			return textResult(formatProbe(probed.value), probed.value);
		},
	};

	return [list, open, read, write, probe];
};

export default factory;
